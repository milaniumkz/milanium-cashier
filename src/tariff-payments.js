import { z } from 'zod';
import { AppError, now } from './db.js';
import { KaspiDriver } from './drivers/kaspi.js';
import { hash } from './crypto.js';
import { invoiceSchema } from './config.js';

function addMonth(at){const d=new Date(at),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+1);const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return +d;}
export function registerTariffPayments(app,{store,business,config,driver,worker,member,admin,getPlans,billingDriver}){
 const db=store.db;
 db.exec(`CREATE TABLE IF NOT EXISTS service_cashier(id INTEGER PRIMARY KEY CHECK(id=1),merchant_id TEXT NOT NULL REFERENCES merchants(id),enabled INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS tariff_payments(invoice_id TEXT PRIMARY KEY REFERENCES invoices(id),company_id TEXT NOT NULL REFERENCES merchants(id),plan_id TEXT NOT NULL,plan_name TEXT NOT NULL,price INTEGER NOT NULL,daily_limit INTEGER NOT NULL,idem TEXT NOT NULL,fingerprint TEXT NOT NULL,presentation TEXT NOT NULL,created_at INTEGER NOT NULL,activated_at INTEGER,subscription_expires_at INTEGER,UNIQUE(company_id,idem));`);
 db.exec(`CREATE TABLE IF NOT EXISTS service_topup_orders(invoice_id TEXT PRIMARY KEY REFERENCES invoices(id),company_id TEXT NOT NULL REFERENCES merchants(id),amount INTEGER NOT NULL,idem TEXT NOT NULL,fingerprint TEXT NOT NULL,presentation TEXT NOT NULL,credited_at INTEGER,created_at INTEGER NOT NULL,UNIQUE(company_id,idem));`);
 const columns=db.prepare('PRAGMA table_info(business_wallets)').all();
 for(const column of ['plan_price','plan_daily_limit'])if(!columns.some(c=>c.name===column))db.exec(`ALTER TABLE business_wallets ADD COLUMN ${column} INTEGER;`);
 const setting=()=>db.prepare('SELECT * FROM service_cashier WHERE id=1').get();
 const central=()=>{const s=setting();return s?store.merchant(s.merchant_id):null;};
 const billingConfig={...config};Object.defineProperty(billingConfig,'liveEnabled',{get:()=>!!setting()?.enabled});
 const collector=billingDriver||(config.mode==='kaspi'?new KaspiDriver(billingConfig,store):driver);
 driver.forMerchant=m=>m.id===setting()?.merchant_id?collector:driver;
 const locks=new Set();
 const overview=()=>{const m=central();return {configured:!!m,enabled:!!setting()?.enabled,connected:config.mode==='sandbox'||m?.state==='connected',mode:config.mode,merchant:m?store.merchantPublic(m):null};};
 const publicOrder=o=>{const i=store.invoice(o.invoice_id),p=store.invoicePublic(i);return {id:o.invoice_id,plan_id:o.plan_id,plan_name:o.plan_name,amount:o.price,daily_limit:o.daily_limit,method:o.presentation,status:i.status,error_code:i.error_code,checkout_url:p.checkout_url,payment_url:p.payment_url,qr_url:p.qr_available?`/public/payments/${i.public_token}/qr`:null,activated_at:o.activated_at,subscription_expires_at:o.subscription_expires_at,created_at:o.created_at};};
 const service={
  overview,
  orders:id=>db.prepare('SELECT * FROM tariff_payments WHERE company_id=? ORDER BY created_at DESC LIMIT 50').all(id).map(publicOrder),
  invoiceChanged(invoice){
   if(invoice.status!=='paid')return;
   const topup=db.prepare('SELECT * FROM service_topup_orders WHERE invoice_id=?').get(invoice.id);
   if(topup&&!topup.credited_at){if(invoice.amount!==topup.amount||invoice.currency!=='KZT'||invoice.merchant_id!==setting()?.merchant_id)throw new Error('Service topup evidence mismatch');store.serviceWallet.credit(topup.company_id,topup.amount*1000000,'kaspi:'+invoice.id,'Confirmed service balance payment',true);db.prepare('UPDATE service_topup_orders SET credited_at=? WHERE invoice_id=?').run(now(),invoice.id);store.audit(topup.company_id,null,'services.payment_confirmed',invoice.id);return;}
   const order=db.prepare('SELECT * FROM tariff_payments WHERE invoice_id=?').get(invoice.id);
   if(!order||order.activated_at)return;
   if(invoice.amount!==order.price||invoice.currency!=='KZT'||invoice.merchant_id!==setting()?.merchant_id)throw new Error('Tariff payment evidence mismatch');
   const wallet=business.snapshot(order.company_id);if(!wallet)throw new Error('Tariff company missing');
   const expires=addMonth(wallet.active&&wallet.plan.id===order.plan_id?wallet.expires_at:now());
   const activated=now();
   db.prepare('UPDATE business_wallets SET plan_id=?,expires_at=?,plan_price=?,plan_daily_limit=? WHERE merchant_id=?').run(order.plan_id,expires,order.price,order.daily_limit,order.company_id);
   db.prepare('UPDATE tariff_payments SET activated_at=?,subscription_expires_at=? WHERE invoice_id=? AND activated_at IS NULL').run(activated,expires,invoice.id);
   store.audit(order.company_id,null,'subscription.payment_confirmed',invoice.id);
  },
  create(company,body,idem){
   const v=z.object({plan:z.string().min(1).max(40),method:z.enum(['qr','link','phone']),customer_phone:z.string().regex(/^\+7\d{10}$/).optional()}).strict().parse(body);
   if(!/^[\w.:-]{8,120}$/.test(idem||''))throw new AppError('INVALID_IDEMPOTENCY_KEY','Укажите Idempotency-Key.');
   if(v.method==='phone'&&!v.customer_phone)throw new AppError('PHONE_REQUIRED','Введите телефон для удалённого счёта.');
   const plan=getPlans(company.id).find(p=>p.id===v.plan);if(!plan)throw new AppError('INVALID_PLAN','Тариф не найден.');
   const fingerprint=hash(JSON.stringify(v));
   return store.transaction(()=>{
    const old=db.prepare('SELECT * FROM tariff_payments WHERE company_id=? AND idem=?').get(company.id,idem);
    if(old){if(old.fingerprint!==fingerprint)throw new AppError('IDEMPOTENCY_CONFLICT','Ключ уже использован с другими параметрами.',409);return {order:publicOrder(old),replay:true};}
    const open=db.prepare("SELECT p.* FROM tariff_payments p JOIN invoices i ON i.id=p.invoice_id WHERE p.company_id=? AND i.status IN ('queued','processing','pending','unknown') LIMIT 1").get(company.id);
    if(open)throw new AppError('PAYMENT_IN_PROGRESS','Уже есть незавершённая оплата тарифа. Откройте её в истории.',409);
    const s=setting(),m=central();if(!s?.enabled||!m)throw new AppError('BILLING_CASHIER_UNAVAILABLE','Кассир сервиса для оплаты тарифов пока не настроен.',409);
    if(config.mode!=='sandbox'&&m.state!=='connected')throw new AppError('BILLING_AUTH_REQUIRED','Кассиру сервиса требуется повторный вход.',409);
    const input=invoiceSchema.parse({order_id:'tariff-'+hash(company.id+':'+idem).slice(0,40),amount:plan.price,currency:'KZT',method:v.method==='phone'?'phone':'qr',...(v.customer_phone?{customer_phone:v.customer_phone}:{}),description:'MBusiness: '+plan.name});
    // Idempotency is company-scoped; the collector has a separate internal namespace.
    const {invoice}=store.createInvoice(m,input,'tariff-'+hash(company.id+':'+idem).slice(0,40),true);
    db.prepare('INSERT INTO tariff_payments(invoice_id,company_id,plan_id,plan_name,price,daily_limit,idem,fingerprint,presentation,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(invoice.id,company.id,plan.id,plan.name,plan.price,plan.daily_limit,idem,fingerprint,v.method,now());
    return {order:publicOrder(db.prepare('SELECT * FROM tariff_payments WHERE invoice_id=?').get(invoice.id)),replay:false};
   });
  }
 };
 store.tariffs=service;
 app.decorate('tariffPayments',service);
 app.get('/admin/billing/cashier',{preHandler:admin},async()=>overview());
 app.post('/admin/billing/cashier',{preHandler:admin},async req=>{
  const v=z.object({account_label:z.string().trim().min(2).max(150),enabled:z.boolean().default(false)}).strict().parse(req.body);let m=central();
  if(m&&(worker.busy.has(m.id)||locks.has(m.id)))throw new AppError('BUSY','Дождитесь окончания операции.',409);
  if(m&&v.account_label!==m.account_label){if(collector.hasOpenPayments?.(m.id)||store.listInvoices(m.id,1000).some(i=>['queued','processing','pending','unknown','requires_auth'].includes(i.status)))throw new AppError('OPEN_PAYMENTS_EXIST','Сначала завершите сверку оплат тарифов.',409);if(m.state==='connected')throw new AppError('DISCONNECT_REQUIRED','Сначала отключите кассира.',409);}
  if(!m){const created=store.createMerchant({name:'MBusiness • оплата тарифов',account_label:v.account_label,webhook_url:''});m=store.merchant(created.merchant.id);db.prepare('INSERT INTO service_cashier VALUES(1,?,?)').run(m.id,v.enabled?1:0);}
  else{db.prepare('UPDATE merchants SET account_label=? WHERE id=?').run(v.account_label,m.id);db.prepare('UPDATE service_cashier SET enabled=? WHERE id=1').run(v.enabled?1:0);}
  store.audit(m.id,null,'billing.cashier_configured');return overview();
 });
 for(const step of ['start','verify'])app.post('/admin/billing/cashier/'+step,{preHandler:admin,config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async req=>{
  const m=central();if(!m)throw new AppError('NOT_CONFIGURED','Сохраните название организации кассира.',409);
  if(config.mode!=='kaspi')throw new AppError('METHOD_UNAVAILABLE','В sandbox используется симулятор.',409);
  if(worker.busy.has(m.id)||locks.has(m.id))throw new AppError('BUSY','Дождитесь окончания операции.',409);
  const input=(step==='start'?z.object({phone:z.string().regex(/^\+?7\d{10}$/)}):z.object({otp:z.string().regex(/^\d{4,8}$/)})).strict().parse(req.body);
  locks.add(m.id);worker.busy.add(m.id);try{return await collector.authenticate(m,step,input);}finally{locks.delete(m.id);worker.busy.delete(m.id);}
 });
 app.post('/admin/billing/cashier/disconnect',{preHandler:admin},async()=>{const m=central();if(!m)return {ok:true};if(worker.busy.has(m.id)||locks.has(m.id))throw new AppError('BUSY','Дождитесь окончания операции.',409);db.prepare('UPDATE service_cashier SET enabled=0 WHERE id=1').run();locks.add(m.id);worker.busy.add(m.id);try{store.disconnect(m.id);await collector.disconnect(m.id);return {ok:true};}finally{locks.delete(m.id);worker.busy.delete(m.id);}});
 app.get('/admin/billing/payments',{preHandler:admin},async()=>({cashier:overview(),data:db.prepare('SELECT p.*,m.name FROM tariff_payments p JOIN merchants m ON m.id=p.company_id ORDER BY p.created_at DESC LIMIT 100').all().map(o=>({...publicOrder(o),company_name:o.name}))}));
 app.post('/account/subscription-orders',{preHandler:member},async(req,reply)=>{const result=service.create(req.company,req.body,req.headers['idempotency-key']);reply.code(result.replay?200:201);return result;});
 app.get('/account/subscription-orders',{preHandler:member},async req=>({cashier_available:overview().enabled&&overview().connected,data:db.prepare('SELECT * FROM tariff_payments WHERE company_id=? ORDER BY created_at DESC LIMIT 50').all(req.company.id).map(publicOrder)}));
 app.get('/account/subscription-orders/:id',{preHandler:member},async req=>{const o=db.prepare('SELECT * FROM tariff_payments WHERE invoice_id=? AND company_id=?').get(req.params.id,req.company.id);if(!o)throw new AppError('NOT_FOUND','Оплата тарифа не найдена.',404);return publicOrder(o);});
 const publicTopup=o=>{const i=store.invoice(o.invoice_id),p=store.invoicePublic(i);return {id:o.invoice_id,amount:o.amount,method:o.presentation,status:i.status,error_code:i.error_code,checkout_url:p.checkout_url,payment_url:p.payment_url,qr_url:p.qr_available?`/public/payments/${i.public_token}/qr`:null,credited_at:o.credited_at,created_at:o.created_at};};
 app.get('/account/service-orders',{preHandler:member},async req=>({cashier_available:overview().enabled&&overview().connected,items:db.prepare('SELECT * FROM service_topup_orders WHERE company_id=? ORDER BY created_at DESC LIMIT 50').all(req.company.id).map(publicTopup)}));
 app.post('/account/service-orders',{preHandler:member},async req=>{const b=z.object({amount:z.number().int().min(1000).max(1000000),method:z.enum(['qr','link','phone']),customer_phone:z.string().regex(/^\+7\d{10}$/).optional()}).strict().parse(req.body),key=req.headers['idempotency-key'];if(!/^[\w.:-]{8,120}$/.test(key||''))throw new AppError('INVALID_IDEMPOTENCY_KEY','Укажите Idempotency-Key.',400);if(b.method==='phone'&&!b.customer_phone)throw new AppError('PHONE_REQUIRED','Введите телефон.',400);const fingerprint=hash(JSON.stringify(b));return store.transaction(()=>{const old=db.prepare('SELECT * FROM service_topup_orders WHERE company_id=? AND idem=?').get(req.company.id,key);if(old){if(old.fingerprint!==fingerprint)throw new AppError('IDEMPOTENCY_CONFLICT','Ключ уже использован.',409);return {order:publicTopup(old),replay:true};}if(db.prepare("SELECT 1 FROM service_topup_orders o JOIN invoices i ON i.id=o.invoice_id WHERE o.company_id=? AND i.status IN ('queued','processing','pending','unknown','requires_auth')").get(req.company.id))throw new AppError('PAYMENT_IN_PROGRESS','Сначала завершите предыдущее пополнение.',409);const s=setting(),m=central();if(!s?.enabled||!m||(config.mode!=='sandbox'&&m.state!=='connected'))throw new AppError('BILLING_CASHIER_UNAVAILABLE','Кассир сервиса для пополнения ещё не подключён.',409);const ref='services-'+hash(req.company.id+':'+key).slice(0,40),input=invoiceSchema.parse({order_id:ref,amount:b.amount,currency:'KZT',method:b.method==='phone'?'phone':'qr',...(b.customer_phone?{customer_phone:b.customer_phone}:{}),description:'MBusiness: баланс услуг AI'}),{invoice}=store.createInvoice(m,input,ref,true);db.prepare('INSERT INTO service_topup_orders VALUES(?,?,?,?,?,?,NULL,?)').run(invoice.id,req.company.id,b.amount,key,fingerprint,b.method,now());return {order:publicTopup(db.prepare('SELECT * FROM service_topup_orders WHERE invoice_id=?').get(invoice.id)),replay:false};});});
 app.addHook('onClose',async()=>{if(collector!==driver)await collector.close();});
 return service;
}
