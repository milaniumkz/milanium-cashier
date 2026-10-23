import { setTimeout as delay } from 'node:timers/promises';
import { DriverError } from './errors.js';

const elementKey='element-6066-11e4-a52e-4f735466cecf';
export class AppiumClient {
  constructor(baseUrl, transport=fetch){this.base=baseUrl.replace(/\/$/,'');this.transport=transport;}
  async command(method,path,body,timeout=20000){
    let response,data;
    try{response=await this.transport(this.base+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(timeout),redirect:'error'});data=await response.json();}
    catch{throw new DriverError('ANDROID_CONNECTION_LOST');}
    if(!response.ok||data.value?.error){
      const code=data.value?.error;
      if(code==='invalid session id')this.sessionId=null;
      const e=new DriverError(code==='no such element'?'ELEMENT_NOT_FOUND':code==='invalid session id'?'ANDROID_SESSION_EXPIRED':'ANDROID_COMMAND_FAILED');
      throw e;
    }
    return data.value;
  }
  async start(device,c){
    const value=await this.command('POST','/session',{capabilities:{alwaysMatch:{
      platformName:'Android','appium:automationName':'UiAutomator2','appium:udid':device.udid,
      'appium:systemPort':device.system_port,'appium:appPackage':c.app_package,'appium:appActivity':c.app_activity,
      'appium:noReset':true,'appium:fullReset':false,'appium:autoGrantPermissions':false,
      'appium:shouldTerminateApp':false,'appium:forceAppLaunch':false,
      'appium:newCommandTimeout':300,'appium:printPageSourceOnFindFailure':false,
    },firstMatch:[{}]}},90000);
    if(!value?.sessionId)throw new DriverError('ANDROID_SESSION_NOT_CREATED');this.sessionId=value.sessionId;
  }
  async call(method,path,body){if(!this.sessionId)throw new DriverError('ANDROID_SESSION_EXPIRED');return this.command(method,`/session/${encodeURIComponent(this.sessionId)}${path}`,body);}
  async activate(packageName){await this.call('POST','/execute/sync',{script:'mobile: activateApp',args:[{appId:packageName}]});}
  async back(){await this.call('POST','/back',{});}
  async find(s,timeout=12000){
    const end=Date.now()+timeout;
    while(true){
      const matches=await this.call('POST','/elements',s);
      if(!Array.isArray(matches))throw new DriverError('ANDROID_INVALID_RESPONSE');
      const ids=[];
      for(const item of matches){const id=item[elementKey];if(id&&await this.call('GET',`/element/${encodeURIComponent(id)}/displayed`))ids.push(id);}
      if(ids.length>1)throw new DriverError('AMBIGUOUS_ELEMENT');
      if(ids.length===1)return ids[0];
      if(Date.now()>=end)throw new DriverError('ELEMENT_NOT_FOUND');
      await delay(250);
    }
  }
  async text(s){const id=await this.find(s);return String(await this.call('GET',`/element/${encodeURIComponent(id)}/text`)).trim();}
  async fill(s,value){const id=await this.find(s);await this.call('POST',`/element/${encodeURIComponent(id)}/clear`,{});await this.call('POST',`/element/${encodeURIComponent(id)}/value`,{text:String(value)});}
  async click(s){const id=await this.find(s);if(!await this.call('GET',`/element/${encodeURIComponent(id)}/enabled`))throw new DriverError('CONTROL_DISABLED');await this.call('POST',`/element/${encodeURIComponent(id)}/click`,{});}
  async screenshot(s){const id=await this.find(s);return this.call('GET',`/element/${encodeURIComponent(id)}/screenshot`);}
  async navigate(steps){for(const step of steps){if(step.action==='back')await this.back();else if(step.action==='wait')await this.find(step.selector);else await this.click(step.selector);}}
  async source(){return this.call('GET','/source');}
  async screen(){return this.call('GET','/screenshot');}
  async tap(x,y){await this.call('POST','/actions',{actions:[{type:'pointer',id:'finger',parameters:{pointerType:'touch'},actions:[{type:'pointerMove',duration:0,x,y,origin:'viewport'},{type:'pointerDown',button:0},{type:'pause',duration:80},{type:'pointerUp',button:0}]}]});}
  async typeActive(text){const e=await this.call('GET','/element/active');const id=e?.[elementKey];if(!id)throw new DriverError('NO_FOCUSED_INPUT');await this.call('POST',`/element/${encodeURIComponent(id)}/value`,{text});}
  async close(){if(!this.sessionId)return;const id=this.sessionId;this.sessionId=null;await this.command('DELETE',`/session/${encodeURIComponent(id)}`).catch(()=>{});}
}
