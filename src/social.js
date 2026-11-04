import { randomUUID, createHmac } from 'node:crypto';
import { z } from 'zod';
import { AppError, now } from './db.js';
import { seal, unseal, equal, hash, token } from './crypto.js';
import {teamRole} from './team-roles.js';
import { MetaProvider, TelegramProvider } from './social-provider.js';

const channelSchema = z.enum(['whatsapp', 'instagram']);
const numericId = z.string().regex(/^\d{5,40}$/);
const stages = ['new', 'qualified', 'offer', 'awaiting_payment', 'won', 'lost'];
const idem = z.string().min(8).max(150).regex(/^[a-zA-Z0-9_.:-]+$/);
const publicConnection = c => ({ id:c.id, channel:c.channel, external_id:c.external_id, label:c.label, state:c.state, last_error:c.last_error, verified_at:c.verified_at, subscribed:!!c.subscribed, last_webhook_at:c.last_webhook_at, expires_at:c.expires_at });
export function registerSocial(app, { store, config, member, admin, provider = new MetaProvider(), telegram = new TelegramProvider(), background = true }) {
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_embedded_config(channel TEXT PRIMARY KEY, config_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS social_platform(channel TEXT PRIMARY KEY, app_id TEXT NOT NULL, secret TEXT NOT NULL, verify_hash TEXT NOT NULL, verify_secret TEXT NOT NULL, version TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS social_connections(id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id), channel TEXT NOT NULL, external_id TEXT NOT NULL, label TEXT NOT NULL, secret TEXT NOT NULL, state TEXT NOT NULL, last_error TEXT, verified_at INTEGER, subscribed INTEGER NOT NULL DEFAULT 0, last_webhook_at INTEGER, expires_at INTEGER, UNIQUE(channel,external_id));
    CREATE TABLE IF NOT EXISTS social_oauth(hash TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id), actor_id TEXT NOT NULL, cookie_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS crm_contacts(id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id), name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS social_threads(id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id), connection_id TEXT NOT NULL REFERENCES social_connections(id), contact_id TEXT NOT NULL REFERENCES crm_contacts(id), external_id TEXT NOT NULL, last_inbound_at INTEGER, opted_out INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, UNIQUE(connection_id,external_id));
    CREATE TABLE IF NOT EXISTS social_messages(id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id), thread_id TEXT NOT NULL REFERENCES social_threads(id), direction TEXT NOT NULL, provider_id TEXT, body TEXT NOT NULL, state TEXT NOT NULL, idem TEXT, actor_id TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(thread_id,provider_id), UNIQUE(merchant_id,idem));
    CREATE TABLE IF NOT EXISTS crm_deals(id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id), contact_id TEXT NOT NULL REFERENCES crm_contacts(id), title TEXT NOT NULL, stage TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0, assignee TEXT, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS crm_tasks(id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id), deal_id TEXT REFERENCES crm_deals(id), title TEXT NOT NULL, due_at INTEGER NOT NULL, assignee TEXT, done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS social_queue ON social_messages(state,created_at);
    CREATE INDEX IF NOT EXISTS social_inbox ON social_threads(merchant_id,updated_at);
    CREATE INDEX IF NOT EXISTS crm_company ON crm_deals(merchant_id,stage);
  `);
  const permission = name => async req => { await member(req); if (!req.member.is_owner && !req.member.permissions.includes(name)) throw new AppError('PERMISSION_DENIED','Недостаточно прав.',403); };
  const owner = async req => { await member(req); if (!req.member.is_owner) throw new AppError('PERMISSION_DENIED','Подключать аккаунты может владелец компании.',403); };
  const platform = channel => { const p=db.prepare('SELECT * FROM social_platform WHERE channel=?').get(channel);return p?{...p,app_secret:unseal(p.secret,config.key,`social-platform:${channel}`),verify_token:unseal(p.verify_secret,config.key,`social-verify:${channel}`)}:null; };
  const needPlatform = channel => { const p=platform(channel);if(!p)throw new AppError('META_PLATFORM_NOT_CONFIGURED','Оператору MBusiness нужно настроить приложение Meta. Инструкция доступна в разделе подключения.',409);return p; };
  const connection = (merchantId,id) => {const c=db.prepare('SELECT * FROM social_connections WHERE merchant_id=? AND id=?').get(merchantId,id);if(!c)throw new AppError('NOT_FOUND','Подключение не найдено.',404);return c;};
  const secretFor = c => unseal(c.secret,config.key,`social:${c.merchant_id}:${c.channel}:${c.external_id}`);
  const callback = channel => `${config.baseUrl}/webhooks/meta/${channel}`;
  const oauthCallback = `${config.baseUrl}/social/instagram/callback`;
  const audit = (req,action,detail) => store.audit(req.company.id,null,action,JSON.stringify({actor:req.member.id,...detail}));
  function assignee(merchantId,id) {
    if (!id) return null;
    if (db.prepare('SELECT 1 FROM business_users WHERE merchant_id=? AND id=?').get(merchantId,id) || db.prepare('SELECT 1 FROM business_staff WHERE merchant_id=? AND id=? AND active=1').get(merchantId,id)) return id;
    throw new AppError('INVALID_ASSIGNEE','Выберите действующего сотрудника этой компании.',400);
  }
  app.put('/admin/social/embedded',{preHandler:admin},async req=>{const b=z.object({config_id:numericId}).strict().parse(req.body);db.prepare("INSERT INTO social_embedded_config VALUES('whatsapp',?) ON CONFLICT(channel) DO UPDATE SET config_id=excluded.config_id").run(b.config_id);return {ok:true};});
  app.get('/admin/social/platform',{preHandler:admin},async()=>({channels:['whatsapp','instagram'].map(channel=>{const p=platform(channel);return {channel,config_id:channel==='whatsapp'?(db.prepare("SELECT config_id FROM social_embedded_config WHERE channel='whatsapp'").get()?.config_id||''):'',configured:!!p,app_id:p?.app_id||'',version:p?.version||'v26.0',callback:callback(channel),oauth_callback:oauthCallback,verify_token:p?.verify_token||''};})}));
  app.put('/admin/social/platform/:channel',{preHandler:admin},async req=>{
    const channel=channelSchema.parse(req.params.channel),b=z.object({app_id:numericId,app_secret:z.string().min(16).max(300),version:z.string().regex(/^v[2-9]\d\.0$/)}).strict().parse(req.body),old=platform(channel);
    if(old&&old.app_id!==b.app_id&&db.prepare("SELECT 1 FROM social_connections WHERE channel=? AND state!='disconnected'").get(channel))throw new AppError('META_APP_IN_USE','Сначала отключите аккаунты прежнего приложения.',409);
    const verify=old?.verify_token||token('mbv_');
    db.prepare('INSERT INTO social_platform VALUES(?,?,?,?,?,?,?) ON CONFLICT(channel) DO UPDATE SET app_id=excluded.app_id,secret=excluded.secret,version=excluded.version,updated_at=excluded.updated_at').run(channel,b.app_id,seal(b.app_secret,config.key,`social-platform:${channel}`),hash(verify),seal(verify,config.key,`social-verify:${channel}`),b.version,now());
    return {ok:true,callback:callback(channel),verify_token:verify,oauth_callback:oauthCallback};
  });
  app.get('/account/social',{preHandler:permission('crm.read')},async req=>({connections:db.prepare('SELECT * FROM social_connections WHERE merchant_id=? ORDER BY channel,label').all(req.company.id).map(publicConnection),platform:['whatsapp','instagram'].map(channel=>({channel,configured:!!platform(channel),callback:callback(channel)})),whatsapp_embedded_ready:!!platform('whatsapp')&&!!db.prepare("SELECT 1 FROM social_embedded_config WHERE channel='whatsapp'").get(),can_configure:req.member.is_owner,can_send:req.member.is_owner||req.member.permissions.includes('messages.send'),guide:'/help/social'}));
  const connecting=new Set();
  async function connect(req,channel,b) {
    const lock=channel+':'+b.external_id;if(connecting.has(lock))throw new AppError('BUSY','Подключение уже проверяется. Дождитесь результата.',409);connecting.add(lock);
    try{
    const p=needPlatform(channel),prior=db.prepare('SELECT * FROM social_connections WHERE channel=? AND external_id=?').get(channel,b.external_id);
    if(prior&&prior.merchant_id!==req.company.id)throw new AppError('META_ACCOUNT_IN_USE','Этот аккаунт уже привязан к другой компании.',409);
    const profile=await provider.verify(channel,b,p);
    // Store a recoverable configuration before the subscription write; if the write is lost,
    // incoming signed events can still be attributed, while the UI reports pending verification.
    const id=prior?.id||randomUUID();
    store.transaction(()=>{const collision=db.prepare('SELECT merchant_id FROM social_connections WHERE channel=? AND external_id=?').get(channel,b.external_id);if(collision&&collision.merchant_id!==req.company.id)throw new AppError('META_ACCOUNT_IN_USE','Аккаунт уже подключён.',409);
      db.prepare(`INSERT INTO social_connections(id,merchant_id,channel,external_id,label,secret,state,verified_at,expires_at) VALUES(?,?,?,?,?,?,'verified',?,?) ON CONFLICT(channel,external_id) DO UPDATE SET label=excluded.label,secret=excluded.secret,state='verified',last_error=NULL,verified_at=excluded.verified_at,expires_at=excluded.expires_at,subscribed=0`).run(id,req.company.id,channel,b.external_id,profile.label,seal(b,config.key,`social:${req.company.id}:${channel}:${b.external_id}`),now(),b.expires_at||profile.expires_at||null);
    });
    try {await provider.subscribe(channel,b,p);db.prepare("UPDATE social_connections SET state='connected',subscribed=1 WHERE id=?").run(id);}
    catch(e){db.prepare("UPDATE social_connections SET last_error=? WHERE id=?").run(e.code||'META_SUBSCRIPTION_FAILED',id);}
    audit(req,'social.connected',{connection:id,channel});return publicConnection(connection(req.company.id,id));
    }finally{connecting.delete(lock);}
  }
  app.post('/account/social/:channel/connect',{preHandler:owner,config:{rateLimit:{max:6,timeWindow:'1 minute'}}},async req=>{
    const channel=channelSchema.parse(req.params.channel),b=z.object({external_id:numericId,access_token:z.string().min(20).max(8192),waba_id:numericId.optional()}).strict().parse(req.body);
    if(channel==='whatsapp'&&!b.waba_id)throw new AppError('WABA_REQUIRED','Укажите WhatsApp Business Account ID.',400);
    return connect(req,channel,b);
  });
  app.post('/account/social/:id/verify',{preHandler:owner},async req=>{const c=connection(req.company.id,req.params.id);if(c.state==='disconnected')throw new AppError('META_DISCONNECTED','Подключите аккаунт заново.',409);try {const s=secretFor(c);if(c.channel==='telegram'){const me=await telegram.request(s.bot_token,'getMe');if(String(me.id)!==c.external_id)throw new AppError('META_ID_MISMATCH','Токен принадлежит другому боту.',409);await telegram.request(s.bot_token,'setWebhook',{url:`${config.baseUrl}/webhooks/telegram/${c.id}`,secret_token:s.webhook_secret,allowed_updates:['message']});}else{const p=needPlatform(c.channel);await provider.verify(c.channel,s,p);await provider.subscribe(c.channel,s,p);}db.prepare("UPDATE social_connections SET state='connected',subscribed=1,last_error=NULL,verified_at=? WHERE id=?").run(now(),c.id);}catch(e){db.prepare("UPDATE social_connections SET state='error',last_error=? WHERE id=?").run(e.code||'META_VERIFY_FAILED',c.id);throw e;}return publicConnection(connection(req.company.id,c.id));});
  app.post('/account/social/:id/register-phone',{preHandler:owner,config:{rateLimit:{max:3,timeWindow:'1 minute'}}},async req=>{const b=z.object({pin:z.string().regex(/^\d{6}$/)}).strict().parse(req.body),c=connection(req.company.id,req.params.id);if(c.channel!=='whatsapp'||c.state==='disconnected')throw new AppError('META_NOT_CONNECTED','Сначала подключите WhatsApp.',409);const p=needPlatform('whatsapp');const result=await provider.request('whatsapp',p.version,`${c.external_id}/register`,secretFor(c).access_token,{method:'POST',body:{messaging_product:'whatsapp',pin:b.pin}});if(result.success!==true)throw new AppError('META_REGISTER_FAILED','Meta не подтвердила регистрацию номера.',409);audit(req,'social.phone_registered',{connection:c.id});return {ok:true};});
  app.delete('/account/social/:id',{preHandler:owner},async req=>{const c=connection(req.company.id,req.params.id);store.transaction(()=>{db.prepare("UPDATE social_connections SET state='disconnected',secret='',subscribed=0 WHERE id=?").run(c.id);db.prepare("UPDATE social_messages SET state='failed',error='META_DISCONNECTED',updated_at=? WHERE state='queued' AND thread_id IN (SELECT id FROM social_threads WHERE connection_id=?)").run(now(),c.id);audit(req,'social.disconnected',{connection:c.id});});return {ok:true};});
  app.post('/account/social/whatsapp/oauth',{preHandler:owner},async req=>{const p=needPlatform('whatsapp'),embedded=db.prepare("SELECT config_id FROM social_embedded_config WHERE channel='whatsapp'").get();if(!embedded)throw new AppError('META_EMBEDDED_NOT_CONFIGURED','Оператору нужно настроить WhatsApp Embedded Signup в приложении Meta.',409);const state=token();db.prepare('DELETE FROM social_oauth WHERE expires_at<?').run(now());db.prepare('INSERT INTO social_oauth VALUES(?,?,?,?,?)').run(hash(state),req.company.id,req.member.id,hash(req.cookies.mb_session),now()+10*60000);return {app_id:p.app_id,version:p.version,config_id:embedded.config_id,state};});
  app.post('/account/social/whatsapp/exchange',{preHandler:owner},async req=>{const b=z.object({code:z.string().min(1).max(2000),state:z.string().max(200),waba_id:numericId,external_id:numericId}).strict().parse(req.body),s=db.prepare('SELECT * FROM social_oauth WHERE hash=?').get(hash(b.state));if(!s||s.expires_at<now()||s.actor_id!==req.member.id||s.merchant_id!==req.company.id||s.cookie_hash!==hash(req.cookies.mb_session))throw new AppError('OAUTH_STATE_INVALID','Сессия подключения истекла. Начните заново.',400);db.prepare('DELETE FROM social_oauth WHERE hash=?').run(hash(b.state));const access_token=await provider.facebookCode(b.code,needPlatform('whatsapp'));return connect(req,'whatsapp',{access_token,waba_id:b.waba_id,external_id:b.external_id});});
  app.post('/account/social/instagram/oauth',{preHandler:owner},async req=>{const p=needPlatform('instagram'),state=token();db.prepare('DELETE FROM social_oauth WHERE expires_at<?').run(now());db.prepare('INSERT INTO social_oauth VALUES(?,?,?,?,?)').run(hash(state),req.company.id,req.member.id,hash(req.cookies.mb_session),now()+10*60000);const url=new URL('https://www.instagram.com/oauth/authorize');url.search=new URLSearchParams({client_id:p.app_id,redirect_uri:oauthCallback,response_type:'code',scope:'instagram_business_basic,instagram_business_manage_messages',state,enable_fb_login:'0',force_authentication:'1'});return {url:url.href};});
  app.get('/social/instagram/callback',{preHandler:owner},async(req,reply)=>{
    const q=z.object({state:z.string().max(200),code:z.string().max(2000).optional(),error:z.string().max(200).optional()}).passthrough().parse(req.query),state=db.prepare('SELECT * FROM social_oauth WHERE hash=?').get(hash(q.state));
    if(!state||state.expires_at<now()||state.actor_id!==req.member.id||state.merchant_id!==req.company.id||state.cookie_hash!==hash(req.cookies.mb_session))throw new AppError('OAUTH_STATE_INVALID','Сессия подключения истекла. Вернитесь в кабинет и начните заново.',400);
    db.prepare('DELETE FROM social_oauth WHERE hash=?').run(hash(q.state));
    if(q.error||!q.code)return reply.redirect('/#social');
    const b=await provider.instagramCode(q.code,needPlatform('instagram'),oauthCallback);await connect(req,'instagram',b);return reply.redirect('/#social');
  });
  app.post('/account/social/telegram/connect',{preHandler:owner,config:{rateLimit:{max:6,timeWindow:'1 minute'}}},async req=>{
    const b=z.object({bot_token:z.string().regex(/^\d{5,20}:[a-zA-Z0-9_-]{20,100}$/)}).strict().parse(req.body),me=await telegram.request(b.bot_token,'getMe');if(!me.is_bot)throw new AppError('TELEGRAM_NOT_BOT','Нужен токен Telegram-бота от @BotFather.',409);
    const externalId=String(me.id),prior=db.prepare("SELECT * FROM social_connections WHERE channel='telegram' AND external_id=?").get(externalId);if(prior&&prior.merchant_id!==req.company.id)throw new AppError('META_ACCOUNT_IN_USE','Бот подключён к другой компании.',409);
    const id=prior?.id||randomUUID(),secret={bot_token:b.bot_token,webhook_secret:token('mbt_')},scope=`social:${req.company.id}:telegram:${externalId}`;
    db.prepare("INSERT INTO social_connections(id,merchant_id,channel,external_id,label,secret,state,verified_at) VALUES(?,?,'telegram',?,?,?,'verified',?) ON CONFLICT(channel,external_id) DO UPDATE SET label=excluded.label,secret=excluded.secret,state='verified',last_error=NULL,subscribed=0,verified_at=excluded.verified_at").run(id,req.company.id,externalId,'@'+me.username,seal(secret,config.key,scope),now());
    try{await telegram.request(b.bot_token,'setWebhook',{url:`${config.baseUrl}/webhooks/telegram/${id}`,secret_token:secret.webhook_secret,allowed_updates:['message'],drop_pending_updates:false});db.prepare("UPDATE social_connections SET state='connected',subscribed=1 WHERE id=?").run(id);}catch(e){db.prepare('UPDATE social_connections SET last_error=? WHERE id=?').run(e.code||'TELEGRAM_WEBHOOK_FAILED',id);}
    audit(req,'social.connected',{connection:id,channel:'telegram'});return publicConnection(connection(req.company.id,id));
  });
  function receive(c,externalId,messageId,text,timestamp,name) {
    if(typeof externalId!=='string'||!/^\d{5,40}$/.test(externalId)||typeof messageId!=='string'||!messageId||messageId.length>300)return;
    const time=Number(timestamp);if(!Number.isSafeInteger(time)||time<0||time>now()+300000)return;
    let thread=db.prepare('SELECT * FROM social_threads WHERE connection_id=? AND external_id=?').get(c.id,externalId);
    if(!thread){const contact=randomUUID(),id=randomUUID(),created=now();db.prepare('INSERT INTO crm_contacts(id,merchant_id,name,phone,created_at) VALUES(?,?,?,?,?)').run(contact,c.merchant_id,String(name||externalId).slice(0,150),c.channel==='whatsapp'?`+${externalId}`:'',created);db.prepare('INSERT INTO social_threads(id,merchant_id,connection_id,contact_id,external_id,updated_at) VALUES(?,?,?,?,?,?)').run(id,c.merchant_id,c.id,contact,externalId,created);db.prepare('INSERT INTO crm_deals(id,merchant_id,contact_id,title,stage,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),c.merchant_id,contact,`Обращение · ${c.channel}`,'new',created,created);thread=db.prepare('SELECT * FROM social_threads WHERE id=?').get(id);}
    const body=String(text||'[Вложение: откройте сообщение в приложении]').slice(0,8000),created=now();
    const inserted=db.prepare("INSERT OR IGNORE INTO social_messages(id,merchant_id,thread_id,direction,provider_id,body,state,created_at,updated_at) VALUES(?,?,?,'in',?,?,'received',?,?)").run(randomUUID(),c.merchant_id,thread.id,messageId,body,created,created);
    if(!inserted.changes)return;
    const stop=/(?:^|\s)(?:стоп|stop|отписаться|не\s+пишите|не\s+писать|перестаньте\s+писать|не\s+хочу\s+получать|удалите\s+мой\s+номер|do not contact|don't contact|unsubscribe)(?:[.!?,\s]|$)/iu.test(body.trim());
    db.prepare('UPDATE social_threads SET last_inbound_at=MAX(COALESCE(last_inbound_at,0),?),opted_out=CASE WHEN ? THEN 1 ELSE opted_out END,updated_at=? WHERE id=?').run(time,stop?1:0,created,thread.id);if(/^(возобновить сообщения|\/start|start)[.!\s]*$/iu.test(body.trim())&&thread.opted_out){db.prepare('UPDATE social_threads SET opted_out=0 WHERE id=?').run(thread.id);store.audit(c.merchant_id,null,'social.opted_in',JSON.stringify({thread:thread.id,message:messageId}));}
  }
  function delivered(c,providerId,status){
    const allowed=['sent','delivered','read','failed'];if(!allowed.includes(status))return;
    const m=db.prepare("SELECT m.* FROM social_messages m JOIN social_threads t ON t.id=m.thread_id WHERE t.connection_id=? AND m.direction='out' AND m.provider_id=?").get(c.id,providerId);if(!m)return;
    const rank={queued:0,sending:0,unknown:0,sent:1,delivered:2,read:3,failed:4};
    if((rank[m.state]||0)>=rank[status])return;
    db.prepare('UPDATE social_messages SET state=?,updated_at=? WHERE id=?').run(status,now(),m.id);
  }
  // Encapsulated raw parser preserves exact signature bytes; normal API JSON parser is unchanged.
  app.register(async hooks=>{
    hooks.removeContentTypeParser('application/json');
    hooks.addContentTypeParser('application/json',{parseAs:'buffer',bodyLimit:262144},(_req,body,done)=>done(null,body));
    hooks.get('/webhooks/meta/:channel',async(req,reply)=>{const p=needPlatform(channelSchema.parse(req.params.channel));if(req.query['hub.mode']!=='subscribe'||!equal(req.query['hub.verify_token']||'',p.verify_token)||typeof req.query['hub.challenge']!=='string')throw new AppError('WEBHOOK_REJECTED','Проверка webhook отклонена.',403);return reply.type('text/plain').send(req.query['hub.challenge'].slice(0,1000));});
    hooks.post('/webhooks/telegram/:id',{bodyLimit:262144},async req=>{const c=db.prepare("SELECT * FROM social_connections WHERE id=? AND channel='telegram' AND state!='disconnected'").get(req.params.id);if(!c||!equal(req.headers['x-telegram-bot-api-secret-token']||'',secretFor(c).webhook_secret))throw new AppError('WEBHOOK_SIGNATURE_INVALID','Неверная подпись Telegram.',403);let data;try{data=JSON.parse(req.body.toString('utf8'));}catch{throw new AppError('INVALID_WEBHOOK','Некорректный JSON.',400);}const m=data.message;if(m?.chat?.type==='private'&&!m.from?.is_bot)store.transaction(()=>{receive(c,String(m.chat.id),'telegram:'+String(m.message_id),m.text,Number(m.date)*1000,[m.from?.first_name,m.from?.last_name].filter(Boolean).join(' '));db.prepare('UPDATE social_connections SET last_webhook_at=? WHERE id=?').run(now(),c.id);});return {ok:true};});
    hooks.post('/webhooks/meta/:channel',{bodyLimit:262144},async req=>{
      const channel=channelSchema.parse(req.params.channel),p=needPlatform(channel),raw=req.body;
      if(!Buffer.isBuffer(raw))throw new AppError('INVALID_WEBHOOK','Ожидается JSON.',400);
      const expected='sha256='+createHmac('sha256',p.app_secret).update(raw).digest('hex');
      if(!equal(req.headers['x-hub-signature-256']||'',expected))throw new AppError('WEBHOOK_SIGNATURE_INVALID','Неверная подпись Meta.',403);
      let payload;try{payload=JSON.parse(raw.toString('utf8'));}catch{throw new AppError('INVALID_WEBHOOK','Некорректный JSON.',400);}
      if(!payload||!Array.isArray(payload.entry)||payload.entry.length>100)throw new AppError('INVALID_WEBHOOK','Некорректное событие Meta.',400);
      store.transaction(()=>{
        for(const entry of payload.entry){
          if(channel==='whatsapp'&&payload.object==='whatsapp_business_account')for(const change of entry.changes||[]){const v=change.value;if(change.field!=='messages'||!v?.metadata?.phone_number_id)continue;const c=db.prepare("SELECT * FROM social_connections WHERE channel='whatsapp' AND external_id=? AND state!='disconnected'").get(String(v.metadata.phone_number_id));if(!c||String(secretFor(c).waba_id)!==String(entry.id))continue;
            for(const m of v.messages||[])receive(c,m.from,m.id,m.text?.body||m.button?.text||m.interactive?.button_reply?.title,Number(m.timestamp)*1000,v.contacts?.find(x=>x.wa_id===m.from)?.profile?.name);
            for(const s of v.statuses||[])delivered(c,s.id,s.status);
            db.prepare('UPDATE social_connections SET last_webhook_at=? WHERE id=?').run(now(),c.id);
          }
          if(channel==='instagram'&&payload.object==='instagram'){const c=db.prepare("SELECT * FROM social_connections WHERE channel='instagram' AND external_id=? AND state!='disconnected'").get(String(entry.id));if(!c)continue;
            for(const m of entry.messaging||[]){if(m.message?.is_echo||String(m.sender?.id)===c.external_id)continue;if(m.message?.mid)receive(c,String(m.sender?.id),m.message.mid,m.message.text,Number(m.timestamp),'');if(m.read?.mid)delivered(c,m.read.mid,'read');}
            db.prepare('UPDATE social_connections SET last_webhook_at=? WHERE id=?').run(now(),c.id);
          }
        }
      });return {ok:true};
    });
  });
  app.get('/account/crm',{preHandler:permission('crm.read')},async req=>{const id=req.company.id;return {stages,contacts:db.prepare('SELECT * FROM crm_contacts WHERE merchant_id=? ORDER BY created_at DESC LIMIT 500').all(id),deals:db.prepare('SELECT * FROM crm_deals WHERE merchant_id=? ORDER BY updated_at DESC LIMIT 500').all(id),tasks:db.prepare('SELECT * FROM crm_tasks WHERE merchant_id=? ORDER BY done,due_at LIMIT 500').all(id),team:[...db.prepare('SELECT id,login AS name FROM business_users WHERE merchant_id=?').all(id),...db.prepare('SELECT id,name FROM business_staff WHERE merchant_id=? AND active=1').all(id)]};});
  app.post('/account/crm/contacts',{preHandler:permission('crm.write')},async req=>{const b=z.object({name:z.string().trim().min(1).max(150),phone:z.string().trim().max(40).default(''),email:z.union([z.email(),z.literal('')]).default(''),notes:z.string().max(4000).default('')}).strict().parse(req.body),id=randomUUID();db.prepare('INSERT INTO crm_contacts VALUES(?,?,?,?,?,?,?)').run(id,req.company.id,b.name,b.phone,b.email,b.notes,now());audit(req,'crm.contact_created',{id});return {id};});
  app.post('/account/crm/deals',{preHandler:permission('crm.write')},async req=>{const b=z.object({contact_id:z.uuid(),title:z.string().trim().min(1).max(200),amount:z.number().int().min(0).max(99999999999),assignee:z.uuid().nullable().default(null)}).strict().parse(req.body);if(!db.prepare('SELECT 1 FROM crm_contacts WHERE merchant_id=? AND id=?').get(req.company.id,b.contact_id))throw new AppError('NOT_FOUND','Клиент не найден.',404);const id=randomUUID(),time=now();db.prepare('INSERT INTO crm_deals(id,merchant_id,contact_id,title,stage,amount,assignee,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,req.company.id,b.contact_id,b.title,'new',b.amount,assignee(req.company.id,b.assignee),time,time);audit(req,'crm.deal_created',{id});return {id};});
  app.patch('/account/crm/deals/:id',{preHandler:permission('crm.write')},async req=>{const b=z.object({stage:z.enum(stages),assignee:z.uuid().nullable(),version:z.number().int().positive()}).strict().parse(req.body);const result=db.prepare('UPDATE crm_deals SET stage=?,assignee=?,version=version+1,updated_at=? WHERE merchant_id=? AND id=? AND version=?').run(b.stage,assignee(req.company.id,b.assignee),now(),req.company.id,req.params.id,b.version);if(!result.changes)throw new AppError('VERSION_CONFLICT','Сделка не найдена или изменена. Обновите список.',409);audit(req,'crm.deal_updated',{id:req.params.id,stage:b.stage});return {ok:true};});
  app.post('/account/crm/tasks',{preHandler:permission('crm.write')},async req=>{const b=z.object({title:z.string().trim().min(1).max(200),due_at:z.number().int().min(1).max(8640000000000000),deal_id:z.uuid().nullable().default(null),assignee:z.uuid().nullable().default(null)}).strict().parse(req.body);if(b.deal_id&&!db.prepare('SELECT 1 FROM crm_deals WHERE merchant_id=? AND id=?').get(req.company.id,b.deal_id))throw new AppError('NOT_FOUND','Сделка не найдена.',404);const id=randomUUID();db.prepare('INSERT INTO crm_tasks VALUES(?,?,?,?,?,?,0,?)').run(id,req.company.id,b.deal_id,b.title,b.due_at,assignee(req.company.id,b.assignee),now());return {id};});
  app.patch('/account/crm/tasks/:id',{preHandler:permission('crm.write')},async req=>{const b=z.object({done:z.boolean()}).strict().parse(req.body);if(!db.prepare('UPDATE crm_tasks SET done=? WHERE merchant_id=? AND id=?').run(b.done?1:0,req.company.id,req.params.id).changes)throw new AppError('NOT_FOUND','Задача не найдена.',404);return {ok:true};});
  app.get('/account/social/threads',{preHandler:permission('messages.read')},async req=>({items:db.prepare('SELECT t.*,c.name,c.phone,s.channel,s.label,s.state connection_state,(SELECT body FROM social_messages WHERE thread_id=t.id ORDER BY created_at DESC LIMIT 1) last_message FROM social_threads t JOIN crm_contacts c ON c.id=t.contact_id JOIN social_connections s ON s.id=t.connection_id WHERE t.merchant_id=? ORDER BY t.updated_at DESC LIMIT 200').all(req.company.id)}));
  const threadFor=(id,tid)=>{const t=db.prepare('SELECT * FROM social_threads WHERE merchant_id=? AND id=?').get(id,tid);if(!t)throw new AppError('NOT_FOUND','Диалог не найден.',404);return t;};
  app.get('/account/social/threads/:id',{preHandler:permission('messages.read')},async req=>{const t=threadFor(req.company.id,req.params.id);return {thread:t,ai_state:db.prepare("SELECT name FROM sqlite_master WHERE name='ai_threads'").get()?(db.prepare('SELECT state FROM ai_threads WHERE thread_id=?').get(t.id)?.state||'active'):null,can_control_ai:req.member.is_owner,messages:db.prepare('SELECT id,direction,provider_id,body,state,error,created_at,actor_id FROM social_messages WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200').all(t.id).reverse()};});
  app.post('/account/social/threads/:id/messages',{preHandler:permission('messages.send')},async req=>{
    const b=z.object({text:z.string().trim().min(1).max(1000)}).strict().parse(req.body),key=idem.parse(req.headers['idempotency-key']);
    return store.transaction(()=>{const t=threadFor(req.company.id,req.params.id),old=db.prepare('SELECT * FROM social_messages WHERE merchant_id=? AND idem=?').get(req.company.id,key);if(old){if(old.thread_id!==t.id||old.body!==b.text||old.actor_id!==req.member.id)throw new AppError('IDEMPOTENCY_CONFLICT','С этим ключом уже отправлен другой ответ.',409);return {id:old.id,state:old.state,replay:true};}
      const c=connection(req.company.id,t.connection_id);if(c.state!=='connected')throw new AppError('META_NOT_CONNECTED','Проверьте подключение канала.',409);if(t.opted_out)throw new AppError('CONTACT_OPTED_OUT','Клиент отказался от сообщений. Отправка остановлена.',409);if(c.channel!=='telegram'&&(!t.last_inbound_at||t.last_inbound_at<now()-24*3600000))throw new AppError('MESSAGING_WINDOW_CLOSED','Окно ответа 24 часа закрыто. Для WhatsApp используйте одобренный шаблон в Meta; свободный текст не отправляется.',409);
      const id=randomUUID(),time=now();if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='ai_threads'").get()){db.prepare("INSERT INTO ai_threads(thread_id,state,updated_at) VALUES(?,'handoff',?) ON CONFLICT(thread_id) DO UPDATE SET state='handoff',quote=NULL,updated_at=excluded.updated_at").run(t.id,time);db.prepare("UPDATE social_messages SET state='failed',error='HUMAN_REPLY',updated_at=? WHERE thread_id=? AND state='queued' AND idem LIKE 'ai:%'").run(time,t.id);}db.prepare("INSERT INTO social_messages(id,merchant_id,thread_id,direction,body,state,idem,actor_id,created_at,updated_at) VALUES(?,?,?,'out',?,'queued',?,?,?,?)").run(id,req.company.id,t.id,b.text,key,req.member.id,time,time);db.prepare('UPDATE social_threads SET updated_at=? WHERE id=?').run(time,t.id);audit(req,'social.reply_queued',{message:id,thread:t.id});return {id,state:'queued',replay:false};
    });
  });
  let timer,running,closing=false;
  // A crash after dispatch must never cause automatic duplicate customer messages.
  db.prepare("UPDATE social_messages SET state='unknown',error='PROCESS_RESTART' WHERE state='sending'").run();
  async function tick() {
    if(running||closing)return;
    running=(async()=>{if(provider.refreshInstagram){const expiring=db.prepare("SELECT * FROM social_connections WHERE channel='instagram' AND state='connected' AND expires_at>? AND expires_at<? AND verified_at<? LIMIT 2").all(now(),now()+7*86400000,now()-86400000);for(const c of expiring){try{const updated=await provider.refreshInstagram(secretFor(c).access_token);db.prepare("UPDATE social_connections SET secret=?,expires_at=?,verified_at=?,last_error=NULL WHERE id=? AND state='connected'").run(seal({...secretFor(c),...updated},config.key,`social:${c.merchant_id}:${c.channel}:${c.external_id}`),updated.expires_at,now(),c.id);}catch{db.prepare("UPDATE social_connections SET last_error='META_TOKEN_REFRESH_FAILED',verified_at=? WHERE id=?").run(now(),c.id);}}}const jobs=db.prepare("SELECT * FROM social_messages WHERE state='queued' ORDER BY created_at LIMIT 10").all();for(const m of jobs){if(closing)break;const t=threadFor(m.merchant_id,m.thread_id),c=connection(m.merchant_id,t.connection_id);
      const ownerActor=db.prepare('SELECT 1 FROM business_users WHERE id=? AND merchant_id=?').get(m.actor_id,m.merchant_id),staffActor=db.prepare('SELECT role FROM business_staff WHERE id=? AND merchant_id=? AND active=1').get(m.actor_id,m.merchant_id);
      if((!ownerActor&&!teamRole(staffActor?.role)?.permissions.includes('messages.send'))||c.state!=='connected'||t.opted_out||(c.channel!=='telegram'&&(!t.last_inbound_at||t.last_inbound_at<now()-24*3600000))||(c.expires_at&&c.expires_at<=now())){db.prepare("UPDATE social_messages SET state='failed',error='CHANNEL_OR_WINDOW_UNAVAILABLE',updated_at=? WHERE id=? AND state='queued'").run(now(),m.id);continue;}
      if(m.idem?.startsWith('ai:')){const setting=db.prepare('SELECT data FROM ai_settings WHERE merchant_id=?').get(m.merchant_id),policy=setting?JSON.parse(setting.data):null;if(!policy?.enabled||!policy.connection_ids.includes(c.id)){db.prepare("UPDATE social_messages SET state='failed',error='AI_DISABLED',updated_at=? WHERE id=?").run(now(),m.id);continue;}}
      const p=c.channel==='telegram'?{}:platform(c.channel);if(!p)continue;
      if(!db.prepare("UPDATE social_messages SET state='sending',updated_at=? WHERE id=? AND state='queued'").run(now(),m.id).changes)continue;
      try{const providerId=c.channel==='telegram'?'telegram:'+String((await telegram.request(secretFor(c).bot_token,'sendMessage',{chat_id:t.external_id,text:m.body})).message_id):await provider.send(c,secretFor(c),p,t.external_id,m.body);db.prepare("UPDATE social_messages SET state='sent',provider_id=?,updated_at=? WHERE id=?").run(providerId,now(),m.id);}
      catch(e){const unknown=e.code==='META_RESULT_UNKNOWN'||!e.code;db.prepare('UPDATE social_messages SET state=?,error=?,updated_at=? WHERE id=?').run(unknown?'unknown':'failed',e.code||'META_RESULT_UNKNOWN',now(),m.id);if(e.code==='META_TOKEN_EXPIRED')db.prepare("UPDATE social_connections SET state='error',last_error=? WHERE id=?").run(e.code,c.id);}
    }})().finally(()=>{running=null;});await running;
  }
  if(background){timer=setInterval(()=>tick().catch(()=>{}),2000);timer.unref();}
  const close=async()=>{closing=true;clearInterval(timer);await running;};app.addHook('onClose',close);
  const service={tick,platform,connection,stages,close};app.decorate('socialService',service);return service;
}
