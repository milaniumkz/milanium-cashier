import { registerRetailDeviceGateway } from './retail-device.js';
import { request } from 'undici';
import { readFile,stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './db.js';

export function registerAccounting(app,{config,member}){
 registerRetailDeviceGateway(app,{config,member});
 const base=config.accountingUrl;
 const sessions=new Map();
 async function identity(req){
  const id=req.member.id;let entry=sessions.get(id);
  if(entry&&entry.expiresAt>Date.now()+15000)return entry;
  const promise=entry?.promise|| (async()=>{
   const response=await request(new URL('/internal/mbusiness/session',base),{method:'POST',headers:{'content-type':'application/json','x-mbusiness-bridge-key':config.accountingBridgeSecret},body:JSON.stringify({userId:id,companyId:req.company.id,login:req.member.login,companyName:req.company.name}),headersTimeout:10000,bodyTimeout:10000});
   if(response.statusCode!==200){await response.body.dump();throw new AppError('ACCOUNTING_AUTH_FAILED','Не удалось подключить учётный модуль.',503);}
   const value=await response.body.json();if(value.companyId!==req.company.id||!/^[A-Za-z0-9_-]{43}$/.test(value.token||''))throw new Error('Invalid accounting bridge');
   if(sessions.size>=10000)for(const [key,cached] of sessions)if(!cached.promise&&cached.expiresAt<Date.now())sessions.delete(key);
   sessions.set(id,value);return value;
  })();
  sessions.set(id,{promise});try{return await promise;}catch(e){sessions.delete(id);throw e;}
 }
 app.get('/account/accounting-status',{preHandler:member},async()=>({available:!!base&&!!config.accountingBridgeSecret}));
 const proxy=async(req,reply)=>{
  if(!base||!config.accountingBridgeSecret)throw new AppError('ACCOUNTING_UNAVAILABLE','Учётный модуль ещё не запущен.',503);
  let target=req.url.slice('/accounting-api'.length);
  if(!target.startsWith('/v1/')||target.includes('..')||target.includes('\\'))throw new AppError('NOT_FOUND','Маршрут не найден.',404);
  // Embedded sessions cannot manipulate authentication or create a new tenant.
  if(target.startsWith('/v1/auth/')&&!target.startsWith('/v1/auth/me'))throw new AppError('MANAGED_ACCOUNT','Управляйте аккаунтом в настройках MBusiness.',409);
  const destination=new URL(target,base);const decoded=decodeURIComponent(destination.pathname);
  if(destination.origin!==new URL(base).origin||!decoded.startsWith('/v1/')||decoded.includes('..')||decoded.includes('\\'))throw new AppError('NOT_FOUND','Маршрут не найден.',404);
  if(decoded.startsWith('/v1/auth/')&&decoded!=='/v1/auth/me')throw new AppError('MANAGED_ACCOUNT','Управляйте аккаунтом в настройках MBusiness.',409);
  if(decoded==='/v1/companies'&&req.method!=='GET')throw new AppError('MANAGED_ACCOUNT','Компании создаются при регистрации MBusiness.',409);
  if(decoded.includes('/invitations')&&req.method==='POST')throw new AppError('MANAGED_ACCOUNT','Приглашения сотрудников появятся после подключения общего управления доступом MBusiness.',409);
  const session=await identity(req);
  const headers={authorization:'Bearer '+session.token};
  if(req.headers['idempotency-key'])headers['idempotency-key']=req.headers['idempotency-key'];
  if(req.headers['content-type'])headers['content-type']=req.headers['content-type'];
  const body=req.body==null?undefined:Buffer.isBuffer(req.body)?req.body:JSON.stringify(req.body);
  const response=await request(destination,{method:req.method,headers,body,headersTimeout:15000,bodyTimeout:30000});
  if(response.statusCode===401)sessions.delete(req.member.id);
  for(const h of ['content-type','content-disposition'])if(response.headers[h])reply.header(h,response.headers[h]);
  return reply.code(response.statusCode).send(response.body);
 };
 app.route({method:['GET','POST','PUT','PATCH','DELETE'],url:'/accounting-api/*',preHandler:member,handler:proxy,errorHandler:(error,_req,reply)=>reply.code(error.statusCode||503).send({error:error.code==='UNAUTHORIZED'?'authentication_required':String(error.code||'accounting_unavailable').toLowerCase()}),bodyLimit:11*1024*1024});
 app.addContentTypeParser(/^multipart\/form-data/, {parseAs:'buffer',bodyLimit:11*1024*1024},(_req,body,done)=>done(null,body));
 // Only the built independent workspace is served, never source or old Firebase setup.
 const root=path.resolve(config.accountingWebRoot||'modules/muchet/build/web');
 app.get('/accounting/',{preHandler:member},async(_req,reply)=>{
  reply.header('X-Frame-Options','SAMEORIGIN').header('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data: blob:; worker-src 'self' blob:; frame-ancestors 'self'");
  try{return reply.type('text/html; charset=utf-8').send(await readFile(path.join(root,'index.html')));}catch{throw new AppError('ACCOUNTING_UNAVAILABLE','Сборка учётного интерфейса ещё не установлена.',503);}
 });
 app.get('/accounting/*',{preHandler:member},async(req,reply)=>{
  const relative=req.params['*'];const resolved=path.resolve(root,relative);
  if(!resolved.startsWith(root+path.sep)||relative.includes('..')||relative.includes('\\'))throw new AppError('NOT_FOUND','Файл не найден.',404);
  const types={'.js':'text/javascript','.json':'application/json','.wasm':'application/wasm','.ttf':'font/ttf','.otf':'font/otf','.png':'image/png','.svg':'image/svg+xml','.bin':'application/octet-stream'};
  try{const size=(await stat(resolved)).size;if(size>50*1024*1024)throw new Error('size');reply.header('X-Frame-Options','SAMEORIGIN');return reply.type(types[path.extname(resolved)]||'application/octet-stream').send(await readFile(resolved));}catch{throw new AppError('NOT_FOUND','Файл не найден.',404);}
 });
}
