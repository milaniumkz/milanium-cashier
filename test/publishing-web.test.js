import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildApp} from '../src/app.js';
import {normalizeCommunityUrl} from '../src/publishing-web.js';
test('web community links normalize only supported official destinations',()=>{
 assert.deepEqual(normalizeCommunityUrl('https://m.vk.ru/club12345/?from=share#x'),{network:'vk',url:'https://vk.com/club12345'});
 assert.deepEqual(normalizeCommunityUrl('https://www.ok.ru/group/12345?st.ref=share'),{network:'ok',url:'https://ok.ru/group/12345'});
 assert.deepEqual(normalizeCommunityUrl('https://vk.com/wall-12345_678?share=1'),{network:'vk',url:'https://vk.com/club12345'});
 assert.deepEqual(normalizeCommunityUrl('https://ok.ru/group/12345/topic/678'),{network:'ok',url:'https://ok.ru/group/12345'});
 for(const input of ['javascript:alert(1)','http://vk.com/group','https://vk.com.evil.test/club123','https://vk.com@evil.test/club123','https://user:pass@vk.com/club123','https://vk.com:8443/club123','https://ok.ru/profile/123','https://vk.com/away?to=https://evil.test','https://vk.com/id12345','https://vk.com/%61way'])assert.throws(()=>normalizeCommunityUrl(input),{code:'COMMUNITY_URL_INVALID'},input);
});
test('web groups require no platform application, remain unverified, isolate companies and deduplicate',async t=>{
 const config={mode:'sandbox',production:false,key:randomBytes(32),adminPassword:randomBytes(24).toString('base64url'),baseUrl:'http://127.0.0.1:3080',dataDir:mkdtempSync(path.join(tmpdir(),'publishing-web-')),pollMs:1000,webhookOrigins:[]};const app=await buildApp(config,{background:false,logger:false});t.after(async()=>{await app.close();rmSync(config.dataDir,{recursive:true,force:true});});
 const req=(method,url,payload,cookie)=>app.inject({method,url,...(payload===undefined?{}:{payload}),headers:cookie?{cookie}:{},remoteAddress:'93.184.216.34'});
 async function owner(login){const r=await req('POST','/auth/register',{login,password:'Synthetic-password-123',company:login});assert.equal(r.statusCode,201,r.body);return r.headers['set-cookie'].split(';')[0];}
 const a=await owner('web.owner.a'),b=await owner('web.owner.b');assert.equal((await req('GET','/account/publishing/web')).statusCode,401);
 const body={name:'My group',url:'https://vk.com/club12345?from=share',confirmed_rights:true};const first=await req('POST','/account/publishing/web/groups',body,a);assert.equal(first.statusCode,200,first.body);assert.equal(first.json().verified,false);const repeat=await req('POST','/account/publishing/web/groups',{...body,url:'https://m.vk.com/club12345'},a);assert.equal(first.json().id,repeat.json().id);
 assert.equal((await req('GET','/account/publishing/web',undefined,b)).json().items.length,0);const state=(await req('GET','/account/publishing/web',undefined,a)).json();assert.equal(state.items.length,1);assert.equal(state.authenticated,false);assert.equal(state.automatic_publishing,false);assert.equal((await req('DELETE','/account/publishing/web/groups/'+first.json().id,undefined,b)).statusCode,404);assert.equal((await req('POST','/account/publishing/web/groups',{...body,confirmed_rights:false},a)).statusCode,400);assert.equal((await req('DELETE','/account/publishing/web/groups/'+first.json().id,undefined,a)).statusCode,200);
});
