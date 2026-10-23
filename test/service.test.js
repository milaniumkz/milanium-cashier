import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig, invoiceSchema } from '../src/config.js';
import { Store } from '../src/db.js';
import { Worker } from '../src/worker.js';

import { seal, unseal, signWebhook } from '../src/crypto.js';
import { validateWebhookUrl, isPublicIPv4, Outbox } from '../src/webhooks.js';
import { verifyCashierWebhook } from '../examples/verify-webhook.mjs';

function config(mode='sandbox') { return { mode, production:false, key:randomBytes(32), adminPassword:randomBytes(24).toString('base64url'), baseUrl:'http://127.0.0.1:3080', dataDir:mkdtempSync(path.join(tmpdir(),'cashier-')), pollMs:1000, liveEnabled:false, connectorPath:'/nonexistent', webhookOrigins:['https://example.com'] }; }
function merchant(store, name='Тестовая компания') { return store.createMerchant({name,account_label:name,webhook_url:''}); }
const payload = (overrides={}) => invoiceSchema.parse({order_id:'test-1001',amount:15000,currency:'KZT',method:'phone',customer_phone:'+77001234567',...overrides});
async function fixture(t, mode='sandbox', driver) {
  const c=config(mode), app=await buildApp(c,{logger:false,background:false,driver});
  t.after(async()=>{await app.close();rmSync(c.dataDir,{recursive:true,force:true});});
  return {c,app,...app.services};
}

test('API: auth, encrypted phone, exact replay, conflict and tenant isolation',async t=>{
  const {app,store}=await fixture(t), a=merchant(store), b=merchant(store,'Вторая компания');
  const headers={authorization:`Bearer ${a.api_key}`,'idempotency-key':'order-key-1001'};
  assert.equal((await app.inject({method:'POST',url:'/v1/invoices',payload:payload()})).statusCode,401);
  const created=await app.inject({method:'POST',url:'/v1/invoices',headers,payload:payload()});assert.equal(created.statusCode,201);
  const invoice=created.json();assert.equal(invoice.status,'queued');assert.equal(invoice.customer_phone,undefined);
  assert.ok(!store.invoice(invoice.id).phone.includes('77001234567'));
  assert.equal(store.phone(store.invoice(invoice.id)),'+77001234567');
  const again=await app.inject({method:'POST',url:'/v1/invoices',headers,payload:payload()});assert.equal(again.statusCode,200);assert.equal(again.json().id,invoice.id);assert.equal(again.json().replay,true);
  const changed=await app.inject({method:'POST',url:'/v1/invoices',headers,payload:payload({amount:999})});assert.equal(changed.statusCode,409);
  const changedKey=await app.inject({method:'POST',url:'/v1/invoices',headers:{...headers,'idempotency-key':'another-key-1001'},payload:payload()});assert.equal(changedKey.statusCode,409);
  assert.equal((await app.inject({url:`/v1/invoices/${invoice.id}`,headers:{authorization:`Bearer ${b.api_key}`}})).statusCode,404);
  assert.equal((await app.inject({url:'/v1/invoices',headers:{authorization:`Bearer ${b.api_key}`}})).json().data.length,0);
  const publicData=(await app.inject({url:'/public/payments/'+store.invoice(invoice.id).public_token})).json();assert.equal(publicData.provider_id,undefined);assert.equal(publicData.customer_phone,undefined);
});

test('API: validation rejects fractional sums, unknown fields and missing phone',async t=>{
  const {app,store}=await fixture(t), a=merchant(store);
  for(const p of [{...payload(),amount:1.5},{...payload(),merchant_id:'other'},{...payload(),customer_phone:undefined}]){
    const r=await app.inject({method:'POST',url:'/v1/invoices',headers:{authorization:`Bearer ${a.api_key}`,'idempotency-key':'invalid-1001'},payload:p});assert.equal(r.statusCode,400);
  }
});

