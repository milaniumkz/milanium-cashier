import { clientServerIp } from './api-access.js';
import { request } from 'undici';
import QRCode from 'qrcode';
import { z } from 'zod';
import { AppError } from './db.js';

export function registerRetailDeviceGateway(app,{config,member}){
 async function rpc(path,method,body,token,key){
  if(!config.accountingUrl||!config.accountingBridgeSecret)throw new AppError('ACCOUNTING_UNAVAILABLE','Учёт временно недоступен.',503);
  const response=await request(new URL('/internal/retail/device/'+path,config.accountingUrl),{method,headers:{'content-type':'application/json','x-mbusiness-bridge-key':config.accountingBridgeSecret,...(token?{'x-retail-device-token':token}:{}),...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{}),headersTimeout:15000,bodyTimeout:15000});
  return {status:response.statusCode,data:await response.body.json()};
 }
 const cookie={httpOnly:true,secure:config.production,sameSite:'strict',path:'/retail-device',maxAge:8*3600};
 app.post('/retail-device/join',{config:{rateLimit:{max:15,timeWindow:'1 minute',keyGenerator:req=>clientServerIp(req,config)||req.ip}}},async(req,reply)=>{
  const input=z.object({code:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict().parse(req.body),r=await rpc('join','POST',input);
  if(r.status!==200)return reply.code(r.status).send(r.data);if(!/^[A-Za-z0-9_-]{43}$/.test(r.data.token||''))throw new Error('Invalid device session');reply.setCookie('mb_retail_device',r.data.token,cookie);return {ok:true,expiresAt:r.data.expiresAt};
 });
 for(const [method,url,path]of [['GET','/retail-device/session','session'],['GET','/retail-device/barcode','barcode'],['POST','/retail-device/line','line']])app.route({method,url,handler:async(req,reply)=>{
  const token=req.cookies.mb_retail_device;if(!token)throw new AppError('DEVICE_AUTH_REQUIRED','Подключите устройство по ссылке руководителя.',401);
  const target=path==='barcode'?'barcode?barcode='+encodeURIComponent(z.string().min(1).max(128).parse(req.query.barcode)):path;
  const r=await rpc(target,method,method==='POST'?req.body:undefined,token,req.headers['idempotency-key']);if(r.status===401)reply.clearCookie('mb_retail_device',{path:cookie.path});return reply.code(r.status).send(r.data);
 }});
 app.post('/retail-device/logout',async(_req,reply)=>{reply.clearCookie('mb_retail_device',{path:cookie.path});return {ok:true};});
 app.post('/account/retail-pairing-qr',{preHandler:member},async req=>{const b=z.object({code:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict().parse(req.body);return {data_url:await QRCode.toDataURL(config.baseUrl+'/store-count?code='+b.code,{width:300,margin:2})};});
}
