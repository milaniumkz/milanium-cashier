import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { AndroidDriver } from '../src/drivers/android.js';
import { AppiumClient } from '../src/drivers/appium-client.js';
import { Store } from '../src/db.js';
import { invoiceSchema } from '../src/config.js';
import { Worker } from '../src/worker.js';

const selector=value=>({using:'id',value});
function config(){const op={navigation:[],amount:selector('amountInput'),phone:selector('phone'),reference:selector('refInput'),submit:selector('submit'),result:selector('result'),provider_id:selector('provider')};const ev={provider_id:selector('provider'),amount:selector('amount'),currency:selector('currency'),reference:selector('reference'),state:selector('state'),states:{paid:'PAID',pending:'PENDING',declined:'DECLINED',expired:'EXPIRED'}};return {version:1,verified:true,app_package:'example.cashier',app_activity:'.Main',ready:selector('ready'),account:selector('account'),home:[],phone:op,qr:{...op,qr:selector('qr'),live_status:ev},history:{navigation:[],search:selector('search'),open_result:selector('open'),details:ev},payment_origins:['https://qr.kaspi.kz']};}
async function setup(t){
  const dir=mkdtempSync(path.join(tmpdir(),'android-driver-')),file=path.join(dir,'android.json');writeFileSync(file,JSON.stringify(config()));
  const c={mode:'android',key:randomBytes(32),dataDir:dir,connectorPath:file,liveEnabled:true,appiumUrl:'http://127.0.0.1:4723',baseUrl:'http://127.0.0.1:3080',pollMs:1000};
  const store=new Store(c),a=store.createMerchant({name:'Company A',account_label:'Company A',webhook_url:''});store.bindDevice(a.merchant.id,{udid:'emulator-5554',system_port:8200});store.setMerchantState(a.merchant.id,'connected');
  const values={account:'Company A',provider:'bank-1',amount:'15000',currency:'KZT',state:'PENDING'};let clicks=0;
  const qr=(await QRCode.toDataURL('https://qr.kaspi.kz/test-payment')).split(',')[1];
  const client={sessionId:'session-1',start:async()=>{},activate:async()=>{},navigate:async()=>{},find:async()=> 'element',text:async s=>values[s.value]||'',fill:async(s,v)=>values[s.value]=v,click:async s=>{if(s.value==='submit'){assert.equal(store.listInvoices()[0].submitted,1);clicks++;}},screenshot:async()=>qr,close:async()=>{}};
  const driver=new AndroidDriver(c,store,()=>client),worker=new Worker(store,driver,c);
  t.after(async()=>{await driver.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const create=(method='phone',order='order-1')=>{const v=invoiceSchema.parse({order_id:order,amount:15000,method,customer_phone:method==='phone'?'+77001234567':undefined});const {invoice}=store.createInvoice(store.merchant(a.merchant.id),v,'key-'+order);values.reference=invoice.id;return invoice;};
  return {store,driver,worker,values,client,create,c,a,clicks:()=>clicks};
}
test('Android phone flow: marker before tap, exact inputs, provider ID and confirmed payment',async t=>{
  const x=await setup(t),i=x.create();await x.worker.create(i);assert.equal(x.clicks(),1);assert.equal(x.values.phone,'+77001234567');assert.equal(x.values.refInput,i.id);assert.equal(x.store.invoice(i.id).status,'pending');
  x.values.state='PAID';await x.worker.poll(x.store.invoice(i.id));assert.equal(x.store.invoice(i.id).status,'paid');
});
test('Android QR: decodes real QR payload, returns exact link and reserves the device',async t=>{
  const x=await setup(t),i=x.create('qr');await x.worker.create(i);const p=x.store.invoice(i.id);assert.equal(p.status,'pending');assert.equal(p.payment_url,'https://qr.kaspi.kz/test-payment');assert.ok(p.qr_data);assert.equal(x.driver.canPoll({merchant_id:i.merchant_id,id:'other'}),false);assert.ok(x.store.blockedMerchants().includes(i.merchant_id));
  x.values.state='PAID';await x.worker.poll(p);assert.equal(x.driver.blockedMerchants().size,0);
});
test('Android wrong company blocks all submit actions',async t=>{
  const x=await setup(t),i=x.create();x.values.account='Other company';await x.worker.create(i);assert.equal(x.clicks(),0);assert.equal(x.store.invoice(i.id).status,'failed');assert.equal(x.store.invoice(i.id).error_code,'WRONG_MERCHANT');
});
test('Android failure after tap remains unknown, never automatically reissued',async t=>{
  const x=await setup(t),i=x.create();const original=x.client.click;x.client.click=async s=>{await original(s);throw new Error('connection lost');};await x.worker.create(i);assert.equal(x.store.invoice(i.id).status,'unknown');assert.throws(()=>x.store.retry(i.id));assert.ok(x.store.blockedMerchants().includes(i.merchant_id));
});
test('A black/protected QR screen fails closed without fabricating a payment link',async t=>{
  const x=await setup(t),i=x.create('qr');x.client.screenshot=async()=>Buffer.from('invalid screenshot').toString('base64');await x.worker.create(i);const p=x.store.invoice(i.id);assert.equal(p.status,'unknown');assert.equal(p.error_code,'QR_CAPTURE_UNAVAILABLE');assert.equal(p.payment_url,null);assert.equal(p.provider_id,'bank-1');
});
test('Android status evidence mismatch cannot confirm another order',async t=>{
  const x=await setup(t),i=x.create();await x.worker.create(i);x.values.reference='another order';x.values.state='PAID';await x.worker.poll(x.store.invoice(i.id));assert.equal(x.store.invoice(i.id).status,'unknown');
});
test('One Android and one automation port cannot be shared across companies',async t=>{
  const x=await setup(t),b=x.store.createMerchant({name:'Company B',account_label:'Company B',webhook_url:''});
  assert.throws(()=>x.store.bindDevice(b.merchant.id,{udid:'emulator-5554',system_port:8201}),/другой компании/);
  assert.throws(()=>x.store.bindDevice(b.merchant.id,{udid:'emulator-5556',system_port:8200}),/Порт/);
});
test('QR recovery hides stale QR and preserves the original bank operation for reconciliation',async t=>{
  const x=await setup(t),i=x.create('qr');await x.worker.create(i);x.store.recover();const p=x.store.invoice(i.id);assert.equal(p.status,'unknown');assert.equal(p.provider_id,'bank-1');assert.equal(p.qr_data,null);assert.equal(p.payment_url,null);
});
test('W3C Appium client sends no-reset capabilities, addresses exact udid and standard input commands',async()=>{
  const calls=[];const transport=async(url,options)=>{calls.push({url,...options,body:options.body&&JSON.parse(options.body)});let value=null;if(url.endsWith('/session')&&options.method==='POST')value={sessionId:'s1'};if(url.endsWith('/elements'))value=[{'element-6066-11e4-a52e-4f735466cecf':'e1'}];if(url.endsWith('/displayed'))value=true;return {ok:true,json:async()=>({value})};};
  const client=new AppiumClient('http://127.0.0.1:4723',transport);await client.start({udid:'emulator-5554',system_port:8200},config());await client.fill(selector('phone'),'+77001234567');
  assert.equal(calls[0].body.capabilities.alwaysMatch['appium:noReset'],true);assert.equal(calls[0].body.capabilities.alwaysMatch['appium:udid'],'emulator-5554');assert.deepEqual(calls.at(-1).body,{text:'+77001234567'});assert.match(calls.at(-1).url,/\/session\/s1\/element\/e1\/value$/);await client.close();
});

test('Manual Android login works before selectors are verified; real invoices remain disabled',async t=>{
  const x=await setup(t);writeFileSync(x.c.connectorPath,JSON.stringify({verified:false,app_package:'example.cashier',app_activity:'.Main'}));
  assert.equal(x.driver.capabilities().configured,false);
  assert.equal(await x.driver.manualClient(x.store.merchant(x.a.merchant.id)),x.client);
});

test('Pausing automation hides the QR immediately and preserves its bank ID',async t=>{
  const x=await setup(t),i=x.create('qr');await x.worker.create(i);x.store.disconnect(i.merchant_id);
  const current=x.store.invoice(i.id);assert.equal(current.status,'unknown');assert.equal(current.qr_data,null);assert.equal(current.payment_url,null);assert.equal(current.provider_id,'bank-1');
});
