import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/app.js';
import { Store } from '../src/db.js';
import { businessDay } from '../src/business.js';

async function fixture(t){const config={mode:'sandbox',production:false,key:randomBytes(32),adminPassword:randomBytes(24).toString('base64url'),baseUrl:'http://127.0.0.1:3080',dataDir:mkdtempSync(path.join(tmpdir(),'mbusiness-test-')),pollMs:1000,webhookOrigins:['https://example.com']};const store=new Store(config);const app=await buildApp(config,{store,background:false,logger:false});const inject=app.inject.bind(app);app.inject=options=>inject({remoteAddress:'93.184.216.34',...options});t.after(async()=>{await app.close();store.close();rmSync(config.dataDir,{recursive:true,force:true});});
 const req=(method,url,payload,cookie,idem)=>app.inject({method,url,...(payload===undefined?{}:{payload}),headers:{...(cookie?{cookie}:{}),...(idem?{'idempotency-key':idem}:{})}});
 const reg=async(login='owner.one',company='Company One')=>{const res=await req('POST','/auth/register',{login,password:'Strong-password-123',company});assert.equal(res.statusCode,201,res.body);const cookie=res.headers['set-cookie'].split(';')[0],overview=(await req('GET','/account/overview',undefined,cookie)).json();const bound=await req('POST','/account/api-server',{ip:'93.184.216.34',password:'Strong-password-123'},cookie);assert.equal(bound.statusCode,200,bound.body);return {cookie,overview,...res.json(),...bound.json()};};
 const adminRes=await req('POST','/admin/login',{password:config.adminPassword});const admin=adminRes.headers['set-cookie'].split(';')[0];
 const fund=async(owner,amount=100000,idem='topup-funding-1',reference='BANK-TRANSFER-1')=>{const r=await req('POST','/account/topups',{amount},owner.cookie,idem);assert.equal(r.statusCode,200,r.body);const done=await req('POST',`/admin/topups/${r.json().id}/review`,{decision:'approved',bank_reference:reference},admin);assert.equal(done.statusCode,200,done.body);return r.json();};
 const subscribe=async(owner,plan='start',idem='subscribe-start-1')=>{const r=await req('POST','/account/subscription',{plan},owner.cookie,idem);assert.equal(r.statusCode,200,r.body);return r.json();};
 return {app,store,config,req,reg,admin,fund,subscribe,...app.services};}
const payload=(id='order-1001')=>({order_id:id,amount:15000,method:'qr'});

test('MBusiness: registration hashes password, scopes company and issues HttpOnly session',async t=>{const f=await fixture(t);const a=await f.reg('Owner.One');assert.equal(a.overview.user.login,'owner.one');assert.equal(a.overview.billing.balance,0);assert.equal(a.overview.billing.active,false);assert.ok(a.api_key.startsWith('mk_'));
 const user=f.store.db.prepare('SELECT * FROM business_users').get();assert.ok(!user.password_hash.includes('Strong-password'));assert.equal(a.overview.company.api_hash,undefined);assert.equal(a.overview.company.webhook_secret,undefined);
 const duplicate=await f.req('POST','/auth/register',{login:'OWNER.ONE',password:'Strong-password-123',company:'Other'});assert.equal(duplicate.statusCode,409);assert.equal(f.store.merchants().length,1);
 assert.equal((await f.req('POST','/auth/register',{login:'weak',password:'short',company:'Test'})).statusCode,400);
 const login=await f.req('POST','/auth/login',{login:'OWNER.ONE',password:'Strong-password-123'});assert.equal(login.statusCode,200);assert.match(login.headers['set-cookie'],/HttpOnly/);assert.match(login.headers['set-cookie'],/SameSite=Strict/);
 const sessionHash=f.store.db.prepare('SELECT hash FROM business_sessions LIMIT 1').get().hash;assert.ok(!a.cookie.includes(sessionHash));
 assert.equal((await f.req('POST','/auth/login',{login:'missing',password:'Strong-password-123'})).statusCode,401);
});

test('MBusiness: tenant cannot access another company, operator routes, money approval or invoice',async t=>{const f=await fixture(t),a=await f.reg(),b=await f.reg('owner.two','Company Two');await f.fund(a);await f.subscribe(a);
 const created=await f.req('POST','/account/invoices',payload(),a.cookie,'first-tenant-order');assert.equal(created.statusCode,201);const id=created.json().id;
 for(const suffix of ['', '/audit'])assert.equal((await f.req('GET','/account/invoices/'+id+suffix,undefined,b.cookie)).statusCode,404);
 assert.equal((await f.req('POST',`/account/invoices/${id}/retry`,{},b.cookie)).statusCode,404);
 assert.equal((await f.req('GET','/admin/overview',undefined,a.cookie)).statusCode,401);
 assert.equal((await f.req('GET','/admin/topups',undefined,a.cookie)).statusCode,401);
 assert.equal((await f.req('POST','/admin/topups/fake/review',{decision:'approved',bank_reference:'FAKE'},a.cookie)).statusCode,401);
 assert.equal((await f.req('POST','/account/invoices',{...payload(),merchant_id:a.overview.company.id},b.cookie,'forged-tenant-order')).statusCode,400);
 const overview=(await f.req('GET','/account/overview',undefined,b.cookie)).json();assert.equal(overview.invoices.length,0);assert.equal(overview.ledger.length,0);assert.equal(overview.events.length,0);
 const foreign=await f.app.inject({url:'/v1/invoices/'+id,headers:{authorization:'Bearer '+b.api_key}});assert.equal(foreign.statusCode,404);
});

