// Read-only deployment checks. Does not register users, create invoices, or call the bank.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
const base=new URL(process.env.MBUSINESS_PUBLIC_URL||'https://mbusiness.89.126.192.185.sslip.io:8443');
assert.equal(base.protocol,'https:');assert.ok(!base.username&&!base.password);assert.equal(base.pathname,'/');
const request=(path,options={})=>fetch(new URL(path,base),{redirect:'error',signal:AbortSignal.timeout(15000),...options});
const health=await request('/healthz');assert.equal(health.status,200);assert.deepEqual(await health.json(),{ok:true});
assert.equal(health.headers.get('x-frame-options'),'DENY');assert.ok(health.headers.get('strict-transport-security'));
const home=await request('/');assert.equal(home.status,200);assert.match(await home.text(),/MBusiness/);
const docs=await request('/docs');assert.equal(docs.status,200);assert.match(await docs.text(),/API_IP_NOT_ALLOWED/);
for(const asset of ['business.js','business.css','favicon.svg'])assert.equal((await request('/assets/'+asset)).status,200);
assert.equal((await request('/operator')).status,200);
for(const path of ['/account/overview','/admin/overview','/v1/capabilities','/v1/billing'])assert.equal((await request(path)).status,401,path);
const payload=JSON.stringify({login:'mbusiness.healthcheck',password:randomBytes(24).toString('base64url')});
const wrongOrigin=await request('/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://untrusted.example'},body:payload});assert.equal(wrongOrigin.status,403);
const login=await request('/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:base.origin},body:payload});assert.equal(login.status,401);
console.log('PASS public HTTPS: health, MBusiness portal, docs, assets, security headers, protected company/admin/API routes and login origin checks. No user or payment was created.');