test('Sandbox: QR creation, customer confirmation, authoritative status and terminal protection',async t=>{
  const {app,store,worker}=await fixture(t), a=merchant(store), m=store.merchant(a.merchant.id);
  const {invoice:i}=store.createInvoice(m,payload({method:'qr',customer_phone:undefined}),'sandbox-order');
  await worker.create(i);const pending=store.invoice(i.id);assert.equal(pending.status,'pending');assert.ok(pending.qr_data.length>100);
  const qr=await app.inject({url:`/public/payments/${pending.public_token}/qr`});assert.equal(qr.statusCode,200);assert.equal(qr.headers['content-type'],'image/png');
  await app.inject({method:'POST',url:`/sandbox/payments/${pending.public_token}`,payload:{state:'paid'}});
  assert.equal(store.invoice(i.id).status,'pending'); // consumer click alone does not mark the service paid
  await worker.poll(store.invoice(i.id));assert.equal(store.invoice(i.id).status,'paid');
  assert.equal(store.invoicePublic(store.invoice(i.id)).qr_available,false);assert.equal(store.invoicePublic(store.invoice(i.id)).payment_url,null);
  assert.throws(()=>store.patch(i.id,{status:'pending'}),/Конечный/);
  assert.equal((await app.inject({method:'POST',url:`/sandbox/payments/${pending.public_token}`,payload:{state:'paid'}})).statusCode,409);
  assert.equal((await app.inject({url:`/public/payments/${pending.public_token}/qr`})).statusCode,404);
  const paid=store.db.prepare("SELECT * FROM events WHERE body LIKE '%invoice.paid%'").all();assert.equal(paid.length,1);
});

test('Ambiguous submit is never retried, including after restart and repeated API calls',async t=>{
  let calls=0;
  const driver={capabilities:()=>({configured:true,phone:true,qr:true}),create:async(_m,_i,before)=>{calls++;before();throw new Error('Connection lost after click');},close:async()=>{}};
  const {app,store,worker}=await fixture(t,'sandbox',driver),a=merchant(store);
  const {invoice}=store.createInvoice(store.merchant(a.merchant.id),payload(),'ambiguous-1001');
  await worker.create(invoice);assert.equal(calls,1);assert.equal(store.invoice(invoice.id).status,'unknown');
  assert.throws(()=>store.retry(invoice.id),/Повтор запрещён/);
  store.recover();assert.equal(store.nextJob(new Set()),undefined);
  const r=await app.inject({method:'POST',url:'/v1/invoices',headers:{authorization:`Bearer ${a.api_key}`,'idempotency-key':'ambiguous-1001'},payload:payload()});assert.equal(r.json().status,'unknown');assert.equal(calls,1);
});

test('Crash recovery preserves uncertainty and emits an event',async t=>{
  const {store}=await fixture(t),a=merchant(store),{invoice}=store.createInvoice(store.merchant(a.merchant.id),payload(),'restart-1001');
  store.patch(invoice.id,{status:'processing',submitted:1});store.recover();assert.equal(store.invoice(invoice.id).status,'unknown');assert.equal(store.invoice(invoice.id).error_code,'PROCESS_INTERRUPTED');assert.equal(store.nextJob(new Set()),undefined);
});

test('A failure conclusively before submit can be safely requeued',async t=>{
  const driver={capabilities:()=>({configured:true,phone:true}),create:async()=>{const e=new Error();e.code='AUTH_REQUIRED';throw e;},close:async()=>{}};
  const {store,worker}=await fixture(t,'sandbox',driver),a=merchant(store),{invoice}=store.createInvoice(store.merchant(a.merchant.id),payload(),'auth-order-1');
  await worker.create(invoice);assert.equal(store.invoice(invoice.id).status,'requires_auth');assert.equal(store.invoice(invoice.id).submitted,0);store.retry(invoice.id);assert.equal(store.invoice(invoice.id).status,'queued');
});

test('Evidence mismatch never becomes paid',async t=>{
  const driver={poll:async()=>{const e=new Error();e.code='PAYMENT_EVIDENCE_MISMATCH';throw e;},close:async()=>{}};
  const {store,worker}=await fixture(t,'sandbox',driver),a=merchant(store),{invoice}=store.createInvoice(store.merchant(a.merchant.id),payload(),'mismatch-1');
  store.patch(invoice.id,{status:'pending',provider_id:'bank-1',submitted:1});await worker.poll(store.invoice(invoice.id));assert.equal(store.invoice(invoice.id).status,'unknown');
});

test('Per-merchant queue serializes concurrent creation; other companies can progress',async t=>{
  const releases=[];let concurrent=0,max=0;
  const driver={create:async()=>{concurrent++;max=Math.max(max,concurrent);await new Promise(r=>releases.push(r));concurrent--;return {provider_id:crypto.randomUUID()};},close:async()=>{},poll:async()=> 'pending'};
  const {store,worker}=await fixture(t,'sandbox',driver),a=merchant(store),b=merchant(store,'Другая касса');
  store.createInvoice(store.merchant(a.merchant.id),payload(),'queue-first');store.createInvoice(store.merchant(a.merchant.id),payload({order_id:'second'}),'queue-second');store.createInvoice(store.merchant(b.merchant.id),payload(),'queue-third');
  worker.tick();assert.equal(releases.length,2);assert.equal(max,2);assert.equal(store.listInvoices(a.merchant.id).filter(i=>i.status==='processing').length,1);releases.forEach(r=>r());await Promise.all([...worker.active]);
});