test('MBusiness: pending topup gives no money, only one verified bank transfer can credit it',async t=>{const f=await fixture(t),a=await f.reg();const pending=await f.req('POST','/account/topups',{amount:25000},a.cookie,'manual-topup-1');const id=pending.json().id;
 assert.equal(f.business.snapshot(a.overview.company.id).balance,0);assert.equal((await f.req('POST','/account/subscription',{plan:'start'},a.cookie,'purchase-no-money')).statusCode,402);
 const duplicate=await f.req('POST','/account/topups',{amount:25000},a.cookie,'manual-topup-1');assert.equal(duplicate.json().id,id);
 assert.equal((await f.req('POST','/account/topups',{amount:30000},a.cookie,'manual-topup-1')).statusCode,409);
 assert.equal((await f.req('POST',`/admin/topups/${id}/review`,{decision:'approved'},f.admin)).statusCode,400);
 const approve=()=>f.req('POST',`/admin/topups/${id}/review`,{decision:'approved',bank_reference:'BANK-ONE'},f.admin);
 assert.equal((await approve()).statusCode,200);assert.equal((await approve()).json().replay,true);assert.equal(f.business.snapshot(a.overview.company.id).balance,25000);
 const next=(await f.req('POST','/account/topups',{amount:10000},a.cookie,'manual-topup-2')).json();assert.equal((await f.req('POST',`/admin/topups/${next.id}/review`,{decision:'approved',bank_reference:'BANK-ONE'},f.admin)).statusCode,409);
 await f.req('POST',`/admin/topups/${next.id}/review`,{decision:'rejected'},f.admin);assert.equal(f.business.snapshot(a.overview.company.id).balance,25000);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM business_ledger').get().n,1);
});

test('MBusiness: subscription charges once per idempotency key and same-plan renewal extends month',async t=>{const f=await fixture(t),a=await f.reg();await f.fund(a);const first=await f.subscribe(a,'business','monthly-subscription-1');assert.equal(first.billing.balance,75000);assert.equal(first.billing.plan.daily_limit,200);
 const repeat=await f.subscribe(a,'business','monthly-subscription-1');assert.equal(repeat.replay,true);assert.equal(repeat.billing.expires_at,first.billing.expires_at);assert.equal(repeat.billing.balance,75000);
 assert.equal((await f.req('POST','/account/subscription',{plan:'pro'},a.cookie,'monthly-subscription-1')).statusCode,409);
 const next=await f.subscribe(a,'business','monthly-subscription-2');assert.ok(next.billing.expires_at>first.billing.expires_at+27*86400000);assert.equal(next.billing.balance,50000);
});

test('MBusiness: 50 concurrent creates reserve only 50 slots; replay remains available after expiry',async t=>{const f=await fixture(t),a=await f.reg();await f.fund(a,10000);await f.subscribe(a);
 const responses=await Promise.all(Array.from({length:51},(_,i)=>f.req('POST','/account/invoices',payload('order-'+i),a.cookie,'daily-order-key-'+i)));
 assert.equal(responses.filter(r=>r.statusCode===201).length,50);assert.equal(responses.filter(r=>r.statusCode===429).length,1);assert.equal(f.business.snapshot(a.overview.company.id).used_today,50);assert.equal(f.business.snapshot(a.overview.company.id).balance,0);
 f.store.db.prepare('UPDATE business_wallets SET expires_at=?').run(Date.now()-1);
 const replay=await f.req('POST','/account/invoices',payload('order-0'),a.cookie,'daily-order-key-0');assert.equal(replay.statusCode,200);assert.equal(replay.json().replay,true);
 assert.equal((await f.req('POST','/account/invoices',payload('new-order'),a.cookie,'expired-new-order')).statusCode,402);
 assert.equal((await f.req('GET','/account/invoices/'+replay.json().id,undefined,a.cookie)).statusCode,200);
 const apiReplay=await f.app.inject({method:'POST',url:'/v1/invoices',headers:{authorization:'Bearer '+a.api_key,'idempotency-key':'daily-order-key-0'},payload:payload('order-0')});assert.equal(apiReplay.statusCode,200);
});

