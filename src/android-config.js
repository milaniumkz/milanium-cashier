import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { DriverError } from './drivers/errors.js';

export const selector = z.object({ using:z.enum(['id','accessibility id','xpath']), value:z.string().min(1).max(1000) }).strict();
const step = z.discriminatedUnion('action',[
  z.object({action:z.literal('click'),selector}).strict(),
  z.object({action:z.literal('back')}).strict(),
  z.object({action:z.literal('wait'),selector}).strict(),
]);
const steps = z.array(step).max(20);
const states = z.object({paid:z.string().min(1),pending:z.string().min(1),declined:z.string().min(1),expired:z.string().min(1)}).strict().refine(v=>new Set(Object.values(v)).size===4);
const evidence = z.object({provider_id:selector,amount:selector,currency:selector,reference:selector,state:selector,states}).strict();
const operation = z.object({
  navigation:steps, amount:selector, phone:selector.optional(), reference:selector,
  description:selector.optional(), submit:selector, result:selector, provider_id:selector,
  qr:selector.optional(), link:selector.optional(),
  // For QR mode: read its state on the SAME screen, without leaving an active QR.
  live_status:evidence.optional(),
}).strict();
export const appSchema = z.object({
  app_package:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/),
  app_activity:z.string().min(1),
}).strict();
export const androidSchema = z.object({
  version:z.literal(1), verified:z.literal(true),
  ...appSchema.shape,
  ready:selector, account:selector,
  home:steps,
  phone:operation.optional(), qr:operation.optional(),
  history:z.object({navigation:steps,search:selector,search_submit:selector.optional(),open_result:selector,details:evidence}).strict(),
  payment_origins:z.array(z.url()).min(1),
}).strict().refine(c=>!!c.phone||!!c.qr);
export const deviceSchema = z.object({
  udid:z.string().regex(/^[a-zA-Z0-9_.:-]{2,120}$/),
  system_port:z.number().int().min(8200).max(8999),
  avd_name:z.string().regex(/^[a-zA-Z0-9_-]{2,100}$/).optional(),
}).strict();
export function readAndroidApp(config){
  try{const raw=JSON.parse(readFileSync(config.connectorPath,'utf8'));return appSchema.parse({app_package:raw.app_package,app_activity:raw.app_activity});}
  catch{throw new DriverError('ANDROID_APP_NOT_CONFIGURED');}
}
export function readAndroidConfig(config) {
  if(!config.liveEnabled)throw new DriverError('LIVE_AUTOMATION_DISABLED');
  let c;
  try{c=androidSchema.parse(JSON.parse(readFileSync(config.connectorPath,'utf8')));}catch{throw new DriverError('ANDROID_CONNECTOR_NOT_CONFIGURED');}
  if(c.phone&&!c.phone.phone)throw new DriverError('PHONE_SELECTOR_REQUIRED');
  if(c.qr&&(!c.qr.qr||!c.qr.live_status))throw new DriverError('QR_STATUS_SELECTORS_REQUIRED');
  for(const origin of c.payment_origins){const u=new URL(origin);if(u.origin!==origin||u.protocol!=='https:'||!(u.hostname==='kaspi.kz'||u.hostname.endsWith('.kaspi.kz')))throw new DriverError('UNEXPECTED_PAYMENT_ORIGIN');}
  return c;
}