test('Encryption binds stored session to merchant and detects tampering',()=>{
  const key=randomBytes(32),encrypted=seal({cookies:[{name:'session',value:'secret'}]},key,'merchant-a');
  assert.deepEqual(unseal(encrypted,key,'merchant-a').cookies[0].value,'secret');assert.throws(()=>unseal(encrypted,key,'merchant-b'));
  const broken=Buffer.from(encrypted,'base64');broken[15]^=1;assert.throws(()=>unseal(broken.toString('base64'),key,'merchant-a'));
});

test('Webhook signature validates raw bytes, event id and timestamp',()=>{
  const raw=Buffer.from('{"event_id":"event-1","type":"invoice.paid"}'),secret='a test secret',time='1900000000';
  const headers={'x-cashier-event':'event-1','x-cashier-timestamp':time,'x-cashier-signature':`v1=${signWebhook(secret,time,raw.toString())}`};
  assert.equal(verifyCashierWebhook(raw,headers,secret,1900000000).type,'invoice.paid');
  assert.throws(()=>verifyCashierWebhook(Buffer.from(raw.toString().replace('paid','void')),headers,secret,1900000000));
  assert.throws(()=>verifyCashierWebhook(raw,headers,secret,1900000600));
});

test('Outbox retries, signs stable event IDs and marks successful delivery',async t=>{
  const {store,c}=await fixture(t),a=store.createMerchant({name:'Webhook test',account_label:'Webhook test',webhook_url:'https://example.com/hooks'}),{invoice}=store.createInvoice(store.merchant(a.merchant.id),payload(),'webhook-1');
  store.patch(invoice.id,{status:'pending'});let count=0,eventId;
  const outbox=new Outbox(store,c,async(_url,body,headers)=>{const event=verifyCashierWebhook(Buffer.from(body),Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v])),a.webhook_secret);eventId||=event.event_id;assert.equal(event.event_id,eventId);if(!count++)throw new Error('offline');});
  await outbox.tick();let e=store.db.prepare('SELECT * FROM events').get();assert.equal(e.attempts,1);assert.equal(e.delivered_at,null);
  store.db.prepare('UPDATE events SET next_at=0').run();await outbox.tick();e=store.db.prepare('SELECT * FROM events').get();assert.ok(e.delivered_at);assert.equal(e.attempts,2);
});

test('Webhook destinations reject private networks and unapproved origins',()=>{
  const c={webhookOrigins:['https://example.com']};assert.doesNotThrow(()=>validateWebhookUrl('https://example.com/hooks',c));
  for(const u of ['http://example.com/hooks','https://127.0.0.1/a','https://evil.example/a','https://user:pass@example.com/a'])assert.throws(()=>validateWebhookUrl(u,c));
  for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','::1','198.18.0.1'])assert.equal(isPublicIPv4(ip),false);
  assert.equal(isPublicIPv4('8.8.8.8'),true);
});

test('Android mode fails closed without verified adapter, and sandbox endpoints do not exist',async t=>{
  const {app,store,driver}=await fixture(t,'android'),a=merchant(store);assert.equal(driver.capabilities().configured,false);
  const r=await app.inject({method:'POST',url:'/v1/invoices',headers:{authorization:`Bearer ${a.api_key}`,'idempotency-key':'live-guard-1'},payload:payload()});assert.equal(r.statusCode,409);assert.equal(store.listInvoices().length,0);
  assert.equal((await app.inject({method:'POST',url:'/sandbox/payments/token',payload:{state:'paid'}})).statusCode,404);
});

test('Admin login sets HttpOnly cookie, cross-origin writes fail, secrets returned only on creation',async t=>{
  const {app,c}=await fixture(t);
  assert.equal((await app.inject({url:'/admin/overview'})).statusCode,401);
  const login=await app.inject({method:'POST',url:'/admin/login',payload:{password:c.adminPassword}});assert.equal(login.statusCode,200);assert.match(login.headers['set-cookie'],/HttpOnly/);
  const cookie=login.headers['set-cookie'].split(';')[0];
  const r=await app.inject({method:'POST',url:'/admin/merchants',headers:{cookie},payload:{name:'Тест',account_label:'Тест',webhook_url:''}});assert.equal(r.statusCode,201);assert.ok(r.json().api_key);
  const overview=(await app.inject({url:'/admin/overview',headers:{cookie}})).json();assert.equal(overview.merchants[0].api_hash,undefined);assert.equal(overview.merchants[0].storage,undefined);assert.equal(overview.merchants[0].webhook_secret,undefined);
  assert.equal((await app.inject({method:'POST',url:'/admin/merchants',headers:{cookie,origin:'https://evil.example'},payload:{name:'Тест',account_label:'Тест'}})).statusCode,403);
});

