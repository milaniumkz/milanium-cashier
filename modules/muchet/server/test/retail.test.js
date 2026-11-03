import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';

async function fixture(t,options={}){const schema='test_'+randomUUID().replaceAll('-',''),dataDir=await mkdtemp(join(tmpdir(),'mbusiness-retail-'));process.env.MBUSINESS_BRIDGE_SECRET=randomBytes(32).toString('hex');const app=await createApp({...options,schema,dataDir});const origin=await app.listen({host:'127.0.0.1',port:0});t.after(async()=>{await app.db.exec(`DROP SCHEMA "${schema}" CASCADE`);await app.close();await rm(dataDir,{recursive:true,force:true});delete process.env.MBUSINESS_BRIDGE_SECRET;});
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

test('Scanned product intake reuses the catalogue, adds stock once and rejects stale scans or foreign warehouses atomically',async t=>{
 const f=await fixture(t),lookup=await f.a.call('/retail/products/by-barcode?barcode=4006381333931');assert.equal(lookup.data.id,f.product.id);assert.equal(lookup.data.name,'Synthetic product');
 const body={barcode:'0012345678905',name:'New scanned item',priceMinor:25000,unit:'шт.',quantity:3,unitCost:10000,warehouseId:f.wh.id,scope:'ACCOUNTING',stockConfirmed:true,businessDate:'2026-11-03'};
 const saved=await f.ok('/retail/intake',body,'scan-intake-one'),again=await f.ok('/retail/intake',body,'scan-intake-one');assert.equal(saved.receipt.id,again.receipt.id);assert.equal((await f.a.call('/retail/barcode?warehouseId='+f.wh.id+'&barcode=0012345678905')).data.quantity,3);
 assert.equal((await f.a.call('/retail/intake','POST',body,randomUUID())).status,409);
 await f.ok('/retail/intake',{...body,existingId:saved.id,version:saved.product.version,quantity:2},'scan-intake-two');assert.equal((await f.a.call('/retail/barcode?warehouseId='+f.wh.id+'&barcode=0012345678905')).data.quantity,5);
 assert.equal((await f.a.call('/retail/intake','POST',{...body,barcode:'bad-warehouse-code',warehouseId:randomUUID()},randomUUID())).status,404);assert.equal((await f.a.call('/retail/products/by-barcode?barcode=bad-warehouse-code')).status,404);
 assert.equal((await f.b.call('/retail/products/by-barcode?barcode=0012345678905')).status,404);
 const kaspi=await f.ok('/retail/sales',{...f.base,method:'kaspi'});assert.equal(kaspi.method,'terminal');assert.equal(kaspi.channel,'kaspi');
});
async function terminalFixture(t,options={}){const f=await fixture(t,options);const created=await f.ok('/retail/terminals',{name:'Synthetic Kaspi',kind:'kaspi',model:'Synthetic protocol fixture',connection:'usb'});const headers={'x-mbusiness-bridge-key':process.env.MBUSINESS_BRIDGE_SECRET,'x-retail-terminal-token':created.token};
 const poll=()=>f.http('/internal/retail/terminal/poll','POST',{protocol:1,ready:true,driver:'Synthetic test driver'},headers);
 const result=body=>f.http('/internal/retail/terminal/result','POST',body,headers);return {...f,terminal:created,poll,result,headers};}
test('Terminal credentials are scoped and hashed, online driver is required and queued cancellation releases reservations',async t=>{const f=await terminalFixture(t);
 assert.equal((await f.a.call('/retail/terminals')).data.items[0].token,undefined);assert.equal(JSON.stringify(await f.app.db.prepare('SELECT * FROM idempotency WHERE company_id=?').all(f.a.id)).includes(f.terminal.token),false);assert.notEqual((await f.app.db.prepare('SELECT token_hash FROM retail_terminals WHERE id=?').get(f.terminal.id)).token_hash,f.terminal.token);
 const body={...f.base,terminalId:f.terminal.id};assert.equal((await f.a.call('/retail/terminal-payments','POST',body,randomUUID())).status,409);await f.poll();
 const p=await f.ok('/retail/terminal-payments',body,'terminal-start');assert.equal(p.state,'QUEUED');assert.equal((await f.a.call('/retail/barcode?warehouseId='+f.wh.id+'&barcode=4006381333931')).data.available,8);assert.equal((await f.a.call('/wallets')).data.items[0].balance,0);
 assert.equal((await f.b.call('/retail/terminal-payments/'+p.id)).status,404);assert.equal((await f.a.call('/orders/'+p.order_id+'/cancel','POST',{},randomUUID())).status,409);assert.equal((await f.a.call('/retail/terminals/'+f.terminal.id+'/revoke','POST',{},randomUUID())).status,409);
 const cancelled=await f.ok('/retail/terminal-payments/'+p.id+'/cancel',{});assert.equal(cancelled.state,'CANCELLED');assert.equal((await f.a.call('/retail/barcode?warehouseId='+f.wh.id+'&barcode=4006381333931')).data.available,10);
});
test('Terminal dispatch is at most once; ambiguous results hold stock and verified approval settles exactly one sale',async t=>{const f=await terminalFixture(t);await f.poll();const p=await f.ok('/retail/terminal-payments',{...f.base,terminalId:f.terminal.id},'terminal-pay-one');
 assert.equal((await f.poll()).data.command.operation,'pay');assert.equal((await f.poll()).data.command.operation,'status');
 assert.equal((await f.result({id:p.id,status:'approved',amount:1,currency:'KZT',bankReference:'synthetic-bank-reference'})).status,409);
 await f.result({id:p.id,status:'unknown',amount:p.amount,currency:p.currency});assert.equal((await f.a.call('/retail/terminal-payments/'+p.id)).data.state,'UNKNOWN');assert.equal((await f.a.call('/retail/terminal-payments/'+p.id+'/cancel','POST',{},randomUUID())).status,409);
 const approved={id:p.id,status:'approved',amount:p.amount,currency:p.currency,bankReference:'synthetic-bank-reference'};assert.equal((await f.result(approved)).data.state,'COMPLETED');assert.equal((await f.result(approved)).data.state,'COMPLETED');const stored=(await f.a.call('/retail/terminal-payments/'+p.id)).data;assert.equal(stored.sale.channel,'kaspi');assert.equal(stored.sale.order.paid,20000);assert.equal((await f.a.call('/wallets')).data.items[0].balance,20000);assert.equal((await f.app.db.prepare('SELECT count(*) n FROM retail_sales').get()).n,1);assert.equal((await f.poll()).data.command,null);
 assert.equal((await f.result({...approved,status:'declined'})).status,409);
});
test('Bank approval survives accounting failure; retry finalizes accounting without another terminal payment',async t=>{const f=await terminalFixture(t);await f.poll();const p=await f.ok('/retail/terminal-payments',{...f.base,terminalId:f.terminal.id},'terminal-paid-recovery');await f.poll();await f.app.db.prepare("UPDATE orders SET status='CANCELLED' WHERE id=?").run(p.order_id);
 assert.equal((await f.result({id:p.id,status:'approved',amount:p.amount,currency:p.currency,bankReference:'synthetic-approved-unposted'})).data.state,'PAID');assert.equal((await f.poll()).data.command,null);assert.equal((await f.a.call('/wallets')).data.items[0].balance,0);
 await f.app.db.prepare("UPDATE orders SET status='RESERVED' WHERE id=?").run(p.order_id);const completed=await f.ok('/retail/terminal-payments/'+p.id+'/finalize',{});assert.equal(completed.state,'COMPLETED');assert.equal((await f.ok('/retail/terminal-payments/'+p.id+'/finalize',{})).sale.id,completed.sale.id);assert.equal((await f.a.call('/wallets')).data.items[0].balance,20000);
});

function syntheticFiscal(provider,{loseResponse=false,tamper=false}={}){const checks=[],requests=[];let lost=false;const transport=async r=>{requests.push(r);const path=new URL(r.url).pathname;
 if(provider==='webkassa'){
  if(path.endsWith('/Authorize'))return {status:200,data:{Data:{Token:'synthetic-fiscal-session'}}};
  if(path.endsWith('/Cashboxes'))return {status:200,data:{Data:[{UniqueNumber:'TEST-WK',Name:'Synthetic Webkassa'}]}};
  if(path.endsWith('/check')){const receipt={CheckNumber:123456789,ExternalCheckNumber:r.body.ExternalCheckNumber,Total:tamper?1:r.body.Payments[0].Sum,ShiftNumber:1,Cashbox:{UniqueNumber:'TEST-WK',RegistrationNumber:'SYNTHETIC-RNM'},DateTime:'03.11.2026 15:00:00',TicketUrl:'https://example.com/synthetic-fiscal-ticket'};checks.push(receipt);if(loseResponse&&!lost){lost=true;throw new Error('Synthetic lost response');}return {status:200,data:{Data:receipt}};}
  if(path.endsWith('/XReport'))return {status:200,data:{Data:{ShiftNumber:1}}};
  if(path.endsWith('/Check/History'))return {status:200,data:{Data:checks.map(c=>({ExternalCheckNumber:c.ExternalCheckNumber,Number:c.CheckNumber}))}};
  if(path.endsWith('/Check/HistoryByNumber'))return {status:200,data:{Data:checks[0]}};
 }else{
  if(path.endsWith('/api/auth/login'))return {status:200,data:{token:'synthetic-rekassa-token',id:'123'}};
  if(path.endsWith('/api/crs/123'))return {status:200,data:{id:'123',name:'Synthetic reKassa'}};
  if(path.endsWith('/tickets')){checks.push(r.body);return {status:201,data:{status:'OK',id:'synthetic-ticket-'+checks.length,ticketNumber:567890,shiftNumber:1,data:{ticket:{amounts:r.body.amounts,dateTime:r.body.dateTime},service:{regInfo:{kkm:{fnsKkmId:'SYNTHETIC-RNM'}}}}}};}
 }
 throw new Error('Unexpected synthetic fiscal request '+path);
 };return {transport,checks,requests};}
async function connectFiscal(f,provider){const response=await f.a.call('/retail/fiscal/config','PUT',{provider,mode:'test',cashboxId:provider==='webkassa'?'TEST-WK':'123',login:'synthetic-cashier',password:'synthetic-fiscal-password',apiKey:'synthetic-integrator-key',version:0},randomUUID());assert.equal(response.status,200,JSON.stringify(response.data));await f.ok('/retail/fiscal/verify',{});await f.ok('/retail/fiscal/enable',{enabled:true});}

test('Fiscal providers encrypt credentials, verify tenant cashbox and attach one Webkassa check to the paid sale',async t=>{const mock=syntheticFiscal('webkassa'),f=await fixture(t,{fiscalTransport:mock.transport});await connectFiscal(f,'webkassa');
 const config=(await f.a.call('/retail/fiscal/config')).data;assert.equal(config.password,undefined);const stored=await f.app.db.prepare('SELECT credentials FROM retail_fiscal_config WHERE company_id=?').get(f.a.id);assert.equal(stored.credentials.includes('synthetic-fiscal-password'),false);assert.equal(JSON.stringify(await f.app.db.prepare('SELECT * FROM idempotency WHERE company_id=?').all(f.a.id)).includes('synthetic-fiscal-password'),false);
 const sale=await f.ok('/retail/sales',f.base,'fiscal-sale-one');assert.equal(sale.fiscal.state,'QUEUED');const issued=await f.app.retailFiscal.processOne();assert.equal(issued.state,'ISSUED');assert.equal(issued.receipt.total,20000);assert.equal(issued.receipt.mode,'test');assert.equal(await f.app.retailFiscal.processOne(),null);assert.equal(mock.checks.length,1);assert.equal((await f.ok('/retail/sales',f.base,'fiscal-sale-one')).id,sale.id);assert.equal(mock.checks.length,1);
 assert.equal((await f.b.call('/retail/fiscal/receipts')).data.items.length,0);assert.equal((await f.b.call('/retail/fiscal/receipts/'+issued.id+'/retry','POST',{})).status,404);
 const request=mock.requests.find(r=>new URL(r.url).pathname.endsWith('/check'));assert.equal(request.body.OperationType,2);assert.equal(request.body.Positions[0].PositionType,0);assert.equal(request.body.Positions[0].GTIN,'4006381333931');assert.equal(request.body.Payments[0].Sum,200);assert.equal(request.body.Change,50);
});
test('Lost fiscal response blocks new sales and recovers the original Webkassa receipt without issuing a second check',async t=>{const mock=syntheticFiscal('webkassa',{loseResponse:true}),f=await fixture(t,{fiscalTransport:mock.transport});await connectFiscal(f,'webkassa');await f.ok('/retail/sales',f.base,'lost-fiscal-sale');const job=await f.app.retailFiscal.processOne();assert.equal(job.state,'UNKNOWN');assert.equal((await f.a.call('/retail/sales','POST',f.base,randomUUID())).status,409);assert.equal((await f.a.call('/wallets')).data.items[0].balance,20000);
 const recovered=await f.ok('/retail/fiscal/receipts/'+job.id+'/retry',{});assert.equal(recovered.state,'ISSUED');assert.equal(mock.checks.length,1);assert.equal((await f.app.db.prepare('SELECT count(*) n FROM retail_sales').get()).n,1);
});
test('reKassa uses partner login, stable request identity, thousandths for quantities and exact money without exposing credentials',async t=>{const mock=syntheticFiscal('rekassa'),f=await fixture(t,{fiscalTransport:mock.transport});await connectFiscal(f,'rekassa');await f.ok('/retail/sales',f.base,'rekassa-sale');const job=await f.app.retailFiscal.processOne();assert.equal(job.state,'ISSUED');assert.equal(mock.checks.length,1);const request=mock.requests.find(r=>new URL(r.url).pathname.endsWith('/tickets'));assert.equal(request.headers['X-Request-ID'],job.id);assert.equal(request.body.items[0].commodity.quantity,2000);assert.deepEqual(request.body.amounts.total,{bills:'200',coins:0});assert.equal(request.body.operation,'OPERATION_SELL');
});
test('Mismatched fiscal response stays unresolved and cannot be printed as a valid receipt',async t=>{const mock=syntheticFiscal('webkassa',{tamper:true}),f=await fixture(t,{fiscalTransport:mock.transport});await connectFiscal(f,'webkassa');await f.ok('/retail/sales',f.base);const job=await f.app.retailFiscal.processOne();assert.equal(job.state,'UNKNOWN');assert.equal(job.receipt,null);assert.equal((await f.ok('/retail/fiscal/receipts/'+job.id+'/retry',{})).state,'UNKNOWN');assert.equal(mock.checks.length,1);
});

test('Retail partial returns restore original FIFO stock and refund once, without duplicate money or excessive quantities',async t=>{const f=await fixture(t),sale=await f.ok('/retail/sales',f.base);const quote=await f.ok('/retail/sales/'+sale.id+'/refund-preview',{items:[{productId:f.product.id,quantity:1}]});assert.equal(quote.total,10000);
 const body={items:[{productId:f.product.id,quantity:1}],expectedTotal:quote.total,walletId:f.wallet.id,refundConfirmed:true,businessDate:'2026-11-03'};const result=await f.ok('/retail/sales/'+sale.id+'/returns',body,'return-one'),again=await f.ok('/retail/sales/'+sale.id+'/returns',body,'return-one');assert.equal(result.id,again.id);assert.equal(result.data.cost,4000);assert.equal((await f.a.call('/wallets')).data.items[0].balance,10000);assert.equal((await f.a.call('/retail/barcode?warehouseId='+f.wh.id+'&barcode=4006381333931')).data.quantity,9);
 assert.equal((await f.a.call('/retail/sales/'+sale.id+'/returns','POST',{...body,items:[{productId:f.product.id,quantity:2}],expectedTotal:20000},randomUUID())).status,409);assert.equal((await f.b.call('/retail/sales/'+sale.id+'/returns')).status,404);
 await f.ok('/retail/sales/'+sale.id+'/returns',body,'return-remaining');assert.equal((await f.a.call('/wallets')).data.items[0].balance,0);assert.equal((await f.a.call('/retail/barcode?warehouseId='+f.wh.id+'&barcode=4006381333931')).data.quantity,10);assert.equal((await f.a.call('/retail/sales/'+sale.id+'/returns')).data.items.length,2);
 const revenue=await f.app.db.prepare("SELECT COALESCE(sum(l.credit-l.debit),0) amount FROM journal_lines l JOIN journal j ON j.id=l.entry_id WHERE j.company_id=? AND l.account='revenue'").get(f.a.id);assert.equal(revenue.amount,0);
});
test('Return of a fiscal sale queues a fiscal refund against the original receipt, preserving the sale check',async t=>{const mock=syntheticFiscal('webkassa'),f=await fixture(t,{fiscalTransport:mock.transport});await connectFiscal(f,'webkassa');const sale=await f.ok('/retail/sales',f.base);await f.app.retailFiscal.processOne();const body={items:[{productId:f.product.id,quantity:1}],expectedTotal:10000,walletId:f.wallet.id,refundConfirmed:true,businessDate:'2026-11-03'};const refund=await f.ok('/retail/sales/'+sale.id+'/returns',body);assert.equal(refund.fiscal.state,'QUEUED');const issued=await f.app.retailFiscal.processOne();assert.equal(issued.state,'ISSUED');assert.equal(issued.sourceKind,'refund');assert.equal(issued.receipt.total,10000);const request=mock.requests.filter(r=>new URL(r.url).pathname.endsWith('/check'))[1];assert.equal(request.body.OperationType,3);assert.equal(request.body.ReturnBasisDetails.Total,200);assert.equal(request.body.ReturnBasisDetails.CheckNumber,'123456789');assert.equal((await f.a.call('/retail/sales/'+sale.id)).data.fiscal.receipt.total,20000);
});

test('Fiscal workers serialize a cashbox across instances',async t=>{
 const mock=syntheticFiscal('webkassa');let release,entered;const blocked=new Promise(resolve=>{release=resolve;}),reached=new Promise(resolve=>{entered=resolve;});let hold=true;const f=await fixture(t,{fiscalTransport:async r=>{if(new URL(r.url).pathname.endsWith('/check')&&hold){entered();await blocked;}return mock.transport(r);}});await connectFiscal(f,'webkassa');await f.ok('/retail/sales',f.base);await f.ok('/retail/sales',f.base);const first=f.app.retailFiscal.processOne();await reached;assert.equal(await f.app.retailFiscal.processOne(),null);hold=false;release();assert.equal((await first).state,'ISSUED');assert.equal((await f.app.retailFiscal.processOne()).state,'ISSUED');assert.equal(mock.checks.length,2);
});

test('Terminal payment snapshots product fiscal codes before bank dispatch and prevents switching its fiscal cashbox',async t=>{const mock=syntheticFiscal('webkassa'),f=await terminalFixture(t,{fiscalTransport:mock.transport});await connectFiscal(f,'webkassa');await f.poll();const payment=await f.ok('/retail/terminal-payments',{...f.base,terminalId:f.terminal.id});const edited=await f.a.call('/retail/products/'+f.product.id,'PUT',{name:'Changed later',barcode:'4006381333931',unit:'шт.',priceMinor:10000,gtin:'5901234123457',version:1},randomUUID());assert.equal(edited.status,200);
 assert.equal((await f.a.call('/retail/fiscal/config','PUT',{provider:'rekassa',mode:'test',cashboxId:'123',login:'fixture',password:'fixture',apiKey:'fixture',version:1},randomUUID())).status,409);assert.equal((await f.a.call('/retail/fiscal/enable','POST',{enabled:false},randomUUID())).status,409);
 await f.poll();assert.equal((await f.result({id:payment.id,status:'approved',amount:payment.amount,currency:payment.currency,paymentKind:'card',bankReference:'synthetic-code-snapshot'})).data.state,'COMPLETED');await f.app.retailFiscal.processOne();const sent=mock.requests.find(r=>new URL(r.url).pathname.endsWith('/check'));assert.equal(sent.body.Positions[0].GTIN,'4006381333931');assert.equal(sent.body.Positions[0].PositionName,'Synthetic product');
});
