import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';

async function fixture(t){const schema='test_'+randomUUID().replaceAll('-',''),dataDir=await mkdtemp(join(tmpdir(),'mbusiness-retail-'));process.env.MBUSINESS_BRIDGE_SECRET=randomBytes(32).toString('hex');const app=await createApp({schema,dataDir});const origin=await app.listen({host:'127.0.0.1',port:0});t.after(async()=>{await app.db.exec(`DROP SCHEMA "${schema}" CASCADE`);await app.close();await rm(dataDir,{recursive:true,force:true});delete process.env.MBUSINESS_BRIDGE_SECRET;});
 const http=async(path,method='GET',body,headers={})=>{const r=await fetch(origin+path,{method,headers:{'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
 const owner=async name=>{const id=randomUUID();const r=await http('/internal/mbusiness/session','POST',{userId:randomUUID(),companyId:id,login:'synthetic.'+name,companyName:'Synthetic '+name},{'x-mbusiness-bridge-key':process.env.MBUSINESS_BRIDGE_SECRET});assert.equal(r.status,200);const token=r.data.token;return {id,token,call:(path,method='GET',body,key)=>http('/v1/companies/'+id+path,method,body,{authorization:'Bearer '+token,...(key?{'idempotency-key':key}:{})})};};
 const a=await owner('one'),b=await owner('two');
 const ok=async(path,body,key)=>{const r=await a.call(path,'POST',body,key||randomUUID());assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
 assert.equal((await a.call('/settings','PUT',{version:0,identifier:null,legalName:'Synthetic retail',legalForm:'TOO',taxRegime:'GENERAL',vatRegistered:false},randomUUID())).status,200);
 const wh=await ok('/resources/warehouses',{data:{name:'Synthetic warehouse'}}),wallet=await ok('/wallets',{name:'Synthetic till',scope:'ACCOUNTING'}),product=await ok('/retail/products',{name:'Synthetic product',barcode:'4006381333931',unit:'шт.',priceMinor:10000});
 await ok('/inventory/receipts',{productId:product.id,warehouseId:wh.id,quantity:10,unitCost:4000});
 const base={warehouseId:wh.id,scope:'ACCOUNTING',walletId:wallet.id,items:[{productId:product.id,quantity:2}],expectedTotal:20000,method:'cash',paymentConfirmed:true,tendered:25000};
 return {app,http,origin,a,b,ok,wh,wallet,product,base};}

test('Retail checkout shares goods accounting, calculates change atomically and safely replays',async t=>{const f=await fixture(t);const preview=await f.ok('/retail/preview',f.base);assert.equal(preview.total,20000);assert.equal(preview.vat,0);
 const sale=await f.ok('/retail/sales',f.base,'retail-one-command'),repeat=await f.ok('/retail/sales',f.base,'retail-one-command');assert.equal(sale.id,repeat.id);assert.equal(sale.change_amount,5000);assert.equal(sale.order.status,'CLOSED');assert.equal(sale.order.paid,20000);
 const balance=(await f.a.call('/wallets')).data.items[0].balance;assert.equal(balance,20000);
 const stock=(await f.a.call('/retail/barcode?warehouseId='+f.wh.id+'&barcode=4006381333931')).data;assert.equal(stock.quantity,8);assert.equal(stock.available,8);
 assert.equal((await f.app.db.prepare('SELECT count(*) n FROM retail_sales').get()).n,1);assert.equal((await f.a.call('/orders')).data.items.length,1);
 const loaded=(await f.a.call('/retail/sales/by-key?key=retail-one-command')).data;assert.equal(loaded.id,sale.id);
 assert.equal((await f.b.call('/retail/sales/'+sale.id)).status,404);assert.equal((await f.b.call('/retail/barcode?warehouseId='+f.wh.id+'&barcode=4006381333931')).status,404);
 assert.equal((await f.a.call('/retail/sales','POST',{...f.base,tendered:30000},'retail-one-command')).status,409);
});

test('Retail price tampering, shortages, unconfirmed payments and parallel overselling cannot change money partially',async t=>{const f=await fixture(t),before=(await f.app.db.prepare('SELECT count(*) n FROM journal').get()).n;
 for(const body of [{...f.base,expectedTotal:1},{...f.base,paymentConfirmed:false},{...f.base,tendered:1},{...f.base,items:[{productId:f.product.id,quantity:11}],expectedTotal:110000,tendered:120000}]){const r=await f.a.call('/retail/sales','POST',body,randomUUID());assert.ok([400,409].includes(r.status),JSON.stringify(r.data));}
 assert.equal((await f.app.db.prepare('SELECT count(*) n FROM orders').get()).n,0);assert.equal((await f.app.db.prepare('SELECT count(*) n FROM journal').get()).n,before);assert.equal((await f.a.call('/wallets')).data.items[0].balance,0);
 const body={...f.base,items:[{productId:f.product.id,quantity:7}],expectedTotal:70000,tendered:70000};const sales=await Promise.all([f.a.call('/retail/sales','POST',body,'parallel-sale-1'),f.a.call('/retail/sales','POST',body,'parallel-sale-2')]);assert.equal(sales.filter(r=>r.status===200).length,1);assert.equal(sales.filter(r=>r.status===409).length,1);assert.equal((await f.a.call('/wallets')).data.items[0].balance,70000);
});

test('Retail uses catalogue prices and native VAT, enforces barcode uniqueness and rejects ambiguous legacy barcodes',async t=>{const f=await fixture(t);
 assert.equal((await f.a.call('/retail/products','POST',{name:'Duplicate',barcode:'4006381333931',priceMinor:1},randomUUID())).status,409);
 await f.ok('/resources/nomenklatura',{data:{name:'Legacy duplicate',barcode:'4006381333931',priceMinor:90000}});assert.equal((await f.a.call('/retail/barcode?warehouseId='+f.wh.id+'&barcode=4006381333931')).status,409);
 const other=await f.ok('/retail/products',{name:'VAT product',barcode:'0001234567890',priceMinor:10000});await f.ok('/inventory/receipts',{productId:other.id,warehouseId:f.wh.id,quantity:2,unitCost:100});
 const settings=(await f.a.call('/settings')).data;assert.equal((await f.a.call('/settings','PUT',{version:settings.version,identifier:null,legalName:settings.legal_name,legalForm:'TOO',taxRegime:'GENERAL',vatRegistered:true},randomUUID())).status,200);
 const body={...f.base,items:[{productId:other.id,quantity:1,unitPrice:1}],expectedTotal:11600,tendered:12000};const preview=await f.ok('/retail/preview',body);assert.equal(preview.total,11600);assert.equal(preview.net,10000);assert.equal(preview.vat,1600);const sale=await f.ok('/retail/sales',body);assert.equal(sale.order.data.vat,1600);assert.equal(sale.change_amount,400);
});

test('Revision preserves uncounted positions, exposes live facts, distinguishes stock movements and does not adjust stock on finish',async t=>{const f=await fixture(t),r=await f.ok('/retail/counts',{warehouseId:f.wh.id,name:'Synthetic revision'});assert.equal(r.lines[0].expected,10);assert.equal(r.lines[0].counted,null);assert.equal(r.lines[0].difference,null);
 const createdId=r.session.id;assert.equal((await f.b.call('/retail/counts/'+createdId)).status,404);
 const line=await f.ok('/retail/counts/'+createdId+'/lines',{productId:f.product.id,quantity:8,mode:'replace',version:0},'count-unique-key');assert.equal(line.line.difference,-2);const replay=await f.ok('/retail/counts/'+createdId+'/lines',{productId:f.product.id,quantity:8,mode:'replace',version:0},'count-unique-key');assert.equal(replay.line.counted,8);
 assert.equal((await f.a.call('/retail/counts/'+createdId+'/lines','POST',{productId:f.product.id,quantity:9,mode:'replace',version:0},randomUUID())).status,409);
 await Promise.all([f.ok('/retail/counts/'+createdId+'/lines',{productId:f.product.id,quantity:1,mode:'add'},'count-add-one'),f.ok('/retail/counts/'+createdId+'/lines',{productId:f.product.id,quantity:1,mode:'add'},'count-add-two')]);
 let report=(await f.a.call('/retail/counts/'+createdId)).data;assert.equal(report.lines[0].counted,10);assert.equal(report.totals.differences,0);
 await f.ok('/retail/sales',f.base);report=(await f.a.call('/retail/counts/'+createdId)).data;assert.equal(report.lines[0].expected,10);assert.equal(report.lines[0].current_book,8);assert.equal(report.totals.moved,1);
 assert.equal((await f.a.call('/retail/counts/'+createdId+'/finish','POST',{version:report.session.version},randomUUID())).status,409);const done=await f.ok('/retail/counts/'+createdId+'/finish',{version:report.session.version,acceptMovements:true});assert.equal(done.session.status,'FINISHED');
 assert.equal((await f.a.call('/retail/barcode?warehouseId='+f.wh.id+'&barcode=4006381333931')).data.quantity,8);assert.equal((await f.a.call('/retail/counts/'+createdId+'/lines','POST',{productId:f.product.id,quantity:0,mode:'add'},randomUUID())).status,409);
 const partial=await f.ok('/retail/counts',{warehouseId:f.wh.id,name:'Partial revision'});assert.equal((await f.a.call('/retail/counts/'+partial.session.id+'/finish','POST',{version:1},randomUUID())).status,409);const closed=await f.ok('/retail/counts/'+partial.session.id+'/finish',{version:1,acceptPartial:true});assert.equal(closed.lines[0].counted,null);
});

test('One-time revision devices cannot access another revision or the cashier and can be revoked',async t=>{const f=await fixture(t),r=await f.ok('/retail/counts',{warehouseId:f.wh.id,name:'Device revision'}),pair=await f.ok('/retail/counts/'+r.session.id+'/pair',{name:'Synthetic phone'});
 const bridge={'x-mbusiness-bridge-key':process.env.MBUSINESS_BRIDGE_SECRET};assert.equal((await f.http('/internal/retail/device/join','POST',{code:pair.code})).status,401);
 const joined=await f.http('/internal/retail/device/join','POST',{code:pair.code},bridge);assert.equal(joined.status,200);assert.equal((await f.http('/internal/retail/device/join','POST',{code:pair.code},bridge)).status,401);
 const headers={...bridge,'x-retail-device-token':joined.data.token};const session=await f.http('/internal/retail/device/session','GET',null,headers);assert.equal(session.data.session.id,r.session.id);assert.equal(session.data.device.name,'Synthetic phone');
 const lookup=await f.http('/internal/retail/device/barcode?barcode=4006381333931','GET',null,headers);assert.equal(lookup.data.product.priceMinor,undefined);
 const body={barcode:'4006381333931',quantity:3,mode:'add'},key={'idempotency-key':'phone-add-one'};const saved=await f.http('/internal/retail/device/line','POST',body,{...headers,...key});assert.equal(saved.status,200,JSON.stringify(saved.data));const replay=await f.http('/internal/retail/device/line','POST',body,{...headers,...key});assert.equal(replay.data.line.counted,3);
 const leader=(await f.a.call('/retail/counts/'+r.session.id)).data;assert.equal(leader.lines[0].counted,3);assert.equal(leader.lines[0].actor_name,'Synthetic phone');
 assert.equal((await f.http('/v1/companies/'+f.a.id+'/retail/sales','POST',f.base,{'authorization':'Bearer '+joined.data.token,'idempotency-key':randomUUID()})).status,401);
 await f.ok('/retail/counts/'+r.session.id+'/devices/'+pair.id+'/revoke',{});assert.equal((await f.http('/internal/retail/device/session','GET',null,headers)).status,401);
});
