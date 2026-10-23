import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import { Store, AppError, now } from './db.js';
import { token, hash, equal } from './crypto.js';
import { invoiceSchema, merchantSchema } from './config.js';
import { AndroidDriver } from './drivers/android.js';
import { SandboxDriver } from './drivers/sandbox.js';
import { Worker } from './worker.js';
import { Outbox, validateWebhookUrl } from './webhooks.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
export async function buildApp(config, options = {}) {
  const app = Fastify({ logger: options.logger ?? { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'], serializers: { req: req => ({ method: req.method, url: req.url.replace(/(\/public\/payments\/|\/sandbox\/payments\/|\/sandbox\/pay\/|\/p\/)[^/?]+/g, '$1[redacted]') }) } }, bodyLimit: 32768, trustProxy: false });
  const store = options.store || new Store(config);
  const driver = options.driver || (config.mode === 'sandbox' ? new SandboxDriver(config, store) : new AndroidDriver(config, store));
  const worker = new Worker(store, driver, config), outbox = new Outbox(store, config);
  const adminSessions = new Map();
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    reply.header('Cache-Control', 'no-store');
    if (config.production) reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (['POST','PATCH','PUT','DELETE'].includes(req.method) && req.headers.origin && req.headers.origin !== config.baseUrl) throw new AppError('ORIGIN_REJECTED', 'Недопустимый источник запроса.', 403);
  });
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Проверьте поля запроса.', fields: err.issues.map(v => ({ path: v.path.join('.'), message: v.message })) } });
    const code = err.statusCode || 500;
    if (code >= 500) app.log.error({ code: err.code || 'INTERNAL_ERROR' }, 'request failed');
    reply.code(code).send({ error: { code: err.code || (code === 429 ? 'RATE_LIMIT' : 'INTERNAL_ERROR'), message: code >= 500 ? 'Ошибка сервера. Проверьте журнал.' : err.message } });
  });
  const admin = async req => {
    const session = adminSessions.get(hash(req.cookies.admin_session || ''));
    if (!session || session < now()) throw new AppError('UNAUTHORIZED', 'Войдите в кабинет.', 401);
  };
  const api = async req => {
    const key = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    const merchant = key && store.merchantByKey(key);
    if (!merchant) throw new AppError('UNAUTHORIZED', 'Недействительный API-ключ.', 401);
    req.merchant = merchant;
  };
  const getInvoice = (id, merchantId) => {
    const i = store.invoice(id);
    if (!i || merchantId && i.merchant_id !== merchantId) throw new AppError('NOT_FOUND', 'Платёж не найден.', 404);
    return i;
  };
  const getMerchant = id => { const m = store.merchant(id); if (!m) throw new AppError('NOT_FOUND', 'Компания не найдена.', 404); return m; };
  const create = (merchant, body, idem) => {
    const v = invoiceSchema.parse(body);
    // Replay must still succeed when connectivity has changed, without executing anything again.
    const previous = store.db.prepare('SELECT id FROM invoices WHERE merchant_id=? AND (order_id=? OR idem=?)').get(merchant.id, v.order_id, idem || '');
    if (!previous) {
      const caps = driver.capabilities();
      if (!caps.configured || !caps[v.method]) throw new AppError(caps.reason || 'METHOD_UNAVAILABLE', 'Android-коннектор не настроен для этого способа.', 409);
      if (config.mode === 'android' && merchant.state !== 'connected') throw new AppError('AUTH_REQUIRED', 'Сначала войдите в приложение кассира на выделенном Android.', 409);
    }
    return store.createInvoice(merchant, v, idem);
  };
  app.get('/healthz', async () => ({ ok: true }));
  app.post('/admin/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { password } = z.object({ password: z.string().max(300) }).strict().parse(req.body);
    if (!equal(password, config.adminPassword)) throw new AppError('INVALID_LOGIN', 'Неверный пароль.', 401);
    for (const [id, expiry] of adminSessions) if (expiry < now()) adminSessions.delete(id);
    if (adminSessions.size >= 100) adminSessions.delete(adminSessions.keys().next().value);
    const value = token(); adminSessions.set(hash(value), now() + 8 * 3600_000);
    reply.setCookie('admin_session', value, { httpOnly: true, secure: config.production, sameSite: 'strict', path: '/admin', maxAge: 8*3600 });
    return { ok: true };
  });
  app.post('/admin/logout', { preHandler: admin }, async (req, reply) => {
    adminSessions.delete(hash(req.cookies.admin_session || '')); reply.clearCookie('admin_session', { path: '/admin' }); return { ok: true };
  });
  app.get('/admin/overview', { preHandler: admin }, async () => ({
    mode: config.mode, capabilities: driver.capabilities(), merchants: store.merchants(),
    invoices: store.listInvoices(null, 200).map(i => store.invoicePublic(i)),
    stats: store.db.prepare('SELECT status,COUNT(*) count,SUM(amount) amount FROM invoices GROUP BY status').all(),
    events: store.db.prepare('SELECT id,invoice_id,merchant_id,attempts,delivered_at,last_error,dead FROM events ORDER BY next_at DESC LIMIT 30').all(),
  }));
  app.post('/admin/merchants', { preHandler: admin }, async (req, reply) => {
    const v = merchantSchema.parse(req.body); validateWebhookUrl(v.webhook_url, config);
    reply.code(201); return store.createMerchant(v);
  });
  app.post('/admin/merchants/:id/key', { preHandler: admin }, async req => { getMerchant(req.params.id); return { api_key: store.rotateKey(req.params.id) }; });
  app.patch('/admin/merchants/:id/webhook', { preHandler: admin }, async req => {
    getMerchant(req.params.id);
    const { webhook_url } = merchantSchema.pick({ webhook_url:true }).parse(req.body);
    validateWebhookUrl(webhook_url, config);
    store.db.prepare('UPDATE merchants SET webhook_url=? WHERE id=?').run(webhook_url, req.params.id);
    store.audit(req.params.id, null, 'webhook.updated'); return { ok:true };
  });
  const manualLocks=new Set();
  const manual=async(id,fn)=>{
    const m=getMerchant(id);
    if(config.mode!=='android'||m.state!=='maintenance')throw new AppError('MANUAL_MODE_REQUIRED','Сначала включите ручной режим Android.',409);
    if(manualLocks.has(id))throw new AppError('BUSY','Android выполняет предыдущее действие.',409);
    manualLocks.add(id);try{return await fn(m,await driver.manualClient(m));}finally{manualLocks.delete(id);}
  };
  app.post('/admin/android/:id/manual', {preHandler:admin}, async req=>{
    const m=getMerchant(req.params.id);
    if(config.mode!=='android'||!m.device_udid)throw new AppError('NO_ANDROID','Сначала создайте или привяжите Android.',409);
    if(worker.busy.has(m.id)||manualLocks.has(m.id))throw new AppError('BUSY','Дождитесь окончания операции робота.',409);
    manualLocks.add(m.id);
    try {
    store.setMerchantState(m.id,'maintenance');
    for(const i of store.db.prepare("SELECT id FROM invoices WHERE merchant_id=? AND method='qr' AND status IN ('pending','unknown')").all(m.id)){store.patch(i.id,{status:'unknown',qr_data:null,payment_url:null,error_code:'MANUAL_INTERVENTION',next_poll:0});}
    await driver.disconnect(m.id);store.audit(m.id,null,'android.manual_mode');return {ok:true};
    } finally { manualLocks.delete(m.id); }
  });
  app.get('/admin/android/:id/screen',{preHandler:admin},async(req,reply)=>manual(req.params.id,async(_m,client)=>{
    const screen=await client.screen();if(typeof screen!=='string'||screen.length>8_000_000)throw new AppError('SCREEN_UNAVAILABLE','Экран недоступен.',409);
    return reply.type('image/png').send(Buffer.from(screen,'base64'));
  }));
  app.post('/admin/android/:id/input',{preHandler:admin},async req=>manual(req.params.id,async(_m,client)=>{
    const v=z.discriminatedUnion('action',[
      z.object({action:z.literal('tap'),x:z.number().int().min(0).max(10000),y:z.number().int().min(0).max(10000)}).strict(),
      z.object({action:z.literal('text'),text:z.string().min(1).max(200)}).strict(),
      z.object({action:z.literal('back')}).strict(),
    ]).parse(req.body);
    if(v.action==='tap')await client.tap(v.x,v.y);else if(v.action==='back')await client.back();else await client.typeActive(v.text);
    // Deliberately do not log input, screenshots, OTP or login data.
    return {ok:true};
  }));
  app.post('/admin/android/:id/resume',{preHandler:admin},async req=>manual(req.params.id,async(m)=>{
    await driver.verify(m);store.audit(m.id,null,'android.automation_resumed');return {ok:true};
  }));
  app.post('/admin/merchants/:id/disconnect', { preHandler: admin }, async req => {
    getMerchant(req.params.id);
    if (worker.busy.has(req.params.id)||manualLocks.has(req.params.id)) throw new AppError('BUSY', 'Дождитесь окончания текущего действия кассира.', 409);
    // Block new jobs synchronously before closing the Android automation session.
    worker.busy.add(req.params.id);
    try { store.disconnect(req.params.id); await driver.disconnect(req.params.id); }
    finally { worker.busy.delete(req.params.id); }
    return { ok: true };
  });
  app.post('/admin/invoices', { preHandler: admin }, async (req, reply) => {
    const { merchant_id, ...body } = req.body || {};
    const result = create(getMerchant(z.string().uuid().parse(merchant_id)), body, req.headers['idempotency-key']);
    reply.code(result.replay ? 200 : 201); return { ...store.invoicePublic(result.invoice), replay: result.replay };
  });
  app.post('/admin/invoices/:id/retry', { preHandler: admin }, async req => { getInvoice(req.params.id); store.retry(req.params.id); return { ok: true }; });
  app.post('/admin/invoices/:id/reconcile', { preHandler: admin }, async req => {
    const i = getInvoice(req.params.id);
    if (!['unknown', 'pending'].includes(i.status) || worker.busy.has(i.merchant_id)) throw new AppError('NOT_RECONCILABLE', 'Сверка сейчас недоступна.', 409);
    const { provider_id } = z.object({ provider_id: z.string().trim().min(1).max(200) }).strict().parse(req.body);
    if (i.provider_id && i.provider_id !== provider_id) throw new AppError('PROVIDER_ID_CONFLICT', 'У платежа уже есть другой идентификатор.', 409);
    store.patch(i.id, { provider_id, next_poll: 0 }); store.audit(i.merchant_id, i.id, 'invoice.reconcile_requested');
    return { ok: true };
  });
  app.get('/admin/invoices/:id/audit', { preHandler: admin }, async req => {
    getInvoice(req.params.id); return store.db.prepare('SELECT action,detail,created_at FROM audit WHERE invoice_id=? ORDER BY id').all(req.params.id);
  });
  app.post('/admin/events/:id/retry', { preHandler: admin }, async req => {
    const result = store.db.prepare('UPDATE events SET dead=0,attempts=0,next_at=? WHERE id=? AND delivered_at IS NULL').run(now(), req.params.id);
    if (!result.changes) throw new AppError('NOT_FOUND', 'Нет недоставленного события.', 404);
    return { ok: true };
  });
  app.post('/v1/invoices', { preHandler: api, config: { rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: req => hash(req.headers.authorization || req.ip) } } }, async (req, reply) => {
    const result = create(req.merchant, req.body, req.headers['idempotency-key']);
    reply.code(result.replay ? 200 : 201); return { ...store.invoicePublic(result.invoice), replay: result.replay };
  });
  app.get('/v1/invoices', { preHandler: api }, async req => ({ data: store.listInvoices(req.merchant.id).map(i => store.invoicePublic(i)) }));
  app.get('/v1/invoices/:id', { preHandler: api }, async req => store.invoicePublic(getInvoice(req.params.id, req.merchant.id)));
  app.get('/v1/capabilities', { preHandler: api }, async req => ({ ...driver.capabilities(), connection: req.merchant.state, mode: config.mode }));
  app.get('/public/payments/:token', async req => {
    const i = store.byPublicToken(req.params.token);
    if (!i) throw new AppError('NOT_FOUND', 'Ссылка не найдена.', 404);
    const expiredQR = i.expires_at && i.expires_at <= now();
    return { order_id: i.order_id, amount: i.amount, currency: i.currency, method: i.method, status: i.status,
      merchant_name: store.merchant(i.merchant_id).name, mode: config.mode,
      qr_url: i.qr_data && !expiredQR && i.status === 'pending' ? `/public/payments/${i.public_token}/qr` : null,
      payment_url: !expiredQR && i.status === 'pending' ? i.payment_url : null, expires_at: i.expires_at,
      qr_expired: !!expiredQR, error_code: i.error_code ? 'PAYMENT_UNAVAILABLE' : null };
  });
  app.get('/public/payments/:token/qr', async (req, reply) => {
    const i = store.byPublicToken(req.params.token);
    if (!i?.qr_data || i.status !== 'pending' || i.expires_at && i.expires_at <= now()) throw new AppError('QR_UNAVAILABLE', 'QR недоступен.', 404);
    return reply.type('image/png').send(Buffer.from(i.qr_data, 'base64'));
  });
  if (config.mode === 'sandbox') {
    app.post('/sandbox/payments/:token', async req => {
      const { state } = z.object({ state: z.enum(['paid', 'declined']) }).strict().parse(req.body);
      const i = store.byPublicToken(req.params.token);
      if (!i?.provider_id) throw new AppError('NOT_FOUND', 'Тестовый платёж не найден.', 404);
      const p = store.db.prepare('SELECT * FROM sandbox_payments WHERE id=?').get(i.provider_id);
      if (!p || p.state !== 'pending' || p.expires_at <= now()) throw new AppError('ALREADY_FINISHED', 'Тестовая операция завершена.', 409);
      store.db.prepare("UPDATE sandbox_payments SET state=? WHERE id=? AND state='pending'").run(state, p.id);
      store.patch(i.id, { next_poll: 0 }); return { ok: true };
    });
  }
  const serve = async (file, reply) => reply.type(file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8').send(await readFile(path.join(directory, '../public', file)));
  const assets = new Set(['app.js', 'checkout.js', 'style.css']);
  app.get('/assets/:file', async (req, reply) => {
    if (!assets.has(req.params.file)) throw new AppError('NOT_FOUND', 'Файл не найден.', 404);
    return serve(req.params.file, reply);
  });
  app.get('/', (_, reply) => serve('index.html', reply));
  app.get('/p/:token', (_, reply) => serve('checkout.html', reply));
  if (config.mode === 'sandbox') app.get('/sandbox/pay/:token', (_, reply) => serve('sandbox.html', reply));
  app.decorate('services', { store, driver, worker, outbox });
  app.addHook('onClose', async () => { await worker.stop(); await outbox.stop(); if (!options.store) store.close(); });
  if (options.background !== false) { store.recover(); worker.start(); outbox.start(); }
  return app;
}
