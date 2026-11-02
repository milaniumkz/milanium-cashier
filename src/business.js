import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { AppError, now } from './db.js';
import { hash, token, seal } from './crypto.js';
import { merchantSchema } from './config.js';
import { registerAccounting } from './accounting.js';
import { registerTariffPayments } from './tariff-payments.js';
import { publicServerIp } from './api-access.js';
import { validateWebhookUrl } from './webhooks.js';

const scrypt=promisify(scryptCallback);
export const plans=Object.freeze([
  {id:'start',name:'Старт',daily_limit:50,price:10000},
  {id:'business',name:'Бизнес',daily_limit:200,price:25000},
  {id:'pro',name:'Про',daily_limit:400,price:60000},
  {id:'pro_max',name:'Про Макс',daily_limit:700,price:90000},
]);
export const businessDay=at=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Almaty',year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
function nextMonth(at){const d=new Date(at),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+1);const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return +d;}
const keySchema=z.string().regex(/^[\w.:-]{8,120}$/);
const loginSchema=z.string().trim().toLowerCase().min(3).max(100).regex(/^[a-z0-9][a-z0-9_.@+-]*$/);
const passwordSchema=z.string().min(12).max(128);
async function passwordHash(password){const salt=randomBytes(16).toString('hex');const digest=await scrypt(password,salt,64);return `${salt}:${digest.toString('hex')}`;}
async function passwordMatches(password,encoded){const [salt,value]=encoded.split(':');const digest=await scrypt(password,salt,64);return timingSafeEqual(digest,Buffer.from(value,'hex'));}
// Hash a dummy password for indistinguishable unknown-user login work.
const dummyHash=await passwordHash(randomBytes(32).toString('hex'));

