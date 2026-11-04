import {timingSafeEqual} from 'node:crypto';
import {transaction} from './db.js';
import {fail,hashToken,hashPassword,newToken} from './security.js';
import {teamRole} from '../../../../src/team-roles.js';
const uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
export async function registerMBusinessBridge(app,db){
 const secret=process.env.MBUSINESS_BRIDGE_SECRET;if(!secret)return;if(secret.length<32)throw new Error('MBUSINESS_BRIDGE_SECRET too short');
 await db.exec(`CREATE TABLE IF NOT EXISTS mbusiness_identities(company_id TEXT PRIMARY KEY REFERENCES companies(id),user_id TEXT NOT NULL UNIQUE REFERENCES users(id));
 CREATE TABLE IF NOT EXISTS mbusiness_staff_identities(user_id TEXT PRIMARY KEY,company_id TEXT NOT NULL,revision INTEGER NOT NULL,suspended BOOLEAN NOT NULL DEFAULT FALSE);`);
 const auth=async r=>{if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(r.raw.socket.remoteAddress))fail(403,'internal_only');const supplied=r.headers['x-mbusiness-bridge-key'];if(typeof supplied!=='string'||!timingSafeEqual(Buffer.from(hashToken(supplied)),Buffer.from(hashToken(secret))))fail(401,'invalid_bridge');};
 app.post('/internal/mbusiness/session',{preHandler:auth,config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async r=>{
  const b=r.body||{},ownerId=b.ownerId??b.userId,role=b.role??'owner',revision=b.revision??1;
  if(!uuid(b.userId)||!uuid(b.companyId)||!uuid(ownerId)||!Number.isSafeInteger(revision)||revision<1)fail(400,'invalid_identifier');
  if((role==='owner'&&ownerId!==b.userId)||(role!=='owner'&&(!teamRole(role)||ownerId===b.userId)))fail(400,'invalid_role');
  for(const field of ['login','companyName'])if(typeof b[field]!=='string'||b[field].length>150||!b[field].trim())fail(400,'invalid_name');
  return transaction(db,async()=>{
   await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get('mbusiness:'+b.companyId);
   const link=await db.prepare('SELECT * FROM mbusiness_identities WHERE company_id=?').get(b.companyId);if(link&&link.user_id!==ownerId)fail(409,'identity_mismatch');
   if(!link){
    if(await db.prepare('SELECT id FROM companies WHERE id=?').get(b.companyId)||await db.prepare('SELECT id FROM users WHERE id=?').get(ownerId))fail(409,'identity_collision');
    await db.prepare('INSERT INTO users(id,login,password,name,created_at,can_create_companies) VALUES(?,?,?,?,?,FALSE)').run(ownerId,'mbusiness-'+ownerId,await hashPassword(newToken()),String(b.ownerLogin||b.login).slice(0,150),new Date().toISOString());
    await db.prepare('INSERT INTO companies(id,name,currency,created_at) VALUES(?,?,?,?)').run(b.companyId,b.companyName,'KZT',new Date().toISOString());await db.prepare("INSERT INTO memberships VALUES(?,?,'owner','[]')").run(b.companyId,ownerId);await db.prepare('INSERT INTO mbusiness_identities VALUES(?,?)').run(b.companyId,ownerId);
   }
   if(role!=='owner'){
    const old=await db.prepare('SELECT * FROM mbusiness_staff_identities WHERE user_id=?').get(b.userId);if(old&&(old.company_id!==b.companyId||old.revision>revision))fail(409,'staff_revision_stale');
    const user=await db.prepare('SELECT id FROM users WHERE id=?').get(b.userId);if(user&&!old)fail(409,'identity_collision');
    if(!user)await db.prepare('INSERT INTO users(id,login,password,name,created_at,can_create_companies) VALUES(?,?,?,?,?,FALSE)').run(b.userId,'mbusiness-staff-'+b.userId,await hashPassword(newToken()),b.login,new Date().toISOString());
    const permissions=JSON.stringify(teamRole(role).permissions);const membership=await db.prepare('SELECT * FROM memberships WHERE company_id=? AND user_id=?').get(b.companyId,b.userId);if(membership?.role==='owner')fail(409,'identity_collision');
    if(!old||old.revision!==revision||old.suspended||membership?.permissions!==permissions)await db.prepare('DELETE FROM sessions WHERE user_id=?').run(b.userId);
    await db.prepare("INSERT INTO memberships(company_id,user_id,role,permissions) VALUES(?,?,'member',?) ON CONFLICT(company_id,user_id) DO UPDATE SET role='member',permissions=EXCLUDED.permissions").run(b.companyId,b.userId,permissions);
    await db.prepare('INSERT INTO mbusiness_staff_identities VALUES(?,?,?,FALSE) ON CONFLICT(user_id) DO UPDATE SET revision=EXCLUDED.revision,suspended=FALSE').run(b.userId,b.companyId,revision);
   }
   const token=newToken(),expiresAt=Date.now()+5*60*1000;await db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());await db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hashToken(token),b.userId,expiresAt);return {token,expiresAt,companyId:b.companyId};
  });
 });
 app.post('/internal/mbusiness/staff/revoke',{preHandler:auth},async r=>{
  const b=r.body||{};if(!uuid(b.userId)||!uuid(b.companyId)||!Number.isSafeInteger(b.revision)||b.revision<1)fail(400,'invalid_identifier');
  return transaction(db,async()=>{await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get('mbusiness:'+b.companyId);const owner=await db.prepare('SELECT * FROM mbusiness_identities WHERE company_id=?').get(b.companyId);if(owner?.user_id===b.userId)fail(409,'owner_cannot_be_revoked');const old=await db.prepare('SELECT * FROM mbusiness_staff_identities WHERE user_id=?').get(b.userId);if(old&&old.company_id!==b.companyId)fail(409,'identity_mismatch');if(old&&old.revision>b.revision)return {ok:true};await db.prepare('INSERT INTO mbusiness_staff_identities VALUES(?,?,?,TRUE) ON CONFLICT(user_id) DO UPDATE SET revision=EXCLUDED.revision,suspended=TRUE').run(b.userId,b.companyId,b.revision);await db.prepare('DELETE FROM sessions WHERE user_id=?').run(b.userId);await db.prepare("UPDATE memberships SET permissions='[]' WHERE company_id=? AND user_id=? AND role<>'owner'").run(b.companyId,b.userId);return {ok:true};});
 });
}
