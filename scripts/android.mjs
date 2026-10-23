import { existsSync,mkdirSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn,spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { deviceSchema,readAndroidApp } from '../src/android-config.js';
import { AppiumClient } from '../src/drivers/appium-client.js';
import { assertServerStopped } from './maintenance.mjs';
process.umask(0o077);
const config=loadConfig(),[command,merchantId,arg1,arg2]=process.argv.slice(2),sdk=process.env.ANDROID_HOME;
const exe=(folder,name)=>sdk?path.join(sdk,folder,process.platform==='win32'?name+'.exe':name):name;
const adb=exe('platform-tools','adb');
const run=(file,args,input)=>{const r=spawnSync(file,args,{encoding:'utf8',input,env:{...process.env,ANDROID_AVD_HOME:path.join(config.dataDir,'avd')},stdio:input===undefined?'inherit':['pipe','inherit','inherit']});if(r.error)throw r.error;if(r.status!==0)throw new Error(`${path.basename(file)} failed`);};
if(command==='devices'){run(adb,['devices','-l']);process.exit(0);}
if(!['create','start','install','bind','inspect'].includes(command)||!merchantId){console.log('Commands:\n  devices\n  create MERCHANT_ID [EMULATOR_PORT] [SYSTEM_PORT]\n  start MERCHANT_ID [--headless]\n  install MERCHANT_ID /absolute/path/app.apk\n  bind MERCHANT_ID UDID SYSTEM_PORT\n  inspect MERCHANT_ID');process.exit(1);}
const store=new Store(config),m=store.merchant(merchantId);if(!m)throw new Error('Merchant not found.');
try{
  if(command==='create'){
    assertServerStopped(config);if(!sdk)throw new Error('Set ANDROID_HOME.');
    const port=Number(arg1||5554),systemPort=Number(arg2||8200);if(port<5554||port>5682||port%2)throw new Error('Emulator port must be even: 5554..5682.');
    if(store.session(merchantId))throw new Error('A device is already bound.');
    const name='cashier_'+merchantId.replaceAll('-','');const device=deviceSchema.parse({udid:`emulator-${port}`,system_port:systemPort,avd_name:name});
    for(const other of store.merchants()){const d=store.session(other.id);if(d&&(d.udid===device.udid||d.system_port===device.system_port))throw new Error('Emulator port or UiAutomator2 port is already assigned. Choose separate ports.');}
    mkdirSync(path.join(config.dataDir,'avd'),{recursive:true,mode:0o700});
    const image=process.env.ANDROID_SYSTEM_IMAGE||'system-images;android-35;google_apis_playstore;x86_64';
    run(path.join(sdk,'cmdline-tools','latest','bin',process.platform==='win32'?'avdmanager.bat':'avdmanager'),['create','avd','--name',name,'--package',image],'no\n');
    store.bindDevice(merchantId,device);console.log('Created dedicated Android instance:',name,device.udid);
  }else if(command==='bind'){
    assertServerStopped(config);store.bindDevice(merchantId,deviceSchema.parse({udid:arg1,system_port:Number(arg2)}));console.log('Dedicated device bound.');
  }else{
    const device=deviceSchema.parse(store.session(merchantId));
    if(command==='start'){
      if(!device.avd_name||!sdk)throw new Error('An AVD name and ANDROID_HOME are required.');
      const args=['-avd',device.avd_name,'-port',device.udid.split('-')[1],'-no-snapshot','-no-audio','-memory','3072'];if(arg1==='--headless')args.push('-no-window');
      store.close();const child=spawn(exe('emulator','emulator'),args,{stdio:'inherit',env:{...process.env,ANDROID_AVD_HOME:path.join(config.dataDir,'avd')}});child.on('error',e=>{console.error(e.message);process.exit(1);});child.on('exit',code=>process.exit(code||0));await new Promise(()=>{});
    }else if(command==='install'){
      assertServerStopped(config);if(!arg1||!path.isAbsolute(arg1)||!arg1.endsWith('.apk')||!existsSync(arg1))throw new Error('Provide an absolute path to an original authorized APK. Use adb install-multiple for split APKs.');
      run(adb,['-s',device.udid,'install','-r',arg1]);console.log('APK installed unchanged. Verify its package, activity and version.');
    }else if(command==='inspect'){
      assertServerStopped(config);
      const c=readAndroidApp(config);
      const client=new AppiumClient(config.appiumUrl);
      try{await client.start(device,c);await client.activate(c.app_package);const dir=path.join(config.dataDir,'inspection');mkdirSync(dir,{recursive:true,mode:0o700});const file=path.join(dir,merchantId+'.xml');writeFileSync(file,await client.source(),{mode:0o600});console.log('UI tree saved locally:',file,'Do not commit it.');}finally{await client.close();}
    }
  }
}finally{try{store.close();}catch{}}
