import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { KaspiDriver } from '../src/drivers/kaspi.js';
import { Worker } from '../src/worker.js';
import { createIdentity } from '../src/kaspi/protocol.js';
import { invoiceSchema, loadConfig } from '../src/config.js';

function fixture(t,request,liveEnabled=true){
 const config={mode:'kaspi',production:false,key:randomBytes(32),adminPassword:randomBytes(24).toString('base64url'),baseUrl:'http://127.0.0.1:3080',dataDir:mkdtempSync(path.join(tmpdir(),'kaspi-')),pollMs:1000,liveEnabled,webhookOrigins:[]};
 const store=new Store(config),driver=new KaspiDriver(config,store,{request});
 const merchant=store.createMerchant({name:'Test company',account_label:'Test company',webhook_url:''}).merchant;
 t.after(async()=>{await driver.close();store.close();rmSync(config.dataDir,{recursive:true,force:true});});
 return {config,store,driver,merchant,worker:new Worker(store,driver,config)};
}
const response=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
function connect(f){f.driver.save(f.merchant.id,{identity:createIdentity(),session:{tokenSN:'secret-token',vtokenSecret:randomBytes(32).toString('base64'),profileId:12,orgName:'Test company'}});f.store.setMerchantState(f.merchant.id,'connected');f.merchant=f.store.merchant(f.merchant.id);}
function invoice(f,method='phone'){return f.store.createInvoice(f.merchant,invoiceSchema.parse({order_id:'order-1',amount:100,currency:'KZT',method,...(method==='phone'?{customer_phone:'+77001234567'}:{})}),'kaspi-order-1').invoice;}

test('Kaspi: admin-only SMS flow, ECDH activation, server encryption, exact company binding',async t=>{
 const pub=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'der'}).toString('base64');
 const calls=[];const f=fixture(t,async(url,init)=>{
  calls.push(url);const body=JSON.parse(init.body);
  if(url.includes('/entrance/step')){
   if(body.meta?.sn==='EnterPhoneNumber')return response({view:{code:'EnterOtp'}});
   if(body.meta?.sn==='ViewEnterOtp')return response({data:{type:'kpDeviceRegistration'}});
   return response({meta:{pId:'process-secret'}});
  }
  if(url.endsWith('/finish'))return response({success:true,data:{tokenSN:'secret-token',x509:pub}});
  return response({Data:{Current:{ProfileId:12,OrganizationName:'Test company',OrganizationId:4}}});
 });
 const app=await buildApp(f.config,{logger:false,background:false,store:f.store,driver:f.driver});t.after(()=>app.close());
 const start=`/admin/kaspi/${f.merchant.id}/start`;
 assert.equal((await app.inject({method:'POST',url:start,payload:{phone:'+77001234567'}})).statusCode,401);
 assert.equal(calls.length,0);
 const login=await app.inject({method:'POST',url:'/admin/login',payload:{password:f.config.adminPassword}});const headers={cookie:login.headers['set-cookie'].split(';')[0]};
 assert.equal((await app.inject({method:'POST',url:start,headers:{...headers,origin:'https://evil.test'},payload:{phone:'+77001234567'}})).statusCode,403);
 assert.deepEqual((await app.inject({method:'POST',url:start,headers,payload:{phone:'+77001234567'}})).json(),{sms_sent:true});
 const done=await app.inject({method:'POST',url:`/admin/kaspi/${f.merchant.id}/verify`,headers,payload:{otp:'123456'}});
 assert.deepEqual(done.json(),{connected:true});
 const overview=(await app.inject({url:'/admin/overview',headers})).body;
 for(const secret of ['secret-token','vtokenSecret','process-secret','123456'])assert.ok(!overview.includes(secret));
 const encrypted=f.store.db.prepare('SELECT encrypted FROM kaspi_accounts').get().encrypted;assert.ok(!encrypted.includes('secret-token'));
 assert.equal(f.driver.account(f.merchant.id).session.profileId,12);
 invoice(f);
 await app.inject({method:'POST',url:`/admin/merchants/${f.merchant.id}/disconnect`,headers});assert.equal(f.driver.account(f.merchant.id).session,undefined);
 assert.equal(f.driver.account(f.merchant.id).binding.profileId,12);
 assert.deepEqual((await app.inject({method:'POST',url:start,headers,payload:{phone:'+77001234567'}})).json(),{sms_sent:true});
 assert.deepEqual((await app.inject({method:'POST',url:`/admin/kaspi/${f.merchant.id}/verify`,headers,payload:{otp:'123456'}})).json(),{connected:true});
});