test('Production refuses sandbox and requires secure configuration',()=>{
  assert.throws(()=>loadConfig({NODE_ENV:'production',ADMIN_PASSWORD:'x'.repeat(30),ENCRYPTION_KEY:randomBytes(32).toString('base64'),PUBLIC_BASE_URL:'https://example.com',DRIVER_MODE:'sandbox'}),/Sandbox/);
});

test('A paused merchant with more than 100 orders cannot starve another merchant',async t=>{
  const {store}=await fixture(t),a=merchant(store),b=merchant(store,'Second company');
  for(let n=0;n<101;n++)store.createInvoice(store.merchant(a.merchant.id),payload({order_id:'waiting-'+n}),'waiting-key-'+n);
  const {invoice}=store.createInvoice(store.merchant(b.merchant.id),payload(),'available-key');
  assert.equal(store.nextJob(new Set([a.merchant.id])).id,invoice.id);
});

test('Android panel: admin only, pauses worker, hides active QR and never audits entered text',async t=>{
  const input=[],client={screen:async()=>Buffer.from('test screen').toString('base64'),tap:async(x,y)=>input.push([x,y]),back:async()=>input.push('back'),typeActive:async text=>input.push(text)};
  const driver={capabilities:()=>({configured:true,phone:true,qr:true}),manualClient:async()=>client,disconnect:async()=>{},close:async()=>{}};
  const {app,store,c,worker}=await fixture(t,'android',driver),a=merchant(store),id=a.merchant.id;
  driver.verify=async()=>store.setMerchantState(id,'connected');
  store.bindDevice(id,{udid:'emulator-5554',system_port:8200});store.setMerchantState(id,'connected');
  const login=await app.inject({method:'POST',url:'/admin/login',payload:{password:c.adminPassword}});
  const headers={cookie:login.headers['set-cookie'].split(';')[0],origin:c.baseUrl};
  const url=`/admin/android/${id}`;
  assert.equal((await app.inject({url:url+'/screen'})).statusCode,401);
  assert.equal((await app.inject({url:url+'/screen',headers})).statusCode,409);
  const {invoice}=store.createInvoice(store.merchant(id),payload({method:'qr',customer_phone:undefined}),'manual-qr-key');
  store.patch(invoice.id,{status:'pending',submitted:1,provider_id:'qr-bank',qr_data:'old-qr',payment_url:'https://qr.kaspi.kz/test'});
  worker.busy.add(id);
  assert.equal((await app.inject({method:'POST',url:url+'/manual',headers})).statusCode,409);
  worker.busy.delete(id);
  assert.equal((await app.inject({method:'POST',url:url+'/manual',headers})).statusCode,200);
  assert.equal(store.merchant(id).state,'maintenance');assert.equal(store.invoice(invoice.id).status,'unknown');assert.equal(store.invoice(invoice.id).qr_data,null);
  worker.tick();assert.equal(worker.active.size,0);
  const screen=await app.inject({url:url+'/screen',headers});assert.equal(screen.statusCode,200);assert.equal(screen.headers['content-type'],'image/png');assert.equal(screen.headers['cache-control'],'no-store');
  assert.equal((await app.inject({method:'POST',url:url+'/input',headers,payload:{action:'tap',x:123,y:321}})).statusCode,200);
  await app.inject({method:'POST',url:url+'/input',headers,payload:{action:'text',text:'private-test-code'}});
  assert.deepEqual(input,[[123,321],'private-test-code']);assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM audit').all()).includes('private-test-code'),false);
  assert.equal((await app.inject({method:'POST',url:url+'/input',headers,payload:{action:'tap',x:-1,y:4}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:url+'/resume',headers})).statusCode,200);assert.equal(store.merchant(id).state,'connected');
  assert.equal((await app.inject({url:url+'/screen',headers})).statusCode,409);
});

test('Restart before the durable submit marker allows an explicit safe retry',async t=>{
  const {store}=await fixture(t),a=merchant(store),{invoice}=store.createInvoice(store.merchant(a.merchant.id),payload(),'before-submit-restart');
  store.patch(invoice.id,{status:'processing'});store.recover();assert.equal(store.invoice(invoice.id).status,'failed');store.retry(invoice.id);assert.equal(store.invoice(invoice.id).status,'queued');
});
