import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeIp,publicServerIp,clientServerIp } from '../src/api-access.js';
import { buildApp } from '../src/app.js';
import { Store } from '../src/db.js';
import { loadConfig } from '../src/config.js';
const IP='93.184.216.34',OTHER='8.8.4.4';
async function fixture(t,trustedProxyIps=[]){const config={mode:'sandbox',production:false,key:randomBytes(32),adminPassword:randomBytes(24).toString('base64url'),baseUrl:'http://127.0.0.1:3080',dataDir:mkdtempSync(path.join(tmpdir(),'mb-ip-test-')),pollMs:1000,webhookOrigins:[],trustedProxyIps};const app=await buildApp(config,{background:false,logger:false});t.after(async()=>{await app.close();rmSync(config.dataDir,{recursive:true,force:true});});
 const signup=await app.inject({method:'POST',url:'/auth/register',payload:{login:'ip.owner',password:'Strong-password-123',company:'IP company'}});assert.equal(signup.statusCode,201);
 const cookie=signup.headers['set-cookie'].split(';')[0];const overview=(await app.inject({url:'/account/overview',headers:{cookie}})).json();
 const bind=(ip,password='Strong-password-123')=>app.inject({method:'POST',url:'/account/api-server',headers:{cookie},payload:{ip,password}});
 const request=(apiKey,remoteAddress=IP,url='/v1/capabilities',headers={})=>app.inject({url,remoteAddress,headers:{authorization:'Bearer '+apiKey,...headers}});
 return {app,config,cookie,id:overview.company.id,bind,request,...signup.json(),...app.services};}

