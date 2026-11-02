import { fetch, EnvHttpProxyAgent } from 'undici';
import QRCode from 'qrcode';
import { createProtocol, createIdentity } from '../kaspi/protocol.js';
import { seal, unseal } from '../crypto.js';
import { AppError } from '../db.js';
import { DriverError } from './errors.js';

export class KaspiDriver {
  constructor(config, store, options = {}) {
    this.config=config; this.store=store; this.authenticating=new Map();
    this.dispatcher=options.request ? null : new EnvHttpProxyAgent();
    const request=options.request || ((url, init)=>fetch(url,{...init,dispatcher:this.dispatcher}));
    this.request=async(url,init)=>{
      try {
        const response=await request(url,{...init,redirect:'error',signal:AbortSignal.timeout(15000)});
        if(!response.ok)throw new DriverError([401,403].includes(response.status)?'AUTH_REQUIRED':'KASPI_HTTP_ERROR');
        return response;
      } catch(e) { if(e instanceof DriverError)throw e; throw new DriverError('KASPI_NETWORK_ERROR'); }
    };
    store.db.exec('CREATE TABLE IF NOT EXISTS kaspi_accounts (merchant_id TEXT PRIMARY KEY REFERENCES merchants(id), encrypted TEXT NOT NULL)');
  }
  capabilities(){return {configured:!!this.config.liveEnabled,phone:!!this.config.liveEnabled,qr:!!this.config.liveEnabled,platform:'kaspi',authentication:'sms',reason:this.config.liveEnabled?undefined:'LIVE_AUTOMATION_DISABLED'};}
  account(id){const row=this.store.db.prepare('SELECT encrypted FROM kaspi_accounts WHERE merchant_id=?').get(id);return row?unseal(row.encrypted,this.config.key,`kaspi:${id}`):null;}
  save(id,value){this.store.db.prepare('INSERT INTO kaspi_accounts VALUES(?,?) ON CONFLICT(merchant_id) DO UPDATE SET encrypted=excluded.encrypted').run(id,seal(value,this.config.key,`kaspi:${id}`));}
  protocol(account){return createProtocol(account.identity,this.request,this.config.kaspiApp || {});}
  async authenticate(merchant,step,input) {
    if(step==='start'){
      for(const [id,p] of this.authenticating)if(p.expires<Date.now())this.authenticating.delete(id);
      if(this.authenticating.size>=100)throw new AppError('BUSY','Повторите подключение позже.',409);
      const account=this.account(merchant.id)||{identity:createIdentity()};
      if(this.hasOpenPayments(merchant.id)&&!account.binding&&!account.session)throw new AppError('OPEN_PAYMENTS_EXIST','Для открытых платежей нужен исходный кабинет Kaspi.',409);
      const protocol=this.protocol(account);
      const init=await protocol.auth('init');
      if(!init.success||!init.processId)throw new AppError('KASPI_AUTH_FAILED','Kaspi не начал вход.',409);
      const sent=await protocol.auth('send-phone',{processId:init.processId,phoneNumber:input.phone.replace(/^\+/, '')});
      if(!sent.success)throw new AppError('KASPI_AUTH_FAILED','Kaspi не отправил SMS. Проверьте номер и версию клиента.',409);
      this.authenticating.set(merchant.id,{account,protocol,processId:init.processId,expires:Date.now()+5*60000,attempts:0});
      return {sms_sent:true};
    }
    const pending=this.authenticating.get(merchant.id);
    if(!pending||pending.expires<Date.now()||++pending.attempts>5){this.authenticating.delete(merchant.id);throw new AppError('AUTH_EXPIRED','Начните вход заново.',409);}
    const result=await pending.protocol.auth('verify-otp',{processId:pending.processId,otp:input.otp});
    if(!result.success||!result.tokenSN||!result.vtokenSecret||!result.profileId)throw new AppError('KASPI_AUTH_FAILED','Не удалось подтвердить вход.',409);
    if(result.orgName!==merchant.account_label){this.authenticating.delete(merchant.id);throw new AppError('WRONG_MERCHANT','Название компании Kaspi не совпадает с кабинетом кассира.',409);}
    const binding=pending.account.binding||pending.account.session;
    if(this.hasOpenPayments(merchant.id)&&String(binding?.profileId)!==String(result.profileId)){this.authenticating.delete(merchant.id);throw new AppError('OPEN_PAYMENTS_EXIST','Открытые платежи требуют входа в исходный кабинет Kaspi.',409);}
    const duplicate=this.store.merchants().some(m=>m.id!==merchant.id&&String((this.account(m.id)?.binding||this.account(m.id)?.session)?.profileId)===String(result.profileId));
    if(duplicate){this.authenticating.delete(merchant.id);throw new AppError('PROFILE_ALREADY_BOUND','Кабинет Kaspi уже подключён к другой компании.',409);}
    this.save(merchant.id,{...pending.account,binding:{profileId:result.profileId},session:{tokenSN:result.tokenSN,vtokenSecret:result.vtokenSecret,profileId:result.profileId,organizationId:result.organizationId,orgName:result.orgName}});
    this.authenticating.delete(merchant.id);this.store.setMerchantState(merchant.id,'connected');this.store.audit(merchant.id,null,'kaspi.connected');
    return {connected:true};
  }
  hasOpenPayments(id){return !!this.store.db.prepare("SELECT id FROM invoices WHERE merchant_id=? AND status IN ('queued','processing','pending','unknown','requires_auth') LIMIT 1").get(id);}
  connected(merchant){const a=this.account(merchant.id);if(merchant.state!=='connected'||!a?.session)throw new DriverError('AUTH_REQUIRED');if(a.session.orgName!==merchant.account_label)throw new DriverError('WRONG_MERCHANT');return a;}
  data(result){if(result?.StatusCode===-101001)throw new DriverError('AUTH_REQUIRED');if(!result?.Data||(result.StatusCode!==undefined&&result.StatusCode!==0))throw new DriverError('KASPI_RESPONSE_REJECTED');return result.Data;}
  async create(merchant,invoice,beforeSubmit){
    if(!this.config.liveEnabled)throw new DriverError('LIVE_AUTOMATION_DISABLED');
    const a=this.connected(merchant),protocol=this.protocol(a);
    const qr=invoice.method==='qr';
    const body=qr?{PaymentAmount:invoice.amount,DeviceInterface:'Pos'}:{PhoneNumber:this.store.phone(invoice).replace(/^\+/,''),Amount:invoice.amount,Comment:invoice.id};
    // Persist before the only outbound create attempt. Every subsequent error remains uncertain.
    beforeSubmit();
    const data=this.data(await protocol.payment(a.session,qr?'/v01/qr-token/create':'/v01/remote/create',body));
    const id=String(data.QrOperationId||'');if(!/^\d{1,30}$/.test(id))throw new DriverError('INVALID_PROVIDER_ID',true);
    this.store.patch(invoice.id,{provider_id:id});
    let payment_url=null,qr_data=null;
    if(qr){
      let url;try{url=new URL(data.QrToken);}catch{throw new DriverError('INVALID_QR',true);}
      if(url.protocol!=='https:'||!['qr.kaspi.kz','pay.kaspi.kz'].includes(url.hostname)||url.username||url.password||url.port)throw new DriverError('INVALID_QR',true);
      payment_url=url.href;qr_data=(await QRCode.toDataURL(payment_url,{width:300,margin:2})).split(',')[1];
    }
    return {provider_id:id,payment_url,qr_data,expires_at:Number.isFinite(Date.parse(data.ExpireDate))?Date.parse(data.ExpireDate):null};
  }
  async poll(merchant,invoice){
    const a=this.connected(merchant);if(!/^\d{1,30}$/.test(invoice.provider_id||''))throw new DriverError('INVALID_PROVIDER_ID');
    const endpoint=invoice.method==='qr'?'/v02/kaspi-qr/status?qrOperationId=':'/v02/remote/details?operationId=';
    const d=this.data(await this.protocol(a).payment(a.session,endpoint+invoice.provider_id));
    // Missing evidence never confirms a payment. These fields must be verified against live responses before enabling use.
    if(String(d.QrOperationId)!==invoice.provider_id||Number(d.Amount)!==invoice.amount||d.Currency!==invoice.currency||String(d.ProfileId)!==String(a.session.profileId))throw new DriverError('PAYMENT_EVIDENCE_MISMATCH',true);
    if(invoice.method==='phone'&&d.Comment!==invoice.id)throw new DriverError('PAYMENT_EVIDENCE_MISMATCH',true);
    const states={Processed:'paid',RemotePaymentCanceled:'declined',RemotePaymentRejected:'declined',CancelledByUser:'declined',NotConfirmedByUser:'declined',Rejected:'declined',Expired:'expired',QrTokenDiscarded:'expired',RemotePaymentCreated:'pending',QrTokenCreated:'pending',Wait:'pending'};
    if(!states[d.Status])throw new DriverError('UNKNOWN_BANK_STATUS',true);return states[d.Status];
  }
  async disconnect(id){this.authenticating.delete(id);const a=this.account(id);if(a)this.save(id,{identity:a.identity,binding:a.binding||(a.session?{profileId:a.session.profileId}:undefined)});}
  async close(){this.authenticating.clear();await this.dispatcher?.close();}
}