export class Business {
 constructor(store){this.store=store;this.db=store.db;this.db.exec(`
 CREATE TABLE IF NOT EXISTS business_users(id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL UNIQUE REFERENCES merchants(id), login TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS business_sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES business_users(id),expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS business_wallets(merchant_id TEXT PRIMARY KEY REFERENCES merchants(id), balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0), plan_id TEXT, expires_at INTEGER);
 CREATE TABLE IF NOT EXISTS business_ledger(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL REFERENCES merchants(id),amount INTEGER NOT NULL,balance_after INTEGER NOT NULL,kind TEXT NOT NULL,reference TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(merchant_id,reference));
 CREATE TABLE IF NOT EXISTS business_topups(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL REFERENCES merchants(id),amount INTEGER NOT NULL CHECK(amount>0),status TEXT NOT NULL DEFAULT 'pending',idem TEXT NOT NULL,bank_reference TEXT UNIQUE,created_at INTEGER NOT NULL,reviewed_at INTEGER,UNIQUE(merchant_id,idem));
 CREATE TABLE IF NOT EXISTS business_contracts(merchant_id TEXT PRIMARY KEY REFERENCES merchants(id),price INTEGER NOT NULL,daily_limit INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS business_usage(invoice_id TEXT PRIMARY KEY REFERENCES invoices(id),merchant_id TEXT NOT NULL REFERENCES merchants(id),day TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
 CREATE INDEX IF NOT EXISTS business_daily ON business_usage(merchant_id,day,active);
 `);store.billing=this;}
 hasOpenPayments(id){return !!this.db.prepare("SELECT id FROM invoices WHERE merchant_id=? AND status IN ('queued','processing','pending','unknown','requires_auth') LIMIT 1").get(id);}
 offer(id){const row=this.db.prepare('SELECT price,daily_limit FROM business_contracts WHERE merchant_id=?').get(id);return row?{id:'individual',name:'Индивидуальный',...row}:null;}
 snapshot(id,at=now()){const w=this.db.prepare('SELECT * FROM business_wallets WHERE merchant_id=?').get(id);if(!w)return null;
  const sourcePlan=plans.find(p=>p.id===w.plan_id)||(w.plan_id==='individual'?this.offer(id):null);const plan=sourcePlan?{...sourcePlan}:null;const used=this.db.prepare('SELECT COUNT(*) n FROM business_usage WHERE merchant_id=? AND day=? AND active=1').get(id,businessDay(at)).n;
  if(plan){if(w.plan_price!=null)plan.price=w.plan_price;if(w.plan_daily_limit!=null)plan.daily_limit=w.plan_daily_limit;}
  const active=!!plan&&w.expires_at>at;return {balance:w.balance,plan,expires_at:w.expires_at,active,used_today:used,remaining_today:active?Math.max(0,plan.daily_limit-used):0,timezone:'Asia/Almaty'};}
 admit(id,at){if(!this.db.prepare('SELECT merchant_id FROM business_wallets WHERE merchant_id=?').get(id))return null;
  const b=this.snapshot(id,at);if(!b.active)throw new AppError('SUBSCRIPTION_REQUIRED','Выберите и оплатите тариф для выставления счетов.',402);
  if(b.remaining_today<1)throw new AppError('DAILY_LIMIT_REACHED','Дневной лимит тарифа исчерпан. Проверка существующих счетов доступна.',429);
  return businessDay(at);}
 reserve(id,invoiceId,day){if(!day)return;this.db.prepare('INSERT INTO business_usage(invoice_id,merchant_id,day,active) VALUES(?,?,?,1) ON CONFLICT(invoice_id) DO UPDATE SET day=excluded.day,active=1').run(invoiceId,id,day);}
 release(invoice){if(!invoice.submitted&&!invoice.provider_id&&['failed','requires_auth'].includes(invoice.status))this.db.prepare('UPDATE business_usage SET active=0 WHERE invoice_id=?').run(invoice.id);}
 subscribe(id,planId,idem){keySchema.parse(idem);const p=plans.find(p=>p.id===planId)||(planId==='individual'?this.offer(id):null);if(!p)throw new AppError('INVALID_PLAN','Выберите доступный тариф.');
  return this.store.transaction(()=>{
   const ref='subscription:'+idem;const previous=this.db.prepare('SELECT * FROM business_ledger WHERE merchant_id=? AND reference=?').get(id,ref);
   if(previous){if(previous.detail!==p.id)throw new AppError('IDEMPOTENCY_CONFLICT','Ключ уже использован для другого тарифа.',409);return {replay:true,billing:this.snapshot(id)};}
   const w=this.snapshot(id);if(!w||w.balance<p.price)throw new AppError('INSUFFICIENT_BALANCE','Недостаточно средств для оплаты тарифа.',402);
   const until=nextMonth(w.active&&w.plan.id===p.id?w.expires_at:now());
   this.db.prepare('UPDATE business_wallets SET balance=balance-?,plan_id=?,expires_at=?,plan_price=?,plan_daily_limit=? WHERE merchant_id=?').run(p.price,p.id,until,p.price,p.daily_limit,id);
   this.db.prepare('INSERT INTO business_ledger VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),id,-p.price,w.balance-p.price,'subscription',ref,p.id,now());
   this.store.audit(id,null,'billing.subscription',p.id);return {replay:false,billing:this.snapshot(id)};
  });}
 topup(id,amount,idem){keySchema.parse(idem);z.number().int().min(1000).max(10000000).parse(amount);
  return this.store.transaction(()=>{
   const previous=this.db.prepare('SELECT * FROM business_topups WHERE merchant_id=? AND idem=?').get(id,idem);
   if(previous){if(previous.amount!==amount)throw new AppError('IDEMPOTENCY_CONFLICT','Ключ уже использован с другой суммой.',409);return previous;}
   if(this.db.prepare("SELECT COUNT(*) n FROM business_topups WHERE merchant_id=? AND status='pending'").get(id).n>=5)throw new AppError('TOO_MANY_REQUESTS','Дождитесь проверки существующих заявок.',409);
   const tid=randomUUID();this.db.prepare('INSERT INTO business_topups(id,merchant_id,amount,idem,created_at) VALUES(?,?,?,?,?)').run(tid,id,amount,idem,now());return this.db.prepare('SELECT * FROM business_topups WHERE id=?').get(tid);
  });}
 review(tid,decision,reference){return this.store.transaction(()=>{
  const t=this.db.prepare('SELECT * FROM business_topups WHERE id=?').get(tid);if(!t)throw new AppError('NOT_FOUND','Заявка не найдена.',404);
  if(t.status!=='pending'){if(t.status===decision&&(decision==='rejected'||t.bank_reference===reference))return {replay:true};throw new AppError('ALREADY_REVIEWED','Заявка уже рассмотрена.',409);}
  if(decision==='approved'){
   z.string().trim().min(4).max(150).parse(reference);
   if(this.db.prepare('SELECT id FROM business_topups WHERE bank_reference=?').get(reference))throw new AppError('BANK_REFERENCE_USED','Этот банковский перевод уже зачтён.',409);
   const w=this.snapshot(t.merchant_id);if(w.balance+t.amount>100000000)throw new AppError('BALANCE_LIMIT','Превышен лимит баланса.',409);
   this.db.prepare('UPDATE business_wallets SET balance=balance+? WHERE merchant_id=?').run(t.amount,t.merchant_id);
   this.db.prepare('INSERT INTO business_ledger VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),t.merchant_id,t.amount,w.balance+t.amount,'topup','topup:'+t.id,reference,now());
  }
  this.db.prepare('UPDATE business_topups SET status=?,bank_reference=?,reviewed_at=? WHERE id=?').run(decision,decision==='approved'?reference:null,now(),tid);
  this.store.audit(t.merchant_id,null,'billing.topup.'+decision,t.id);return {replay:false};
 });}
}

export function registerBusiness(app,{store,config,driver,worker,create,admin}){
 const business=new Business(store);
 const cookieOptions={httpOnly:true,secure:config.production,sameSite:'strict',path:'/',maxAge:12*3600};
 async function issue(user,reply){const value=token();store.db.prepare('DELETE FROM business_sessions WHERE expires_at<?').run(now());store.db.prepare('INSERT INTO business_sessions VALUES(?,?,?)').run(hash(value),user.id,now()+12*3600000);reply.setCookie('mb_session',value,cookieOptions);}
 const member=async req=>{const u=store.db.prepare('SELECT u.id,u.login,u.merchant_id FROM business_sessions s JOIN business_users u ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>?').get(hash(req.cookies.mb_session||''),now());if(!u)throw new AppError('UNAUTHORIZED','Войдите в MBusiness.',401);req.member=u;req.company=store.merchant(u.merchant_id);};
 registerAccounting(app,{config,member});
 registerTariffPayments(app,{store,business,config,driver,worker,member,admin,getPlans:id=>[...plans,...(business.offer(id)?[business.offer(id)]:[])]});
 const limits={config:{rateLimit:{max:8,timeWindow:'1 minute'}}};
 app.post('/auth/register',limits,async(req,reply)=>{
  const v=z.object({login:loginSchema,password:passwordSchema,company:z.string().trim().min(2).max(100)}).strict().parse(req.body);
  const password=await passwordHash(v.password);
  const result=store.transaction(()=>{
   if(store.db.prepare('SELECT id FROM business_users WHERE login=?').get(v.login))throw new AppError('LOGIN_UNAVAILABLE','Этот логин недоступен.',409);
   const created=store.createMerchant({name:v.company,account_label:v.company,webhook_url:''});const id=randomUUID();
   store.db.prepare('INSERT INTO business_users VALUES(?,?,?,?,?)').run(id,created.merchant.id,v.login,password,now());
   store.db.prepare('INSERT INTO business_wallets(merchant_id) VALUES(?)').run(created.merchant.id);return {id,...created};
  });await issue(result,reply);reply.code(201);return {api_key:result.api_key,webhook_secret:result.webhook_secret};
 });
 app.post('/auth/login',limits,async(req,reply)=>{
  const v=z.object({login:loginSchema,password:z.string().min(1).max(128)}).strict().parse(req.body);
  const u=store.db.prepare('SELECT * FROM business_users WHERE login=?').get(v.login);
  if(!await passwordMatches(v.password,u?.password_hash||dummyHash)||!u||store.db.prepare('SELECT password_hash FROM business_users WHERE id=?').get(u.id)?.password_hash!==u.password_hash)throw new AppError('INVALID_LOGIN','Неверный логин или пароль.',401);
  await issue(u,reply);return {ok:true};
 });
 app.post('/auth/logout',{preHandler:member},async(req,reply)=>{store.db.prepare('DELETE FROM business_sessions WHERE hash=?').run(hash(req.cookies.mb_session||''));reply.clearCookie('mb_session',{path:'/'});return {ok:true};});
 app.post('/account/password',{preHandler:member,...limits},async(req,reply)=>{
  const v=z.object({current_password:z.string().min(1).max(128),password:passwordSchema}).strict().parse(req.body);
  const u=store.db.prepare('SELECT * FROM business_users WHERE id=?').get(req.member.id);
  if(!await passwordMatches(v.current_password,u.password_hash))throw new AppError('INVALID_LOGIN','Текущий пароль неверен.',401);
  const digest=await passwordHash(v.password);store.transaction(()=>{store.db.prepare('UPDATE business_users SET password_hash=? WHERE id=?').run(digest,u.id);store.db.prepare('DELETE FROM business_sessions WHERE user_id=?').run(u.id);});await issue(u,reply);return {ok:true};
 });
 app.get('/account/overview',{preHandler:member},async req=>{
  const id=req.company.id;return {tariff_payments:store.tariffs.orders(id),billing_cashier_available:store.tariffs.overview().enabled&&store.tariffs.overview().connected,user:{login:req.member.login},company:store.merchantPublic(req.company),mode:config.mode,capabilities:driver.capabilities(),billing:business.snapshot(id),plans:[...plans,...(business.offer(id)?[business.offer(id)]:[])],
   invoices:store.listInvoices(id,200).map(i=>store.invoicePublic(i)),
   stats:store.db.prepare('SELECT status,COUNT(*) count,SUM(amount) amount FROM invoices WHERE merchant_id=? GROUP BY status').all(id),
   daily:store.db.prepare('SELECT created_at,amount,status FROM invoices WHERE merchant_id=? AND created_at>=? ORDER BY created_at').all(id,now()-7*86400000),
   ledger:store.db.prepare('SELECT * FROM business_ledger WHERE merchant_id=? ORDER BY created_at DESC LIMIT 100').all(id),
   topups:store.db.prepare('SELECT id,amount,status,created_at,reviewed_at FROM business_topups WHERE merchant_id=? ORDER BY created_at DESC LIMIT 30').all(id),
   events:store.db.prepare('SELECT id,invoice_id,attempts,delivered_at,last_error,dead FROM events WHERE merchant_id=? ORDER BY next_at DESC LIMIT 50').all(id)};
 });
 app.post('/account/topups',{preHandler:member},async()=>{throw new AppError('TOPUPS_DISABLED','Пополнение баланса отключено. Оплачивайте тариф напрямую.',410);});
 app.post('/account/subscription',{preHandler:member},async()=>{throw new AppError('DIRECT_PAYMENT_REQUIRED','Оплачивайте тариф через /account/subscription-orders.',410);});
 app.post('/account/individual-plan',{preHandler:member,config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async req=>{const v=z.object({daily_limit:z.number().int().min(701).max(100000),comment:z.string().max(1000).default('')}).strict().parse(req.body);store.audit(req.company.id,null,'billing.individual_requested',JSON.stringify(v));return {ok:true};});
 app.post('/account/invoices',{preHandler:member},async(req,reply)=>{const result=create(req.company,req.body,req.headers['idempotency-key']);reply.code(result.replay?200:201);return {...store.invoicePublic(result.invoice),replay:result.replay};});
 const ownInvoice=req=>{const i=store.invoice(req.params.id);if(!i||i.merchant_id!==req.company.id)throw new AppError('NOT_FOUND','Счёт не найден.',404);return i;};
 app.get('/account/invoices/:id',{preHandler:member},async req=>store.invoicePublic(ownInvoice(req)));
 app.get('/account/invoices/:id/audit',{preHandler:member},async req=>{ownInvoice(req);return store.db.prepare('SELECT action,detail,created_at FROM audit WHERE invoice_id=? ORDER BY id').all(req.params.id);});
 app.post('/account/invoices/:id/retry',{preHandler:member},async req=>{ownInvoice(req);store.retry(req.params.id);return {ok:true};});
 app.post('/account/invoices/:id/reconcile',{preHandler:member},async req=>{const i=ownInvoice(req);if(!['unknown','pending'].includes(i.status)||worker.busy.has(req.company.id))throw new AppError('NOT_RECONCILABLE','Сверка сейчас недоступна.',409);
  const {provider_id}=z.object({provider_id:z.string().min(1).max(200)}).strict().parse(req.body);if(i.provider_id&&i.provider_id!==provider_id)throw new AppError('PROVIDER_ID_CONFLICT','Идентификатор уже сохранён.',409);store.patch(i.id,{provider_id,next_poll:0});return {ok:true};});
 app.post('/account/api-server',{preHandler:member,config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async req=>{
  const v=z.object({ip:z.string().trim().refine(value=>!!publicServerIp(value),'Укажите один публичный исходящий IP сервера без порта и маски.'),password:z.string().min(1).max(128)}).strict().parse(req.body);
  const user=store.db.prepare('SELECT password_hash FROM business_users WHERE id=?').get(req.member.id);
  if(!await passwordMatches(v.password,user.password_hash)||store.db.prepare('SELECT password_hash FROM business_users WHERE id=?').get(req.member.id)?.password_hash!==user.password_hash)throw new AppError('INVALID_LOGIN','Неверный пароль MBusiness.',401);
  return store.bindApiServer(req.company.id,publicServerIp(v.ip));
 });
 app.post('/account/key',{preHandler:member},async req=>({api_key:store.rotateKey(req.company.id)}));
 app.post('/account/webhook-secret',{preHandler:member},async req=>{const secret=token('whsec_');store.db.prepare('UPDATE merchants SET webhook_secret=? WHERE id=?').run(seal(secret,config.key,`webhook:${req.company.id}`),req.company.id);store.audit(req.company.id,null,'webhook.secret_rotated');return {webhook_secret:secret};});
 app.patch('/account/company',{preHandler:member},async req=>{
  const v=merchantSchema.parse(req.body);validateWebhookUrl(v.webhook_url,config);
  if(v.account_label!==req.company.account_label&&req.company.state==='connected')throw new AppError('DISCONNECT_REQUIRED','Отключите кассира перед сменой организации.',409);
  if(v.account_label!==req.company.account_label&&business.hasOpenPayments?.(req.company.id))throw new AppError('OPEN_PAYMENTS_EXIST','Сначала завершите сверку открытых платежей.',409);
  store.db.prepare('UPDATE merchants SET name=?,account_label=?,webhook_url=? WHERE id=?').run(v.name,v.account_label,v.webhook_url,req.company.id);return {ok:true};
 });
 const locks=new Set();
 for(const step of ['start','verify'])app.post('/account/kaspi/'+step,{preHandler:member,config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async req=>{
  if(config.mode!=='kaspi')throw new AppError('METHOD_UNAVAILABLE','В sandbox банковский вход не выполняется.',409);
  const id=req.company.id;if(locks.has(id)||worker.busy.has(id))throw new AppError('BUSY','Дождитесь завершения операции.',409);
  const v=(step==='start'?z.object({phone:z.string().regex(/^\+?7\d{10}$/)}):z.object({otp:z.string().regex(/^\d{4,8}$/)})).strict().parse(req.body);
  locks.add(id);worker.busy.add(id);try{return await driver.authenticate(req.company,step,v);}finally{locks.delete(id);worker.busy.delete(id);}
 });
 app.post('/account/disconnect',{preHandler:member},async req=>{const id=req.company.id;if(worker.busy.has(id)||locks.has(id))throw new AppError('BUSY','Дождитесь завершения операции.',409);worker.busy.add(id);try{store.disconnect(id);await driver.disconnect(id);}finally{worker.busy.delete(id);}return {ok:true};});
 app.post('/account/events/:id/retry',{preHandler:member},async req=>{const result=store.db.prepare('UPDATE events SET dead=0,attempts=0,next_at=? WHERE id=? AND merchant_id=? AND delivered_at IS NULL').run(now(),req.params.id,req.company.id);if(!result.changes)throw new AppError('NOT_FOUND','Событие не найдено.',404);return {ok:true};});
 app.get('/admin/topups',{preHandler:admin},async()=>({data:store.db.prepare('SELECT t.*,m.name FROM business_topups t JOIN merchants m ON m.id=t.merchant_id ORDER BY t.created_at DESC LIMIT 100').all(),individual:store.db.prepare("SELECT a.*,m.name FROM audit a JOIN merchants m ON m.id=a.merchant_id WHERE a.action='billing.individual_requested' ORDER BY a.id DESC LIMIT 30").all()}));
 app.post('/admin/topups/:id/review',{preHandler:admin},async req=>{const v=z.object({decision:z.enum(['approved','rejected']),bank_reference:z.string().trim().min(4).max(150).optional()}).strict().parse(req.body);return business.review(req.params.id,v.decision,v.bank_reference);});
 app.post('/admin/merchants/:id/contract',{preHandler:admin},async req=>{
  const id=req.params.id;if(!store.merchant(id)||!business.snapshot(id))throw new AppError('NOT_FOUND','Кабинет компании не найден.',404);
  const v=z.object({price:z.number().int().min(1).max(10000000),daily_limit:z.number().int().min(701).max(100000)}).strict().parse(req.body);
  const b=business.snapshot(id);if(b.active&&b.plan.id==='individual')throw new AppError('ACTIVE_CONTRACT','Измените условия после окончания действующей индивидуальной подписки.',409);
  store.db.prepare('INSERT INTO business_contracts VALUES(?,?,?) ON CONFLICT(merchant_id) DO UPDATE SET price=excluded.price,daily_limit=excluded.daily_limit').run(id,v.price,v.daily_limit);
  store.audit(id,null,'billing.contract_offered',JSON.stringify(v));return {ok:true};
 });
 app.get('/v1/billing',async req=>business.snapshot(req.merchant.id));
 return business;
}
