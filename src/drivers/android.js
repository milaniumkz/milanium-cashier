import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import { AppiumClient } from './appium-client.js';
import { readAndroidConfig,readAndroidApp,deviceSchema } from '../android-config.js';
import { DriverError } from './errors.js';

export class AndroidDriver {
  constructor(config,store,clientFactory=url=>new AppiumClient(url)){this.config=config;this.store=store;this.clientFactory=clientFactory;this.clients=new Map();this.liveQR=new Map();}
  capabilities(){try{const c=readAndroidConfig(this.config);return {configured:true,phone:!!c.phone,qr:!!c.qr,platform:'android',authentication:'inside_android_app'};}catch(e){return {configured:false,phone:false,qr:false,platform:'android',reason:e.code};}}
  async client(merchant){
    const c=readAndroidConfig(this.config);let device;
    try{device=deviceSchema.parse(this.store.session(merchant.id));}catch{throw new DriverError('ANDROID_DEVICE_NOT_BOUND');}
    let item=this.clients.get(merchant.id);
    if(item&&item.udid!==device.udid){await this.disconnect(merchant.id);item=null;}
    if(!item?.client.sessionId){const client=this.clientFactory(this.config.appiumUrl);await client.start(device,c);item={client,udid:device.udid};this.clients.set(merchant.id,item);}
    return {client:item.client,c};
  }
  async account(client,c,merchant){
    try{await client.find(c.ready);}catch(e){if(e.code==='ELEMENT_NOT_FOUND')throw new DriverError('AUTH_REQUIRED');throw e;}
    if(await client.text(c.account)!==merchant.account_label)throw new DriverError('WRONG_MERCHANT');
  }
  async verify(merchant){const {client,c}=await this.client(merchant);await client.activate(c.app_package);await client.navigate(c.home);await this.account(client,c,merchant);this.store.setMerchantState(merchant.id,'connected');}
  async manualClient(merchant){
    const c=readAndroidApp(this.config),device=deviceSchema.parse(this.store.session(merchant.id));
    let item=this.clients.get(merchant.id);
    if(!item?.client.sessionId){const client=this.clientFactory(this.config.appiumUrl);await client.start(device,c);item={client,udid:device.udid};this.clients.set(merchant.id,item);}
    return item.client;
  }
  async create(merchant,invoice,beforeSubmit){
    let submitted=false;
    try{
      const {client,c}=await this.client(merchant),operation=c[invoice.method];
      if(!operation)throw new DriverError('METHOD_UNAVAILABLE');
      if(this.liveQR.has(merchant.id))throw new DriverError('ANDROID_QR_ALREADY_ACTIVE');
      await client.activate(c.app_package);await client.navigate(c.home);await this.account(client,c,merchant);
      await client.navigate(operation.navigation);
      await client.fill(operation.amount,String(invoice.amount));
      await client.fill(operation.reference,invoice.id);
      if(invoice.method==='phone')await client.fill(operation.phone,this.store.phone(invoice));
      if(operation.description)await client.fill(operation.description,invoice.description);
      const amount=(await client.text(operation.amount)).replace(/[\s\u00a0\u202f]/g,'');
      if(amount!==String(invoice.amount))throw new DriverError('AMOUNT_INPUT_MISMATCH');
      if(await client.text(operation.reference)!==invoice.id)throw new DriverError('REFERENCE_INPUT_MISMATCH');
      if(invoice.method==='phone'&&(await client.text(operation.phone)).replace(/[^\d+]/g,'')!==this.store.phone(invoice))throw new DriverError('PHONE_INPUT_MISMATCH');
      beforeSubmit();submitted=true;
      if(invoice.method==='qr')this.liveQR.set(merchant.id,invoice.id);
      await client.click(operation.submit);await client.find(operation.result);
      const id=await client.text(operation.provider_id);if(!id||id.length>200)throw new DriverError('INVALID_PROVIDER_ID',true);
      this.store.patch(invoice.id,{provider_id:id});
      let qr_data=null,payment_url=null;
      if(invoice.method==='qr'){
        this.liveQR.set(merchant.id,invoice.id);
        qr_data=await client.screenshot(operation.qr);
        if(typeof qr_data!=='string'||qr_data.length>1_000_000)throw new DriverError('QR_CAPTURE_UNAVAILABLE',true);
        let decoded;
        try{const png=PNG.sync.read(Buffer.from(qr_data,'base64'));decoded=jsQR(new Uint8ClampedArray(png.data),png.width,png.height)?.data;}catch{}
        if(!decoded)throw new DriverError('QR_CAPTURE_UNAVAILABLE',true);
        // If the QR is a genuine HTTPS payment URL, use the exact same payload as a deep link.
        try{const u=new URL(decoded);if(c.payment_origins.includes(u.origin)&&!u.username&&!u.password)payment_url=u.href;}catch{}
      }
      if(operation.link){const raw=await client.text(operation.link);let u;try{u=new URL(raw);}catch{throw new DriverError('UNEXPECTED_PAYMENT_URL',true);}if(!c.payment_origins.includes(u.origin)||u.username||u.password)throw new DriverError('UNEXPECTED_PAYMENT_URL',true);payment_url=u.href;}
      return {provider_id:id,qr_data,payment_url,expires_at:null};
    }catch(e){if(e instanceof DriverError){e.uncertain ||= submitted;throw e;}throw new DriverError('ANDROID_ACTION_FAILED',submitted);}
  }
  async evidence(client,r,invoice){
    const id=await client.text(r.provider_id),amount=(await client.text(r.amount)).replace(/[\s\u00a0\u202f]/g,''),currency=await client.text(r.currency),reference=await client.text(r.reference);
    if(id!==invoice.provider_id||amount!==String(invoice.amount)||currency!==invoice.currency||reference!==invoice.id)throw new DriverError('PAYMENT_EVIDENCE_MISMATCH',true);
    const state=await client.text(r.state),status=Object.entries(r.states).find(([,v])=>v===state)?.[0];if(!status)throw new DriverError('UNKNOWN_BANK_STATUS',true);return status;
  }
  async poll(merchant,invoice){
    const {client,c}=await this.client(merchant);let status;
    if(this.liveQR.get(merchant.id)===invoice.id){
      // Do not navigate away from a displayed QR. All identity fields are checked on the live screen.
      status=await this.evidence(client,c.qr.live_status,invoice);
    }else{
      // On restart, use history to reconcile an existing operation; never generate a replacement QR.
      await client.activate(c.app_package);await client.navigate(c.home);await this.account(client,c,merchant);
      await client.navigate(c.history.navigation);await client.fill(c.history.search,invoice.provider_id);
      if(c.history.search_submit)await client.click(c.history.search_submit);
      await client.click(c.history.open_result);status=await this.evidence(client,c.history.details,invoice);
    }
    if(['paid','declined','expired'].includes(status))this.liveQR.delete(merchant.id);
    return status;
  }
  blockedMerchants(){return new Set(this.liveQR.keys());}
  canPoll(invoice){const id=this.liveQR.get(invoice.merchant_id);return !id||id===invoice.id;}
  async disconnect(id){await this.clients.get(id)?.client.close();this.clients.delete(id);this.liveQR.delete(id);}
  async close(){await Promise.allSettled([...this.clients.keys()].map(id=>this.disconnect(id)));}
}
