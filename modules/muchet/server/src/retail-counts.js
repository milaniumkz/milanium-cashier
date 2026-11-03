import { randomUUID,timingSafeEqual } from 'node:crypto';
import { transaction,readSnapshot } from './db.js';
import { fail,integer,text,scope,hashToken,newToken } from './security.js';

export async function registerRetailCounts(app,{db,auth,access,command,object,warehouse,stock,barcodeProduct}){
 await db.exec(`CREATE TABLE IF NOT EXISTS retail_counts(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),warehouse_id TEXT NOT NULL,scope TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'OPEN',version INTEGER NOT NULL DEFAULT 1,author_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,finished_at TEXT);
 CREATE INDEX IF NOT EXISTS retail_counts_company ON retail_counts(company_id,created_at);
 CREATE TABLE IF NOT EXISTS retail_count_lines(count_id TEXT NOT NULL REFERENCES retail_counts(id),product_id TEXT NOT NULL,product_name TEXT NOT NULL,barcode TEXT NOT NULL DEFAULT '',expected BIGINT NOT NULL,counted BIGINT,version INTEGER NOT NULL DEFAULT 0,actor_name TEXT,updated_at TEXT,PRIMARY KEY(count_id,product_id));
 CREATE TABLE IF NOT EXISTS retail_count_commands(count_id TEXT NOT NULL REFERENCES retail_counts(id),actor_id TEXT NOT NULL,operation_key TEXT NOT NULL,fingerprint TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(count_id,actor_id,operation_key));
 CREATE TABLE IF NOT EXISTS retail_count_events(id TEXT PRIMARY KEY,count_id TEXT NOT NULL REFERENCES retail_counts(id),product_id TEXT NOT NULL,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,old_quantity BIGINT,new_quantity BIGINT NOT NULL,mode TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS retail_count_devices(id TEXT PRIMARY KEY,count_id TEXT NOT NULL REFERENCES retail_counts(id),company_id TEXT NOT NULL REFERENCES companies(id),name TEXT NOT NULL,code_hash TEXT NOT NULL UNIQUE,code_expires BIGINT NOT NULL,token_hash TEXT UNIQUE,token_expires BIGINT,revoked BOOLEAN NOT NULL DEFAULT FALSE,created_at TEXT NOT NULL)`);
 const base='/v1/companies/:companyId/retail/counts',route=(method,path,handler)=>app.route({method,url:base+path,preHandler:auth,handler});
 async function get(companyId,id){const r=await db.prepare('SELECT * FROM retail_counts WHERE company_id=? AND id=?').get(companyId,id);if(!r)fail(404,'count_not_found');return r;}
 async function report(session,query={}){return readSnapshot(db,async()=>{
  const q=typeof query.q==='string'?query.q.trim().slice(0,128):'',offset=query.offset===undefined?0:integer(Number(query.offset),'offset'),filter=query.filter||'all';if(!['all','differences','uncounted','counted'].includes(filter))fail(400,'invalid_filter');
  const current="COALESCE((SELECT sum(b.quantity) FROM batches b WHERE b.company_id=c.company_id AND b.warehouse_id=c.warehouse_id AND b.scope=c.scope AND b.product_id=l.product_id),0)";
  const totals=await db.prepare(`SELECT count(*) total,count(*) FILTER(WHERE l.counted IS NOT NULL) counted,count(*) FILTER(WHERE l.counted IS NOT NULL AND l.counted<>l.expected) differences,COALESCE(sum(l.counted-l.expected) FILTER(WHERE l.counted IS NOT NULL),0) difference_units,count(*) FILTER(WHERE l.expected<>${current}) moved FROM retail_count_lines l JOIN retail_counts c ON c.id=l.count_id WHERE c.id=?`).get(session.id);
  const filtered=filter==='differences'?'AND l.counted IS NOT NULL AND l.counted<>l.expected':filter==='uncounted'?'AND l.counted IS NULL':filter==='counted'?'AND l.counted IS NOT NULL':'';
  const where=`l.count_id=? AND (lower(l.product_name) LIKE lower(?) OR l.barcode LIKE ?) ${filtered}`;
  const matched=(await db.prepare(`SELECT count(*) n FROM retail_count_lines l WHERE ${where}`).get(session.id,'%'+q+'%','%'+q+'%')).n;
  const lines=await db.prepare(`SELECT l.*,${current} current_book,l.counted-l.expected AS difference FROM retail_count_lines l JOIN retail_counts c ON c.id=l.count_id WHERE ${where} ORDER BY ${query.sort==='recent'?'l.updated_at DESC NULLS LAST,l.product_id':'l.product_id'} LIMIT 100 OFFSET ?`).all(session.id,'%'+q+'%','%'+q+'%',offset);
  return {session,totals,matched,offset,lines,hasMore:offset+lines.length<matched,serverTime:new Date().toISOString()};
 });}
 async function lookup(session,barcode){const p=await barcodeProduct(db,session.company_id,barcode),line=await db.prepare('SELECT * FROM retail_count_lines WHERE count_id=? AND product_id=?').get(session.id,p.id);return {product:{id:p.id,name:p.name,barcode:p.barcode,unit:p.unit},line:line||{product_id:p.id,product_name:p.name,barcode:p.barcode,expected:0,counted:null,version:0},current:await stock(session.company_id,session.warehouse_id,session.scope,p.id)};}
 async function saveLine(session,body,actor,key){
  if(!/^[A-Za-z0-9_.:-]{8,128}$/.test(key||''))fail(400,'invalid_idempotency_key');
  const fingerprint=hashToken(JSON.stringify(body)),prior=await db.prepare('SELECT * FROM retail_count_commands WHERE count_id=? AND actor_id=? AND operation_key=?').get(session.id,actor.id,key);
  if(prior){if(prior.fingerprint!==fingerprint)fail(409,'idempotency_conflict');return JSON.parse(prior.response);}
  session=await get(session.company_id,session.id);if(session.status!=='OPEN')fail(409,'count_closed');
  const quantity=integer(body.quantity,'quantity'),mode=body.mode;if(!['replace','add'].includes(mode))fail(400,'invalid_count_mode');
  let productId=body.productId,product;
  if(body.barcode){product=await barcodeProduct(db,session.company_id,body.barcode);if(productId&&productId!==product.id)fail(400,'barcode_product_mismatch');productId=product.id;}
  productId=text(productId,'productId');let old=await db.prepare('SELECT * FROM retail_count_lines WHERE count_id=? AND product_id=?').get(session.id,productId);
  if(!old){const p=await db.prepare("SELECT data FROM documents WHERE company_id=? AND kind='nomenklatura' AND id=?").get(session.company_id,productId);if(!p)fail(404,'product_not_found');const d=JSON.parse(p.data);await db.prepare('INSERT INTO retail_count_lines(count_id,product_id,product_name,barcode,expected) VALUES(?,?,?,?,0)').run(session.id,productId,d.name||'Товар',d.barcode||'');old=await db.prepare('SELECT * FROM retail_count_lines WHERE count_id=? AND product_id=?').get(session.id,productId);}
  if(mode==='replace'&&body.version!==old.version)fail(409,'count_line_conflict');
  const counted=mode==='add'?integer((old.counted??0)+quantity,'counted'):quantity,time=new Date().toISOString();
  await db.prepare('UPDATE retail_count_lines SET counted=?,version=version+1,actor_name=?,updated_at=? WHERE count_id=? AND product_id=?').run(counted,actor.name,time,session.id,productId);
  await db.prepare('UPDATE retail_counts SET version=version+1 WHERE id=?').run(session.id);
  await db.prepare('INSERT INTO retail_count_events VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),session.id,productId,actor.id,actor.name,old.counted,counted,mode,time);
  const line=await db.prepare('SELECT *,counted-expected AS difference FROM retail_count_lines WHERE count_id=? AND product_id=?').get(session.id,productId);
  const response={line,sessionVersion:session.version+1,savedAt:time};await db.prepare('INSERT INTO retail_count_commands VALUES(?,?,?,?,?)').run(session.id,actor.id,key,fingerprint,JSON.stringify(response));return response;
 }
 route('GET','',async req=>{const c=await access(req,'inventory.read');const rows=await db.prepare('SELECT r.*,u.name AS author_name FROM retail_counts r JOIN users u ON u.id=r.author_id WHERE r.company_id=? ORDER BY r.created_at DESC,r.id LIMIT 100').all(c.id);return {items:rows};});
 route('POST','',req=>command(req,'inventory.count','retail.count.create',async c=>{
  await access(req,'inventory.read');const b=object(req.body);await warehouse(c.id,b.warehouseId);const id=randomUUID(),ledger=scope(b.scope),time=new Date().toISOString();
  await db.prepare('INSERT INTO retail_counts(id,company_id,warehouse_id,scope,name,author_id,created_at) VALUES(?,?,?,?,?,?,?)').run(id,c.id,b.warehouseId,ledger,text(b.name,'name',160),req.user.id,time);
  await db.prepare(`INSERT INTO retail_count_lines(count_id,product_id,product_name,barcode,expected) SELECT ?,b.product_id,COALESCE(d.data::jsonb->>'name',b.product_id),COALESCE(d.data::jsonb->>'barcode',''),sum(b.quantity) FROM batches b LEFT JOIN documents d ON d.company_id=b.company_id AND d.kind='nomenklatura' AND d.id=b.product_id WHERE b.company_id=? AND b.warehouse_id=? AND b.scope=? GROUP BY b.product_id,d.data HAVING sum(b.quantity)<>0`).run(id,c.id,b.warehouseId,ledger);
  return report(await get(c.id,id));
 }));
 route('GET','/:id',async req=>{const c=await access(req,'inventory.read');return report(await get(c.id,req.params.id),req.query);});
 route('GET','/:id/barcode',async req=>{const c=await access(req,'inventory.read');await access(req,'catalog.read');return lookup(await get(c.id,req.params.id),req.query.barcode);});
 route('POST','/:id/lines',req=>command(req,'inventory.count','retail.count.scan',async c=>{await access(req,'inventory.read');const session=await get(c.id,req.params.id);return saveLine(session,object(req.body),{id:req.user.id,name:req.user.name||req.user.login},req.headers['idempotency-key']);}));
 route('POST','/:id/finish',req=>command(req,'inventory.count','retail.count.finish',async c=>{
  const session=await get(c.id,req.params.id),b=object(req.body);if(session.status!=='OPEN')fail(409,'count_closed');if(b.version!==session.version)fail(409,'version_conflict');const r=await report(session);
  if(r.totals.counted<r.totals.total&&b.acceptPartial!==true)fail(409,'uncounted_products_remain');if(r.totals.moved>0&&b.acceptMovements!==true)fail(409,'stock_moved_during_count');
  await db.prepare("UPDATE retail_counts SET status='FINISHED',finished_at=?,version=version+1 WHERE id=?").run(new Date().toISOString(),session.id);return report(await get(c.id,session.id));
 }));
 route('GET','/:id/events',async req=>{const c=await access(req,'inventory.read');await get(c.id,req.params.id);return {items:await db.prepare('SELECT * FROM retail_count_events WHERE count_id=? ORDER BY created_at DESC,id LIMIT 100').all(req.params.id)};});
 route('POST','/:id/pair',req=>command(req,'inventory.count','retail.count.device.create',async c=>{
  const session=await get(c.id,req.params.id);if(session.status!=='OPEN')fail(409,'count_closed');const b=object(req.body),id=randomUUID(),code=newToken();if((await db.prepare('SELECT count(*) n FROM retail_count_devices WHERE count_id=? AND NOT revoked').get(session.id)).n>=20)fail(409,'too_many_devices');
  await db.prepare('INSERT INTO retail_count_devices(id,count_id,company_id,name,code_hash,code_expires,created_at) VALUES(?,?,?,?,?,?,?)').run(id,session.id,c.id,text(b.name,'name',80),hashToken(code),Date.now()+10*60000,new Date().toISOString());return {id,code,expiresInSeconds:600};
 }));
 route('GET','/:id/devices',async req=>{const c=await access(req,'inventory.read');await get(c.id,req.params.id);return {items:await db.prepare('SELECT id,name,token_expires,revoked FROM retail_count_devices WHERE count_id=? ORDER BY created_at').all(req.params.id)};});
 route('POST','/:id/devices/:deviceId/revoke',req=>command(req,'inventory.count','retail.count.device.revoke',async c=>{await get(c.id,req.params.id);await db.prepare('UPDATE retail_count_devices SET revoked=TRUE WHERE company_id=? AND count_id=? AND id=?').run(c.id,req.params.id,req.params.deviceId);return {ok:true};}));
 function bridge(req){const key=process.env.MBUSINESS_BRIDGE_SECRET,supplied=req.headers['x-mbusiness-bridge-key'];if(!key||key.length<32||typeof supplied!=='string'||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.raw.socket.remoteAddress)||!timingSafeEqual(Buffer.from(hashToken(supplied)),Buffer.from(hashToken(key))))fail(401,'invalid_bridge');}
 const device=async req=>{bridge(req);const token=req.headers['x-retail-device-token'];if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))fail(401,'device_auth_required');const d=await db.prepare('SELECT * FROM retail_count_devices WHERE token_hash=? AND NOT revoked AND token_expires>?').get(hashToken(token),Date.now());if(!d)fail(401,'device_auth_required');return d;};
 app.post('/internal/retail/device/join',{preHandler:async req=>bridge(req),config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async req=>transaction(db,async()=>{
  const b=object(req.body);if(typeof b.code!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(b.code))fail(400,'invalid_pairing_code');
  const d=await db.prepare('SELECT * FROM retail_count_devices WHERE code_hash=? FOR UPDATE').get(hashToken(b.code));if(!d||d.revoked||d.token_hash||d.code_expires<Date.now())fail(401,'invalid_pairing_code');const session=await get(d.company_id,d.count_id);if(session.status!=='OPEN')fail(409,'count_closed');
  const token=newToken(),expiresAt=Date.now()+8*3600000;await db.prepare('UPDATE retail_count_devices SET token_hash=?,token_expires=? WHERE id=?').run(hashToken(token),expiresAt,d.id);return {token,expiresAt};
 }));
 app.get('/internal/retail/device/session',async req=>{const d=await device(req),session=await get(d.company_id,d.count_id),company=await db.prepare('SELECT name FROM companies WHERE id=?').get(d.company_id);const r=await report(session,{filter:'counted',sort:'recent'});return {...r,device:{id:d.id,name:d.name},companyName:company.name};});
 app.get('/internal/retail/device/barcode',async req=>{const d=await device(req);return lookup(await get(d.company_id,d.count_id),req.query.barcode);});
 app.post('/internal/retail/device/line',async req=>{const d=await device(req);return transaction(db,async()=>{await db.prepare('SELECT id FROM companies WHERE id=? FOR UPDATE').get(d.company_id);const live=await device(req);return saveLine(await get(live.company_id,live.count_id),object(req.body),{id:live.id,name:live.name},req.headers['idempotency-key']);});});
}