test('MBusiness: failed-before-submit releases daily slot; uncertain submission retains it; retry re-reserves',async t=>{const f=await fixture(t),a=await f.reg();await f.fund(a);await f.subscribe(a);const result=(await f.req('POST','/account/invoices',payload(),a.cookie,'safe-retry-order')).json();
 f.worker.driver={create:async()=>{throw new Error('before submit');}};await f.worker.create(f.store.invoice(result.id));assert.equal(f.business.snapshot(a.overview.company.id).used_today,0);
 assert.equal((await f.req('POST','/account/invoices/'+result.id+'/retry',{},a.cookie)).statusCode,200);assert.equal(f.business.snapshot(a.overview.company.id).used_today,1);
 f.worker.driver={create:async(_m,_i,before)=>{before();throw new Error('after submit');},close:async()=>{}};await f.worker.create(f.store.invoice(result.id));assert.equal(f.store.invoice(result.id).status,'unknown');assert.equal(f.business.snapshot(a.overview.company.id).used_today,1);assert.equal((await f.req('POST','/account/invoices/'+result.id+'/retry',{},a.cookie)).statusCode,409);
});

test('MBusiness: subscription and quotas also gate Bearer API without access to UI',async t=>{const f=await fixture(t),a=await f.reg();const headers={authorization:'Bearer '+a.api_key,'idempotency-key':'api-order-key-1'};
 assert.equal((await f.app.inject({method:'POST',url:'/v1/invoices',headers,payload:payload()})).statusCode,402);
 await f.fund(a);await f.subscribe(a);assert.equal((await f.app.inject({method:'POST',url:'/v1/invoices',headers,payload:payload()})).statusCode,201);
 assert.equal((await f.app.inject({url:'/v1/billing',headers})).json().used_today,1);
 await f.req('POST','/account/key',{},a.cookie);assert.equal((await f.app.inject({url:'/v1/invoices',headers})).statusCode,401);
});

test('MBusiness: password rotation revokes all previous sessions, logout revokes current session',async t=>{const f=await fixture(t),a=await f.reg();const second=await f.req('POST','/auth/login',{login:'owner.one',password:'Strong-password-123'});const secondCookie=second.headers['set-cookie'].split(';')[0];
 const changed=await f.req('POST','/account/password',{current_password:'Strong-password-123',password:'Different-password-456'},a.cookie);assert.equal(changed.statusCode,200);assert.equal((await f.req('GET','/account/overview',undefined,secondCookie)).statusCode,401);assert.equal((await f.req('GET','/account/overview',undefined,a.cookie)).statusCode,401);
 const current=changed.headers['set-cookie'].split(';')[0];assert.equal((await f.req('GET','/account/overview',undefined,current)).statusCode,200);assert.equal((await f.req('POST','/auth/logout',{},current)).statusCode,200);assert.equal((await f.req('GET','/account/overview',undefined,current)).statusCode,401);
});

test('MBusiness: cross-origin registration rejected and expiry invalidates stored cookie',async t=>{const f=await fixture(t);assert.equal((await f.app.inject({method:'POST',url:'/auth/register',headers:{origin:'https://evil.example'},payload:{login:'attacker',password:'Strong-password-123',company:'Attack'}})).statusCode,403);
 const a=await f.reg();f.store.db.prepare('UPDATE business_sessions SET expires_at=?').run(Date.now()-1);assert.equal((await f.req('GET','/account/overview',undefined,a.cookie)).statusCode,401);
});

test('MBusiness: individual contract requires admin quote and can be activated from company balance',async t=>{const f=await fixture(t),a=await f.reg();await f.fund(a,200000);assert.equal((await f.req('POST','/account/subscription',{plan:'individual'},a.cookie,'custom-purchase-1')).statusCode,400);
 assert.equal((await f.req('POST','/account/individual-plan',{daily_limit:1000,comment:'Contact owner'},a.cookie)).statusCode,200);
 const id=a.overview.company.id;assert.equal((await f.req('POST',`/admin/merchants/${id}/contract`,{price:120000,daily_limit:1000},a.cookie)).statusCode,401);
 assert.equal((await f.req('POST',`/admin/merchants/${id}/contract`,{price:120000,daily_limit:1000},f.admin)).statusCode,200);
 const result=await f.subscribe(a,'individual','custom-purchase-1');assert.equal(result.billing.plan.daily_limit,1000);assert.equal(result.billing.balance,80000);
 assert.equal((await f.req('POST',`/admin/merchants/${id}/contract`,{price:130000,daily_limit:1500},f.admin)).statusCode,409);
});

test('MBusiness: day boundary follows Asia/Almaty, not UTC',()=>{assert.equal(businessDay(Date.parse('2026-11-02T18:59:59Z')),'2026-11-02');assert.equal(businessDay(Date.parse('2026-11-02T19:00:00Z')),'2026-11-03');});
