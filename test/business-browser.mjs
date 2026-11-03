import { chromium } from 'playwright-core';
import { buildApp } from '../src/app.js';
import { randomBytes } from 'node:crypto';
import { mkdtempSync,rmSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApp as createAccountingApp } from '../modules/muchet/server/src/app.js';
import { randomUUID } from 'node:crypto';
const config={mode:'sandbox',production:false,key:randomBytes(32),adminPassword:randomBytes(24).toString('base64url'),baseUrl:'http://127.0.0.1',dataDir:mkdtempSync(path.join(tmpdir(),'mbusiness-browser-')),pollMs:1000,webhookOrigins:['https://example.com']};
if(!process.env.DATABASE_URL)throw new Error('An isolated PostgreSQL test database is required');
process.env.MBUSINESS_BRIDGE_SECRET=randomBytes(32).toString('hex');
const accountingSchema='test_'+randomUUID().replaceAll('-','');
const accounting=await createAccountingApp({schema:accountingSchema,dataDir:config.dataDir+'/accounting'});
config.accountingUrl=await accounting.listen({host:'127.0.0.1',port:0});config.accountingBridgeSecret=process.env.MBUSINESS_BRIDGE_SECRET;
config.accountingWebRoot=path.resolve('modules/muchet/build/web');
const app=await buildApp(config,{logger:false});let browser;const errors=[];const screenshots=path.resolve('artifacts/mbusiness');mkdirSync(screenshots,{recursive:true});
try{
 config.baseUrl=await app.listen({host:'127.0.0.1',port:0});
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox'],env:process.env});
 const context=await browser.newContext({viewport:{width:1440,height:1050},deviceScaleFactor:1});const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('401'))errors.push(m.text());});
 await page.goto(config.baseUrl);await page.getByRole('button',{name:'Регистрация',exact:true}).click();await page.screenshot({path:screenshots+'/01-registration.png',fullPage:true});
 const password=randomBytes(24).toString('base64url');await page.locator('#auth-form [name=company]').fill('ТОО Example');await page.locator('#auth-form [name=login]').fill('owner.example');await page.locator('#auth-form [name=password]').fill(password);await page.locator('#auth-submit').click();await page.getByRole('button',{name:'Ключи сохранены'}).click();
 await page.locator('#setup-form [name=legalName]').waitFor();await page.screenshot({path:screenshots+'/15-company-setup.png',fullPage:true});await page.locator('#setup-form [name=legalName]').fill('ТОО Example Setup');await page.locator('#setup-form [name=legalForm]').selectOption('TOO');await page.locator('#setup-form [name=taxRegime]').selectOption('GENERAL');await page.locator('#setup-form [name=vatRegistered]').selectOption('false');await page.locator('#setup-form [type=submit]').click();
 await page.locator('#setup-form [name=legalAddress]').fill('Черновик адреса');await page.getByText('Черновик сохранён',{exact:true}).waitFor();await page.reload();await page.locator('#setup-form [name=legalAddress]').waitFor();assert.equal(await page.locator('#setup-form [name=legalAddress]').inputValue(),'Черновик адреса');await page.locator('#setup-skip').click();
 await page.locator('#setup-form [name=name]').fill('Касса Example');await page.locator('#setup-form [type=submit]').click();
 for(let step=0;step<4;step++){await page.locator('#setup-skip').click();}
 await page.locator('#setup-form [name=startDate]').fill('2026-11-03');await page.locator('#setup-form [name=balanceMode]').selectOption('zero');await page.locator('#setup-form [type=submit]').click();await page.locator('#setup-finish').click();await page.locator('#accounting-frame').waitFor();await page.frameLocator('#accounting-frame').locator('flutter-view').waitFor();await page.screenshot({path:screenshots+'/02-accounting.png',fullPage:true});
 await page.locator('.accounting-loading').waitFor({state:'hidden',timeout:45000});
 const originalAccountingFrame=page.frames().find(f=>f.url().includes('/accounting/'));
 await originalAccountingFrame.evaluate(()=>document.querySelector('flt-semantics-placeholder')?.click());
 let repeatedBundles=0;const countBundle=request=>{if(/main\.dart\.js|canvaskit\.wasm/.test(request.url()))repeatedBundles++;};page.on('request',countBundle);
 for(const [section,label] of [['cash','Касса и денежные счета'],['inventory','Складские остатки'],['debts','Добавить начальный долг'],['catalog','Товары и услуги'],['home','Обновить главную']]){
  await page.locator('.side [data-view='+section+']').click();
  assert.equal(page.frames().find(f=>f.url().includes('/accounting/')),originalAccountingFrame,'accounting frame was recreated for '+section);
  await originalAccountingFrame.getByText(label,{exact:true}).or(originalAccountingFrame.getByLabel(label,{exact:true})).first().waitFor({state:'visible',timeout:15000});
  assert.equal(await page.locator('.accounting-loading').isVisible(),false);
 }
 page.off('request',countBundle);assert.equal(repeatedBundles,0,'navigation downloaded the accounting engine again');

 await page.setViewportSize({width:1366,height:650});
 const sideBounds=await page.locator('.side-bottom').boundingBox();assert.ok(sideBounds.y+sideBounds.height<=650,'sidebar footer is clipped on a short desktop viewport');
 await page.setViewportSize({width:1440,height:1050});
 const accountingResponse=await page.evaluate(async()=>{const r=await fetch('/accounting-api/v1/companies');return {status:r.status,items:await r.json()};});assert.equal(accountingResponse.status,200);assert.equal(accountingResponse.items.length,1);assert.equal(accountingResponse.items[0].name,'ТОО Example');
 const savedSetup=await page.evaluate(async id=>{const r=await fetch('/accounting-api/v1/companies/'+id+'/setup');return r.json();},accountingResponse.items[0].id);assert.equal(savedSetup.finished,true);assert.equal(savedSetup.states.company,'done');assert.equal(savedSetup.states.projects,'skipped');assert.equal(savedSetup.counts.wallets,1);
 await page.locator('[data-view=setup]').click();await page.locator('[data-step=projects]').click();
 for(const [step,name]of [['projects','Проект Example'],['warehouses','Основной склад'],['partners','Покупатель Example'],['catalog','Услуга Example']]){
  if(step!=='projects')await page.locator('[data-step='+step+']').click();
  await page.locator('#setup-form [name=name]').fill(name);await page.locator('#setup-form [type=submit]').click();await page.locator('.setup-form [data-open]').first().waitFor();
 }
 await page.locator('[data-step=details]').click();await page.locator('#setup-form [name=legalAddress]').waitFor();assert.equal(await page.locator('#setup-form [name=legalAddress]').inputValue(),'Черновик адреса');await page.locator('#setup-form [type=submit]').click();await page.locator('#setup-finish').click();await page.locator('#accounting-frame').waitFor();
 const completedSetup=await page.evaluate(async id=>(await fetch('/accounting-api/v1/companies/'+id+'/setup')).json(),accountingResponse.items[0].id);for(const step of ['projects','warehouses','partners','catalog'])assert.equal(completedSetup.counts[step],1);assert.equal(completedSetup.settings.legal_address,'Черновик адреса');
 const operatorContext=await browser.newContext();const operator=await operatorContext.newPage();operator.on('pageerror',e=>errors.push('operator: '+e.message));await operator.goto(config.baseUrl+'/operator');await operator.locator('#login-form [name=password]').fill(config.adminPassword);await operator.locator('#login-form [type=submit]').click();await operator.locator('[data-view=billing]').click();await operator.locator('#service-cashier-form [name=account_label]').fill('MBusiness Billing');await operator.locator('#service-cashier-form [name=enabled]').check();await operator.locator('#service-cashier-form [type=submit]').click();
 await page.locator('#integrations-toggle').click();await page.locator('[data-view=kaspi]').click();await page.locator('.kaspi-tabs [data-go=balance]').click();await page.locator('[data-plan=start]').click();await page.screenshot({path:screenshots+'/03-tariff-method.png',fullPage:true});await page.locator('#plan-form [type=submit]').click();await page.locator('.subscription-qr').waitFor();
 const tariffCheckout=await page.locator('#dialog-content a').filter({hasText:'Страница оплаты'}).getAttribute('href');const tariffToken=new URL(tariffCheckout).pathname.split('/').pop();const tariffPaid=await fetch(config.baseUrl+'/sandbox/payments/'+tariffToken,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state:'paid'})});assert.ok(tariffPaid.ok);await page.getByRole('heading',{name:'Тариф активирован'}).waitFor();await page.locator('#close-dialog').click();await page.screenshot({path:screenshots+'/04-tariff-paid.png',fullPage:true});
 await page.locator('.kaspi-tabs [data-go=payments]').click();await page.getByRole('button',{name:'Создать счёт',exact:false}).first().click();await page.locator('#invoice-form [name=amount]').fill('15000');await page.screenshot({path:screenshots+'/04-new-invoice.png',fullPage:true});await page.locator('#invoice-form [type=submit]').click();await page.locator('#dialog-content a.primary').waitFor();const checkout=await page.locator('#dialog-content a.primary').getAttribute('href');
 const buyer=await context.newPage();await buyer.goto(checkout);await buyer.locator('#qr').waitFor({state:'visible'});await buyer.screenshot({path:screenshots+'/05-checkout.png',fullPage:true});
 const token=new URL(checkout).pathname.split('/').pop();const paid=await fetch(config.baseUrl+'/sandbox/payments/'+token,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state:'paid'})});assert.ok(paid.ok);await buyer.getByText('Оплата подтверждена',{exact:true}).waitFor();
 await page.locator('#close-dialog').click();await page.locator('.kaspi-tabs [data-go=overview]').click();await page.waitForFunction(()=>document.querySelector('#content').textContent.includes('15 000'));await page.screenshot({path:screenshots+'/06-dashboard.png',fullPage:true});
 await page.locator('.kaspi-tabs [data-go=cashier]').click();await page.screenshot({path:screenshots+'/07-cashier.png',fullPage:true});await page.locator('.kaspi-tabs [data-go=integration]').click();
 await page.locator('#api-server-form [name=ip]').fill('93.184.216.34');await page.locator('#api-server-form [name=password]').fill(password);await page.locator('#api-server-form [type=submit]').click();await page.getByRole('button',{name:'Ключи сохранены'}).click();
 await page.locator('#content').getByText('93.184.216.34',{exact:true}).waitFor();await page.screenshot({path:screenshots+'/08-api.png',fullPage:true});
 await page.locator('[data-view=settings]').click();await page.locator('#company-form [name=name]').fill('ТОО Example Updated');await page.locator('#company-form [type=submit]').click();await page.locator('#company-name').getByText('ТОО Example Updated',{exact:true}).waitFor();
 await page.goto(config.baseUrl+'/docs');await page.getByRole('heading',{name:'Создание счёта',exact:true}).waitFor();await page.screenshot({path:screenshots+'/09-docs.png',fullPage:true});
 await page.goto(config.baseUrl+'/help/kaspi-cashier');await page.getByRole('heading',{name:'Добавьте сотрудника с ролью «Кассир»'}).waitFor();assert.ok(await page.locator('a[href="https://guide.kaspi.kz/partner/ru/profile/user/cashier/q1402"]').count());await page.screenshot({path:screenshots+'/11-cashier-guide.png',fullPage:true});
 const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,deviceScaleFactor:1});const mp=await mobile.newPage();await mp.goto(config.baseUrl);await mp.locator('#auth-form [name=login]').fill('owner.example');await mp.locator('#auth-form [name=password]').fill(password);await mp.locator('#auth-submit').click();await mp.locator('#app').waitFor({state:'visible'});await mp.frameLocator('#accounting-frame').locator('flutter-view').waitFor();await mp.screenshot({path:screenshots+'/10-mobile.png',fullPage:true});assert.ok(await mp.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'mobile horizontal overflow');
 for(const viewport of [{width:390,height:667},{width:360,height:640},{width:844,height:390}]){
  await mp.setViewportSize(viewport);
  const bounds=await mp.locator('#accounting-frame').boundingBox();assert.ok(bounds.y+bounds.height<=viewport.height,'accounting bottom menu is below the viewport at '+viewport.width+'x'+viewport.height);
 }
 await mp.setViewportSize({width:390,height:667});await mp.locator('#menu').click();
 const footer=await mp.locator('.side-bottom').boundingBox();assert.ok(footer.y+footer.height<=667,'mobile sidebar bottom actions are clipped');
 await mp.locator('#integrations-toggle').click();const integration=await mp.locator('[data-view=kaspi]').boundingBox();assert.ok(integration.y+integration.height<=667,'expanded integration menu is clipped');
 await mp.screenshot({path:screenshots+'/13-short-menu.png'});await mp.locator('#accounting-toggle').click();await mp.locator('.side [data-view=home]').click();await mp.frameLocator('#accounting-frame').locator('flutter-view').waitFor();await mp.screenshot({path:screenshots+'/14-short-workspace.png'});
 await mp.setViewportSize({width:390,height:844});
 await mp.locator('#menu').click();await mp.locator('.side [data-view=setup]').click();await mp.locator('#setup-form').waitFor();assert.ok(await mp.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'setup wizard mobile horizontal overflow');await mp.screenshot({path:screenshots+'/16-setup-mobile.png',fullPage:true});await mp.locator('#setup-pause').click();await mp.locator('#accounting-frame').waitFor();
 await mp.locator('#menu').click();await mp.locator('#logout').click();await mp.locator('#auth').waitFor({state:'visible'});
 await mp.goto(config.baseUrl+'/help/kaspi-cashier');assert.ok(await mp.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'cashier guide mobile horizontal overflow');await mp.screenshot({path:screenshots+'/12-guide-mobile.png'});
 assert.deepEqual(errors,[]);console.log('PASS browser: registration → shared accounting session → direct confirmed tariff payment → invoice → QR checkout → simulated payment → dashboard, settings, API docs, mobile login/logout. Screenshots saved.');
}finally{await browser?.close();await app.close();await accounting.db.exec(`DROP SCHEMA "${accountingSchema}" CASCADE`);await accounting.close();rmSync(config.dataDir,{recursive:true,force:true});}
