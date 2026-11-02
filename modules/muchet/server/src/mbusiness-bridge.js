import { timingSafeEqual } from 'node:crypto';
import { transaction } from './db.js';
import { fail, hashToken, hashPassword, newToken } from './security.js';

export async function registerMBusinessBridge(app,db){
 const secret=process.env.MBUSINESS_BRIDGE_SECRET;
 if(!secret)return;
 if(secret.length<32)throw new Error('MBUSINESS_BRIDGE_SECRET too short');
 await db.exec('CREATE TABLE IF NOT EXISTS mbusiness_identities(company_id TEXT PRIMARY KEY REFERENCES companies(id),user_id TEXT NOT NULL UNIQUE REFERENCES users(id))');
 app.post('/internal/mbusiness/session',{config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async request=>{
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.raw.socket.remoteAddress))fail(403,'internal_only');
  const supplied=request.headers['x-mbusiness-bridge-key'];
  if(typeof supplied!=='string'||!timingSafeEqual(Buffer.from(hashToken(supplied)),Buffer.from(hashToken(secret))))fail(401,'invalid_bridge');
  const body=request.body||{};
  for(const field of ['userId','companyId'])if(typeof body[field]!=='string'||!/^[a-f0-9-]{36}$/.test(body[field]))fail(400,'invalid_identifier');
  for(const field of ['login','companyName'])if(typeof body[field]!=='string'||body[field].length>150||!body[field].trim())fail(400,'invalid_name');
  const disabledPassword=await hashPassword(newToken());
  return transaction(db,async()=>{
   await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get('mbusiness:'+body.companyId);
   const link=await db.prepare('SELECT * FROM mbusiness_identities WHERE company_id=?').get(body.companyId);
   if(link&&link.user_id!==body.userId)fail(409,'identity_mismatch');
   if(!link){
    if(await db.prepare('SELECT id FROM companies WHERE id=?').get(body.companyId)||await db.prepare('SELECT id FROM users WHERE id=?').get(body.userId))fail(409,'identity_collision');
    await db.prepare('INSERT INTO users(id,login,password,name,created_at,can_create_companies) VALUES(?,?,?,?,?,FALSE)').run(body.userId,'mbusiness-'+body.userId,disabledPassword,body.login,new Date().toISOString());
    await db.prepare('INSERT INTO companies(id,name,currency,created_at) VALUES(?,?,?,?)').run(body.companyId,body.companyName,'KZT',new Date().toISOString());
    await db.prepare("INSERT INTO memberships VALUES(?,?,'owner','[]')").run(body.companyId,body.userId);
    await db.prepare('INSERT INTO mbusiness_identities VALUES(?,?)').run(body.companyId,body.userId);
   }
   const token=newToken(),expiresAt=Date.now()+5*60*1000;
   await db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
   await db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hashToken(token),body.userId,expiresAt);
   return {token,expiresAt,companyId:body.companyId};
  });
 });
}