test('Kaspi: durable submit marker survives network loss and replay never resends',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;assert.equal(f.store.listInvoices()[0].submitted,1);throw new Error('sensitive remote error');});connect(f);const i=invoice(f);
 await f.worker.create(i);assert.equal(calls,1);assert.equal(f.store.invoice(i.id).status,'unknown');assert.equal(f.store.invoice(i.id).error_code,'KASPI_NETWORK_ERROR');
 assert.throws(()=>f.store.retry(i.id));f.store.recover();assert.equal(f.store.invoice(i.id).status,'unknown');
 const replay=f.store.createInvoice(f.merchant,invoiceSchema.parse({order_id:'order-1',amount:100,method:'phone',customer_phone:'+77001234567'}),'kaspi-order-1');assert.equal(replay.replay,true);assert.equal(calls,1);
});

test('Kaspi: QR generated locally, exact payload, bank evidence required before paid',async t=>{
 let status={QrOperationId:42,Amount:100,Currency:'KZT',ProfileId:12,Status:'Processed'};
 const f=fixture(t,async(url,init)=>{
  assert.ok(new URL(url).hostname==='qrpay.kaspi.kz');
  if(init.method==='POST')return response({StatusCode:0,Data:{QrOperationId:42,QrToken:'https://qr.kaspi.kz/test'}});
  return response({StatusCode:0,Data:status});
 });connect(f);const i=invoice(f,'qr');await f.worker.create(i);const pending=f.store.invoice(i.id);
 assert.equal(pending.status,'pending');assert.equal(pending.payment_url,'https://qr.kaspi.kz/test');assert.equal(Buffer.from(pending.qr_data,'base64').subarray(1,4).toString(),'PNG');
 status={...status,Amount:101};await f.worker.poll(pending);assert.equal(f.store.invoice(i.id).status,'unknown');
 status={...status,Amount:100,Status:'Unrecognized'};await f.worker.poll(f.store.invoice(i.id));assert.equal(f.store.invoice(i.id).status,'unknown');
 status={...status,Status:'Processed'};await f.worker.poll(f.store.invoice(i.id));assert.equal(f.store.invoice(i.id).status,'paid');
});

test('Kaspi: disabled live mode makes no requests, disconnected merchant stays off queue',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;},false);connect(f);const i=invoice(f);await f.worker.create(i);assert.equal(calls,0);assert.equal(f.store.invoice(i.id).submitted,0);
 f.store.setMerchantState(f.merchant.id,'disconnected');f.store.retry(i.id);f.worker.tick();assert.equal(f.store.invoice(i.id).status,'queued');
});

test('Kaspi: wrong company and invalid QR do not expose a payment',async t=>{
 const f=fixture(t,async()=>response({Data:{QrOperationId:42,QrToken:'https://evil.test/qr'}}));connect(f);
 const a=f.driver.account(f.merchant.id);f.driver.save(f.merchant.id,{...a,session:{...a.session,orgName:'Other'}});
 const i=invoice(f,'qr');await f.worker.create(i);assert.equal(f.store.invoice(i.id).submitted,0);
 f.driver.save(f.merchant.id,a);f.store.retry(i.id);await f.worker.create(f.store.invoice(i.id));const failed=f.store.invoice(i.id);
 assert.equal(failed.status,'unknown');assert.equal(failed.provider_id,'42');assert.equal(failed.qr_data,null);
});

test('Kaspi: configuration accepts direct connector but production still rejects sandbox',()=>{
 const env={ENCRYPTION_KEY:randomBytes(32).toString('base64'),ADMIN_PASSWORD:'a'.repeat(24),DRIVER_MODE:'kaspi',NODE_ENV:'production',PUBLIC_BASE_URL:'https://cashier.example.com'};
 assert.equal(loadConfig(env).mode,'kaspi');assert.throws(()=>loadConfig({...env,DRIVER_MODE:'sandbox'}));
});
