import {registerRetailReturns} from './retail-returns.js';
import {registerRetailFiscal} from './retail-fiscal.js';
import {registerRetailTerminals} from './retail-terminals.js';
import { randomUUID } from 'node:crypto';
import { fail,integer,text,scope,businessDate } from './security.js';
import { orderInput } from './accounting.js';
import { createGoodsOrder,getGoodsOrder,reserveGoodsOrder,shipGoodsOrder,receiveGoodsPayment,receiveInventory } from './goods-commands.js';
import { registerRetailCounts } from './retail-counts.js';

export function cleanBarcode(value){const code=text(value,'barcode',128);if(/[\x00-\x20\x7f]/.test(code))fail(400,'invalid_barcode');return code;}
const publicProduct=row=>{const d=typeof row.data==='string'?JSON.parse(row.data):row.data;return {id:row.id,name:d.name||'Без названия',barcode:d.barcode||'',unit:d.unit||'шт.',priceMinor:Number.isSafeInteger(d.priceMinor)&&d.priceMinor>=0?d.priceMinor:null,version:row.version,sku:d.sku||'',category:d.category||'',gtin:d.gtin||'',ntin:d.ntin||''};};

const productMeta=(b,old={})=>{const value={};for(const field of ['sku','category','gtin','ntin']){const v=b[field]??old[field]??'';if(typeof v!=='string'||v.length>100||(/[\x00-\x1f]/.test(v)))fail(400,'invalid_product_metadata');value[field]=v.trim();}if(value.gtin&&!/^(\d{8}|\d{12,14})$/.test(value.gtin))fail(400,'invalid_gtin');if(value.ntin&&!/^\d{13}$/.test(value.ntin))fail(400,'invalid_ntin');return value;};
export async function barcodeProduct(db,companyId,value){
 const barcode=cleanBarcode(value),rows=await db.prepare("SELECT * FROM documents WHERE company_id=? AND kind='nomenklatura' AND data::jsonb->>'barcode'=? ORDER BY id LIMIT 2").all(companyId,barcode);
 if(!rows.length)fail(404,'barcode_not_found');if(rows.length>1)fail(409,'barcode_ambiguous');return publicProduct(rows[0]);
}
export async function registerRetail(app,{db,auth,access,command,object,fiscalTransport,fiscalWorker}){
 await db.exec(`CREATE INDEX IF NOT EXISTS retail_product_barcode ON documents(company_id,((data::jsonb)->>'barcode')) WHERE kind='nomenklatura';
 CREATE TABLE IF NOT EXISTS retail_sales(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),actor_id TEXT NOT NULL REFERENCES users(id),method TEXT NOT NULL CHECK(method IN ('cash','terminal')),tendered BIGINT NOT NULL,change_amount BIGINT NOT NULL,created_at TEXT NOT NULL)`);
 const fiscal=await registerRetailFiscal(app,{db,auth,access,command,transport:fiscalTransport,worker:fiscalWorker});app.decorate('retailFiscal',fiscal);
 const base='/v1/companies/:companyId/retail';
 const route=(method,path,handler)=>app.route({method,url:base+path,preHandler:auth,handler});
 const warehouse=async(companyId,id)=>{if(!await db.prepare("SELECT 1 FROM documents WHERE company_id=? AND kind='warehouses' AND id=?").get(companyId,text(id,'warehouseId')))fail(404,'warehouse_not_found');};
 const stock=async(companyId,warehouseId,ledgerScope,productId)=>{const r=await db.prepare('SELECT COALESCE(sum(quantity),0) quantity,COALESCE(sum(reserved),0) reserved FROM batches WHERE company_id=? AND warehouse_id=? AND scope=? AND product_id=?').get(companyId,warehouseId,ledgerScope,productId);return {quantity:r.quantity,reserved:r.reserved,available:r.quantity-r.reserved};};
 route('GET','/context',async req=>{
  const c=await access(req,'catalog.read');await access(req,'inventory.read');
  const warehouses=await db.prepare("SELECT id,data FROM documents WHERE company_id=? AND kind='warehouses' ORDER BY id").all(c.id);
  const wallets=await db.prepare('SELECT id,name,scope FROM wallets WHERE company_id=? ORDER BY name,id').all(c.id);
  const settings=await db.prepare('SELECT legal_name,legal_form,tax_regime,vat_registered FROM company_settings WHERE company_id=?').get(c.id);
  return {actorId:req.user.id,companyName:c.name,currency:c.currency,businessDate:businessDate(undefined,c.timezone),warehouses:warehouses.map(r=>({id:r.id,name:JSON.parse(r.data).name||'Склад'})),wallets,settings:settings||null};
 });
 route('GET','/products',async req=>{
  const c=await access(req,'catalog.read');await access(req,'inventory.read');const ledger=scope(req.query.scope),wid=req.query.warehouseId;if(wid)await warehouse(c.id,wid);
  const q=typeof req.query.q==='string'?req.query.q.trim().slice(0,128):'',after=typeof req.query.after==='string'?req.query.after:'',limit=100;
  const rows=await db.prepare("SELECT * FROM documents WHERE company_id=? AND kind='nomenklatura' AND id>? AND (lower(COALESCE(data::jsonb->>'name','')) LIKE lower(?) OR COALESCE(data::jsonb->>'barcode','') LIKE ?) ORDER BY id LIMIT ?").all(c.id,after,'%'+q+'%','%'+q+'%',limit);
  return {items:await Promise.all(rows.map(async r=>({...publicProduct(r),...(wid?await stock(c.id,wid,ledger,r.id):{})}))),nextCursor:rows.length===limit?rows.at(-1).id:null};
 });
 route('GET','/barcode',async req=>{const c=await access(req,'catalog.read');await access(req,'inventory.read');await warehouse(c.id,req.query.warehouseId);const p=await barcodeProduct(db,c.id,req.query.barcode);return {...p,...await stock(c.id,req.query.warehouseId,scope(req.query.scope),p.id)};});
 route('GET','/products/by-barcode',async req=>{const c=await access(req,'catalog.read');return barcodeProduct(db,c.id,req.query.barcode);});
 route('POST','/intake',req=>command(req,'catalog.write','retail.intake',async c=>{
  const b=object(req.body),barcode=cleanBarcode(b.barcode),quantity=integer(b.quantity??0,'quantity');
  const rows=await db.prepare("SELECT * FROM documents WHERE company_id=? AND kind='nomenklatura' AND data::jsonb->>'barcode'=? LIMIT 2").all(c.id,barcode);if(rows.length>1)fail(409,'barcode_ambiguous');
  let product=rows[0];
  if(product){if(b.existingId!==product.id||b.version!==product.version)fail(409,'product_scan_changed');}
  else{if(b.existingId)fail(409,'product_scan_changed');const id=randomUUID(),time=new Date().toISOString(),data={name:text(b.name,'name',250),barcode,unit:text(b.unit||'шт.','unit',30),priceMinor:integer(b.priceMinor,'priceMinor'),...productMeta(b)};await db.prepare("INSERT INTO documents(company_id,kind,id,data,version,created_at,updated_at) VALUES(?,'nomenklatura',?,?,1,?,?)").run(c.id,id,JSON.stringify(data),time,time);product={id,data:JSON.stringify(data),version:1};}
  let receipt=null;if(quantity){if(b.stockConfirmed!==true)fail(400,'stock_confirmation_required');await access(req,'inventory.receive');receipt=await receiveInventory(db,c,{productId:product.id,quantity,unitCost:integer(b.unitCost,'unitCost'),warehouseId:b.warehouseId,scope:b.scope,businessDate:b.businessDate});}
  return {id:product.id,product:publicProduct(product),receipt};
 }));
 route('POST','/products',req=>command(req,'catalog.write','retail.product.create',async c=>{
  const b=object(req.body),barcode=cleanBarcode(b.barcode),name=text(b.name,'name',250),price=integer(b.priceMinor,'priceMinor'),unit=text(b.unit||'шт.','unit',30);
  if(await db.prepare("SELECT 1 FROM documents WHERE company_id=? AND kind='nomenklatura' AND data::jsonb->>'barcode'=?").get(c.id,barcode))fail(409,'barcode_already_used');
  const id=randomUUID(),time=new Date().toISOString(),data={name,barcode,unit,priceMinor:price,...productMeta(b)};await db.prepare("INSERT INTO documents(company_id,kind,id,data,version,created_at,updated_at) VALUES(?,'nomenklatura',?,?,1,?,?)").run(c.id,id,JSON.stringify(data),time,time);return {id,...data,version:1};
 }));
 route('PUT','/products/:id',req=>command(req,'catalog.write','retail.product.edit',async c=>{
  const b=object(req.body),old=await db.prepare("SELECT * FROM documents WHERE company_id=? AND kind='nomenklatura' AND id=?").get(c.id,req.params.id);if(!old)fail(404,'product_not_found');if(old.version!==b.version)fail(409,'version_conflict');
  const barcode=cleanBarcode(b.barcode);if(await db.prepare("SELECT 1 FROM documents WHERE company_id=? AND kind='nomenklatura' AND id<>? AND data::jsonb->>'barcode'=?").get(c.id,old.id,barcode))fail(409,'barcode_already_used');
  const data={...JSON.parse(old.data),name:text(b.name,'name',250),barcode,unit:text(b.unit||'шт.','unit',30),priceMinor:integer(b.priceMinor,'priceMinor'),...productMeta(b,JSON.parse(old.data))};
  await db.prepare("INSERT INTO entity_history(company_id,kind,entity_id,snapshot,actor_id) VALUES(?,'nomenklatura',?,?,?)").run(c.id,old.id,JSON.stringify(old),req.user.id);
  await db.prepare("UPDATE documents SET data=?,version=version+1,updated_at=? WHERE company_id=? AND kind='nomenklatura' AND id=?").run(JSON.stringify(data),new Date().toISOString(),c.id,old.id);return {id:old.id,...data,version:old.version+1};
 }));
 async function priced(c,b){
  const settings=await db.prepare('SELECT * FROM company_settings WHERE company_id=?').get(c.id);if(!settings?.legal_form||!settings?.tax_regime)fail(409,'company_setup_required');
  await warehouse(c.id,b.warehouseId);if(!Array.isArray(b.items)||!b.items.length||b.items.length>100)fail(400,'invalid_items');
  const items=[];for(const line of b.items){const r=await db.prepare("SELECT * FROM documents WHERE company_id=? AND kind='nomenklatura' AND id=?").get(c.id,text(line.productId,'productId'));if(!r)fail(404,'product_not_found');const p=publicProduct(r);if(p.priceMinor===null)fail(409,'product_price_missing');items.push({productId:p.id,warehouseId:b.warehouseId,quantity:integer(line.quantity,'quantity',1),unitPrice:p.priceMinor});}
  return orderInput(db,c.id,{items,scope:scope(b.scope),vatBasisPoints:settings.vat_registered?1600:0,businessDate:businessDate(undefined,c.timezone),note:'Розничная продажа MBusiness'},c.timezone);
 }
 route('POST','/preview',async req=>{const c=await access(req,'orders.write');await access(req,'catalog.read');return priced(c,object(req.body));});
 const sale=async(companyId,id)=>{const r=await db.prepare('SELECT s.*,ch.channel,ch.payment_kind,u.name AS actor_name FROM retail_sales s JOIN users u ON u.id=s.actor_id LEFT JOIN retail_sale_channels ch ON ch.sale_id=s.id WHERE s.company_id=? AND s.id=?').get(companyId,id);if(!r)fail(404,'sale_not_found');return {...r,order:await getGoodsOrder(db,companyId,r.order_id),fiscal:await fiscal.getReceipt(companyId,id)};};
 route('POST','/sales',req=>command(req,'orders.write','retail.sale',async c=>{
  for(const permission of ['orders.fulfill','payments.write','wallets.transact','catalog.read','inventory.read'])await access(req,permission);
  await fiscal.requireReady(c.id);const b=object(req.body);if(b.paymentConfirmed!==true||!['cash','kaspi','terminal'].includes(b.method))fail(400,'payment_confirmation_required');
  const preview=await priced(c,b);if(preview.total!==b.expectedTotal)fail(409,'retail_price_changed');if(preview.total<=0)fail(400,'zero_sale_total');
  const wallet=await db.prepare('SELECT * FROM wallets WHERE company_id=? AND id=?').get(c.id,text(b.walletId,'walletId'));if(!wallet)fail(404,'wallet_not_found');if(wallet.scope!==preview.scope)fail(400,'incompatible_ledger_scope');
  const tendered=b.method==='cash'?integer(b.tendered,'tendered',1):preview.total;if(tendered<preview.total)fail(409,'cash_not_enough');
  const order=await createGoodsOrder(db,c,preview);await fiscal.captureOrder(c.id,order.id,preview);await reserveGoodsOrder(db,c,order.id);await shipGoodsOrder(db,c,order.id);await receiveGoodsPayment(db,c,order.id,{amount:preview.total,walletId:wallet.id,businessDate:preview.businessDate});
  const id=randomUUID();await db.prepare('INSERT INTO retail_sales VALUES(?,?,?,?,?,?,?,?)').run(id,c.id,order.id,req.user.id,b.method==='cash'?'cash':'terminal',tendered,tendered-preview.total,new Date().toISOString());await db.prepare('INSERT INTO retail_sale_channels VALUES(?,?,?)').run(id,b.method==='terminal'?'bank':b.method,b.method==='cash'?'cash':b.paymentKind==='mobile'?'mobile':'card');await fiscal.enqueue(c.id,id);return sale(c.id,id);
 }));
 route('GET','/sales',async req=>{const c=await access(req,'orders.read');const rows=await db.prepare('SELECT id FROM retail_sales WHERE company_id=? ORDER BY created_at DESC,id LIMIT 50').all(c.id);return {items:await Promise.all(rows.map(r=>sale(c.id,r.id)))};});
 route('GET','/sales/by-key',async req=>{const c=await access(req,'orders.read');const r=await db.prepare("SELECT response FROM idempotency WHERE company_id=? AND actor_id=? AND key=?").get(c.id,req.user.id,text(req.query.key,'key',128));if(!r)fail(404,'sale_not_found');const parsed=JSON.parse(r.response);return sale(c.id,parsed.id);});
 route('GET','/sales/:id',async req=>{const c=await access(req,'orders.read');return sale(c.id,req.params.id);});
 await registerRetailReturns(app,{db,auth,access,command,sale,fiscal});
 await registerRetailTerminals(app,{db,auth,access,command,object,priced,sale,fiscal});
 await registerRetailCounts(app,{db,auth,access,command,object,warehouse,stock,barcodeProduct});
}
