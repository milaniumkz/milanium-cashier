import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes,randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';

test('MBusiness production migrations and bridge work without database CREATE or superuser privileges',async t=>{
 assert.equal(process.env.APP_ENV,'test');
 const url=new URL(process.env.DATABASE_URL),suffix=randomBytes(8).toString('hex'),role='test_role_'+suffix,schema='test_'+suffix,password=randomBytes(32).toString('hex');
 const admin=new pg.Client({connectionString:url.href});await admin.connect();const dataDir=await mkdtemp(join(tmpdir(),'mbusiness-role-'));let app;
 t.after(async()=>{if(app)await app.close();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.query(`DROP ROLE IF EXISTS ${role}`);await admin.end();await rm(dataDir,{recursive:true,force:true});delete process.env.MBUSINESS_BRIDGE_SECRET;});
 await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);await admin.query(`CREATE SCHEMA ${schema} AUTHORIZATION ${role}`);
 url.username=role;url.password=password;process.env.MBUSINESS_BRIDGE_SECRET=randomBytes(32).toString('hex');
 app=await createApp({databaseUrl:url.href,schema,dataDir});
 const privileges=await app.db.prepare('SELECT rolsuper,rolcreatedb FROM pg_roles WHERE rolname=?').get(role);assert.equal(privileges.rolsuper,false);assert.equal(privileges.rolcreatedb,false);
 assert.equal((await app.db.prepare("SELECT has_database_privilege(current_user,current_database(),'CREATE') AS allowed").get()).allowed,false);
 const origin=await app.listen({host:'127.0.0.1',port:0});const response=await fetch(origin+'/internal/mbusiness/session',{method:'POST',headers:{'content-type':'application/json','x-mbusiness-bridge-key':process.env.MBUSINESS_BRIDGE_SECRET},body:JSON.stringify({userId:randomUUID(),companyId:randomUUID(),login:'synthetic.owner',companyName:'Synthetic company'})});assert.equal(response.status,200);
});