test('API IP: normalizes IPv4, IPv6 spelling and mapped socket addresses',()=>{
 assert.equal(normalizeIp('::ffff:93.184.216.34'),IP);assert.equal(normalizeIp('::FFFF:5db8:d822'),IP);assert.equal(normalizeIp('2606:4700:0000:0000:0000:0000:0000:1111'),'2606:4700::1111');
 for(const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','100.64.0.1','169.254.1.1','0.0.0.0','224.0.0.1','255.255.255.255','192.0.2.1','198.51.100.1','203.0.113.1','::1','::','fc00::1','fe80::1','2001:db8::1','2001:10::1','3fff::1','64:ff9b::101:101','::ffff:127.0.0.1','93.184.216.34/32','*.example.com','https://93.184.216.34','93.184.216.34:443','[2606:4700::1111]','fe80::1%eth0','example.com','93.184.216.34,8.8.8.8'])assert.equal(publicServerIp(ip),null,ip);
 assert.equal(publicServerIp(IP),IP);assert.equal(publicServerIp('2606:4700::1111'),'2606:4700::1111');
});

test('API IP: no binding denies every Bearer API, including billing and reads',async t=>{const f=await fixture(t);
 for(const url of ['/v1/capabilities','/v1/billing','/v1/invoices','/v1/invoices/fake']){const r=await f.request(f.api_key,IP,url);assert.equal(r.statusCode,403,url);assert.equal(r.json().error.code,'API_SERVER_REQUIRED');}
 const post=await f.app.inject({method:'POST',url:'/v1/invoices',remoteAddress:IP,headers:{authorization:'Bearer '+f.api_key,'idempotency-key':'blocked-order-1'},payload:{order_id:'order-1',amount:100,method:'qr'}});assert.equal(post.statusCode,403);assert.equal(f.store.listInvoices().length,0);
 assert.equal((await f.app.inject({url:'/account/overview',headers:{cookie:f.cookie}})).statusCode,200);assert.equal((await f.app.inject({url:'/docs'})).statusCode,200);
});

test('API IP: owner confirms password, invalid addresses rejected and foreign IP denied',async t=>{const f=await fixture(t);
 const wrong=await f.bind(IP,'incorrect-password');assert.equal(wrong.statusCode,401);assert.equal(f.store.merchant(f.id).api_ip,null);
 assert.equal((await f.bind('10.0.0.1')).statusCode,400);assert.equal((await f.bind(IP+'/32')).statusCode,400);
 const bound=await f.bind(IP);assert.equal(bound.statusCode,200);assert.equal(bound.json().api_ip,IP);assert.notEqual(bound.json().api_key,f.api_key);
 assert.equal((await f.request(f.api_key)).statusCode,401);
 for(const url of ['/v1/capabilities','/v1/billing','/v1/invoices','/v1/invoices/fake']){const wrongIp=await f.request(bound.json().api_key,OTHER,url);assert.equal(wrongIp.statusCode,403);assert.equal(wrongIp.json().error.code,'API_IP_NOT_ALLOWED');}
 const allowed=await f.request(bound.json().api_key);assert.equal(allowed.statusCode,200);assert.equal(allowed.json().api_server_ip,IP);
 assert.equal((await f.request(bound.json().api_key,'::ffff:93.184.216.34')).statusCode,200);
});

test('API IP: changing server revokes previous key, plain key rotation preserves binding',async t=>{const f=await fixture(t);const first=(await f.bind(IP)).json();const second=(await f.bind(OTHER)).json();assert.equal((await f.request(first.api_key,IP)).statusCode,401);assert.equal((await f.request(second.api_key,IP)).statusCode,403);assert.equal((await f.request(second.api_key,OTHER)).statusCode,200);
 const rotated=await f.app.inject({method:'POST',url:'/account/key',headers:{cookie:f.cookie},payload:{}});assert.equal(rotated.statusCode,200);assert.equal((await f.request(rotated.json().api_key,OTHER)).statusCode,200);assert.equal((await f.request(rotated.json().api_key,IP)).statusCode,403);
 const audit=f.store.db.prepare("SELECT detail FROM audit WHERE action='api.server_bound' ORDER BY id").all();assert.deepEqual(audit.map(a=>a.detail),[IP,OTHER]);
});

test('API IP: untrusted direct clients cannot spoof forwarded headers',async t=>{const f=await fixture(t);const bound=(await f.bind(IP)).json();const r=await f.request(bound.api_key,OTHER,'/v1/capabilities',{'x-forwarded-for':IP,'x-real-ip':IP,forwarded:'for='+IP});assert.equal(r.statusCode,403);
 assert.equal((await f.request(bound.api_key,IP,'/v1/capabilities',{'x-forwarded-for':OTHER})).statusCode,200);
});

test('API IP: one trusted proxy requires a single valid client IP and refuses ambiguous chains',async t=>{const f=await fixture(t,['127.0.0.1']);const key=(await f.bind(IP)).json().api_key;
 assert.equal((await f.request(key,'127.0.0.1','/v1/capabilities',{'x-forwarded-for':IP})).statusCode,200);
 assert.equal((await f.request(key,'::ffff:127.0.0.1','/v1/billing',{'x-forwarded-for':IP})).statusCode,200);
 for(const value of [undefined,'garbage',IP+', '+OTHER,OTHER+', '+IP]){const r=await f.request(key,'127.0.0.1','/v1/capabilities',value?{'x-forwarded-for':value}:{});assert.equal(r.statusCode,403);}
 assert.equal((await f.request(key,OTHER,'/v1/capabilities',{'x-forwarded-for':IP})).statusCode,403);
});

test('API IP: full IPv6 spelling and canonical address match exactly',async t=>{const f=await fixture(t);const bound=await f.bind('2606:4700:0000:0000:0000:0000:0000:1111');assert.equal(bound.statusCode,200);assert.equal(bound.json().api_ip,'2606:4700::1111');assert.equal((await f.request(bound.json().api_key,'2606:4700::1111')).statusCode,200);assert.equal((await f.request(bound.json().api_key,'2606:4700::1001')).statusCode,403);
});

test('API IP: binding cannot target another tenant or be performed using the Bearer key',async t=>{const f=await fixture(t);const foreign=f.store.createMerchant({name:'Other tenant',account_label:'Other tenant',webhook_url:''});
 const attack=await f.app.inject({method:'POST',url:'/account/api-server',headers:{cookie:f.cookie},payload:{ip:IP,password:'Strong-password-123',merchant_id:foreign.merchant.id}});assert.equal(attack.statusCode,400);assert.equal(f.store.merchant(foreign.merchant.id).api_ip,null);
 assert.equal((await f.app.inject({method:'POST',url:'/account/api-server',headers:{authorization:'Bearer '+f.api_key},payload:{ip:IP,password:'Strong-password-123'}})).statusCode,401);
 assert.equal((await f.app.inject({method:'POST',url:`/admin/merchants/${foreign.merchant.id}/api-server`,headers:{cookie:f.cookie},payload:{ip:IP}})).statusCode,401);
});

test('API IP: old databases get unbound fields without silently trusting current requester',async t=>{const directory=mkdtempSync(path.join(tmpdir(),'mb-ip-migration-'));const c={mode:'sandbox',key:randomBytes(32),dataDir:directory};let s=new Store(c);const company=s.createMerchant({name:'Legacy',account_label:'Legacy',webhook_url:''});s.db.exec('ALTER TABLE merchants DROP COLUMN api_ip; ALTER TABLE merchants DROP COLUMN api_ip_updated_at;');s.close();s=new Store(c);try{assert.equal(s.merchant(company.merchant.id).api_ip,null);assert.equal(s.merchant(company.merchant.id).api_ip_updated_at,null);}finally{s.close();rmSync(directory,{recursive:true,force:true});}});

test('API IP: trusted proxy configuration accepts exact addresses, rejects wildcards and CIDR',()=>{const env={ENCRYPTION_KEY:randomBytes(32).toString('base64'),ADMIN_PASSWORD:'a'.repeat(24)};assert.deepEqual(loadConfig({...env,TRUSTED_PROXY_IPS:'127.0.0.1,::1'}).trustedProxyIps,['127.0.0.1','::1']);for(const proxy of ['*','true','127.0.0.1/8','localhost'])assert.throws(()=>loadConfig({...env,TRUSTED_PROXY_IPS:proxy}));
 const req={raw:{socket:{remoteAddress:'127.0.0.1'}},headers:{'x-forwarded-for':IP}};assert.equal(clientServerIp(req,{}),'127.0.0.1');
});
