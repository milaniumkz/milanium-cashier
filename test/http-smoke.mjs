// Uses real local HTTP sockets and the sandbox only. No banking/network calls.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.js';

const c={mode:'sandbox',production:false,key:randomBytes(32),adminPassword:randomBytes(24).toString('base64url'),baseUrl:'http://127.0.0.1',dataDir:mkdtempSync(path.join(tmpdir(),'cashier-http-')),pollMs:1000,webhookOrigins:[]};
const app=await buildApp(c,{logger:false});
try{
  c.baseUrl=await app.listen({host:'127.0.0.1',port:0});
  const request=async(url,method='GET',body,headers={})=>{
    const r=await fetch(c.baseUrl+url,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.ok(r.ok,`${method} ${url}: ${r.status}`);return r;
  };
  assert.match(await(await request('/')).text(),/android-dialog/);
  for(const asset of ['app.js','checkout.js','style.css'])await request('/assets/'+asset);
  const login=await request('/admin/login','POST',{password:c.adminPassword});
  const admin={Cookie:login.headers.get('set-cookie').split(';')[0]};
  const a=await(await request('/admin/merchants','POST',{name:'HTTP test',account_label:'HTTP test'},admin)).json();
  const api={Authorization:'Bearer '+a.api_key,'Idempotency-Key':'http-test-key-1'};
  const body={order_id:'http-test-1',amount:15000,method:'qr'};
  const invoice=await(await request('/v1/invoices','POST',body,api)).json();
  const waitFor=async(status)=>{for(let n=0;n<80;n++){const i=await(await request('/v1/invoices/'+invoice.id,'GET',undefined,api)).json();if(i.status===status)return i;await delay(100);}throw new Error('Timed out waiting for '+status);};
  const pending=await waitFor('pending');assert.equal(pending.qr_available,true);
  const publicToken=new URL(invoice.checkout_url).pathname.split('/').pop();
  const payment=await(await request('/public/payments/'+publicToken)).json();
  const qr=await request(payment.qr_url);assert.equal(qr.headers.get('content-type'),'image/png');
  assert.ok((await qr.arrayBuffer()).byteLength>100);
  assert.match(await(await request('/p/'+publicToken)).text(),/checkout.js/);
  await request('/sandbox/payments/'+publicToken,'POST',{state:'paid'});
  const paid=await waitFor('paid');assert.equal(paid.qr_available,false);assert.equal(paid.payment_url,null);
  const replay=await(await request('/v1/invoices','POST',body,api)).json();assert.equal(replay.id,invoice.id);assert.equal(replay.replay,true);
  const overview=await(await request('/admin/overview','GET',undefined,admin)).json();assert.equal(overview.invoices.length,1);assert.ok(overview.events.length>=3);
  console.log('PASS real HTTP: admin → company → invoice → worker → QR → sandbox payment → confirmed status → idempotent replay');
}finally{await app.close();rmSync(c.dataDir,{recursive:true,force:true});}
