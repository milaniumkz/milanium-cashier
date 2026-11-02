import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';

test('Accounting: shared login uses server-only sessions, own identity, tenant access and controlled routes',async t=>{
 const calls=[],tokens=new Map(),secret=randomBytes(32).toString('hex');
 const backend=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;calls.push({url:req.url,authorization:req.headers.authorization});res.setHeader('content-type','application/json');
  if(req.url==='/internal/mbusiness/session'){assert.equal(req.headers['x-mbusiness-bridge-key'],secret);const identity=JSON.parse(body),token=randomBytes(32).toString('base64url');tokens.set(token,identity);res.end(JSON.stringify({token,companyId:identity.companyId,expiresAt:Date.now()+300000}));}
  else {const identity=tokens.get(req.headers.authorization?.slice(7));assert.ok(identity);res.end(JSON.stringify({items:[{id:identity.companyId,name:identity.companyName}]}));}
 });await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
 const config={mode:'sandbox',production:false,key:randomBytes(32),adminPassword:randomBytes(24).toString('hex'),baseUrl:'http://127.0.0.1',dataDir:mkdtempSync(path.join(tmpdir(),'mbusiness-accounting-')),pollMs:1000,webhookOrigins:[],accountingUrl:'http://127.0.0.1:'+backend.address().port,accountingBridgeSecret:secret};
 const app=await buildApp(config,{background:false,logger:false});t.after(async()=>{await app.close();await new Promise(resolve=>backend.close(resolve));rmSync(config.dataDir,{recursive:true,force:true});});
 const register=async login=>{const r=await app.inject({method:'POST',url:'/auth/register',payload:{login,password:'Synthetic-password-123',company:login}});assert.equal(r.statusCode,201);return r.headers['set-cookie'].split(';')[0];};
 const one=await register('account.one'),two=await register('account.two');
 assert.equal((await app.inject('/accounting-api/v1/companies')).statusCode,401);assert.equal(calls.length,0);
 const get=cookie=>app.inject({url:'/accounting-api/v1/companies',headers:{cookie,authorization:'Bearer attacker-value'}});
 const a=await get(one);assert.equal(a.statusCode,200,a.body);assert.ok(!a.body.includes('token'));assert.ok(!a.body.includes(secret));const b=await get(two);assert.notEqual(a.json().items[0].id,b.json().items[0].id);
 await get(one);assert.equal(calls.filter(c=>c.url==='/internal/mbusiness/session').length,2);assert.ok(calls.every(c=>c.authorization!=='Bearer attacker-value'));
 for(const url of ['/accounting-api/v1/auth/login','/accounting-api/v1/%61uth/login','/accounting-api/v1/companies','/accounting-api/v1/%63ompanies']){const r=await app.inject({url,method:'POST',headers:{cookie:one},payload:{}});assert.equal(r.statusCode,409,r.body);}
 assert.equal((await app.inject({url:'/accounting/../src/config.js',headers:{cookie:one}})).statusCode,404);
});
