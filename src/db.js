import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { token, hash, seal, unseal } from './crypto.js';

export const now = () => Date.now();
export class AppError extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.statusCode = status; } }
const mutable = new Set(['status', 'provider_id', 'payment_url', 'qr_data', 'expires_at', 'error_code', 'next_poll', 'submitted', 'polled_at']);
const terminal = new Set(['paid', 'declined', 'expired', 'failed']);

export class Store {
  constructor(config) {
    this.config = config;
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(config.dataDir, 'cashier.sqlite'));
    chmodSync(path.join(config.dataDir, 'cashier.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS merchants (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, account_label TEXT NOT NULL,
        api_hash TEXT UNIQUE NOT NULL, webhook_url TEXT NOT NULL DEFAULT '',
        webhook_secret TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'disconnected',
        storage TEXT, device_udid TEXT UNIQUE, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id),
        order_id TEXT NOT NULL, idem TEXT NOT NULL, fingerprint TEXT NOT NULL,
        amount INTEGER NOT NULL, currency TEXT NOT NULL, method TEXT NOT NULL,
        phone TEXT, description TEXT NOT NULL, public_token TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL, provider_id TEXT, payment_url TEXT, qr_data TEXT,
        expires_at INTEGER, error_code TEXT, submitted INTEGER NOT NULL DEFAULT 0,
        next_poll INTEGER NOT NULL DEFAULT 0, polled_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(merchant_id, order_id), UNIQUE(merchant_id, idem)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS provider_unique ON invoices(merchant_id, provider_id) WHERE provider_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS invoice_queue ON invoices(status, created_at);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id),
        invoice_id TEXT NOT NULL REFERENCES invoices(id), body TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
        delivered_at INTEGER, last_error TEXT, dead INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY, merchant_id TEXT, invoice_id TEXT,
        action TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sandbox_payments (
        id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, reference TEXT NOT NULL UNIQUE,
        amount INTEGER NOT NULL, currency TEXT NOT NULL, state TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );`);
    if (!this.db.prepare('PRAGMA table_info(merchants)').all().some(c=>c.name==='device_udid')) this.db.exec('ALTER TABLE merchants ADD COLUMN device_udid TEXT; CREATE UNIQUE INDEX IF NOT EXISTS device_isolation ON merchants(device_udid) WHERE device_udid IS NOT NULL;');
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  audit(merchantId, invoiceId, action, detail = '') {
    this.db.prepare('INSERT INTO audit(merchant_id,invoice_id,action,detail,created_at) VALUES(?,?,?,?,?)').run(merchantId, invoiceId, action, detail, now());
  }
  createMerchant(v) {
    const id = randomUUID(), apiKey = token('mk_'), secret = token('whsec_');
    this.db.prepare(`INSERT INTO merchants(id,name,account_label,api_hash,webhook_url,webhook_secret,state,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(
      id, v.name, v.account_label, hash(apiKey), v.webhook_url, seal(secret, this.config.key, `webhook:${id}`), this.config.mode === 'sandbox' ? 'sandbox' : 'disconnected', now());
    this.audit(id, null, 'merchant.created');
    return { merchant: this.merchantPublic(this.merchant(id)), api_key: apiKey, webhook_secret: secret };
  }
  merchant(id) { return this.db.prepare('SELECT * FROM merchants WHERE id=?').get(id); }
  merchantByKey(key) { return this.db.prepare('SELECT * FROM merchants WHERE api_hash=?').get(hash(key)); }
  merchantPublic(m) { if (!m) return null; const { storage, api_hash, webhook_secret, ...safe } = m; return safe; }
  merchants() { return this.db.prepare('SELECT * FROM merchants ORDER BY created_at DESC').all().map(m => this.merchantPublic(m)); }
  rotateKey(id) { const key = token('mk_'); this.db.prepare('UPDATE merchants SET api_hash=? WHERE id=?').run(hash(key), id); this.audit(id, null, 'key.rotated'); return key; }
  setSession(id, state) {
    this.db.prepare('UPDATE merchants SET storage=?,state=? WHERE id=?').run(seal(state, this.config.key, `session:${id}`), 'connected', id);
    this.audit(id, null, 'session.connected');
  }
  bindDevice(id, device) {
    const current=this.merchant(id);
    if(current?.device_udid&&current.device_udid!==device.udid&&this.db.prepare("SELECT id FROM invoices WHERE merchant_id=? AND status IN ('queued','processing','pending','unknown','requires_auth') LIMIT 1").get(id))throw new AppError('OPEN_PAYMENTS_EXIST','Сначала завершите сверку открытых платежей перед заменой Android.',409);
    const other=this.db.prepare('SELECT id FROM merchants WHERE device_udid=? AND id!=?').get(device.udid,id);
    if(other)throw new AppError('DEVICE_ALREADY_BOUND','Этот Android уже принадлежит другой компании.',409);
    for(const m of this.db.prepare('SELECT * FROM merchants WHERE storage IS NOT NULL AND id!=?').all(id)){
      const d=this.session(m.id);if(d?.system_port===device.system_port)throw new AppError('SYSTEM_PORT_IN_USE','Порт UiAutomator2 уже используется другой компанией.',409);
    }
    this.db.prepare('UPDATE merchants SET storage=?,device_udid=?,state=? WHERE id=?').run(seal(device,this.config.key,`session:${id}`),device.udid,'device_ready',id);
    this.audit(id,null,'android.bound',device.udid);
  }
  session(id) { const m = this.merchant(id); return m?.storage ? unseal(m.storage, this.config.key, `session:${id}`) : null; }
  disconnect(id) {
    this.db.prepare('UPDATE merchants SET state=? WHERE id=?').run('disconnected', id);
    for(const i of this.db.prepare("SELECT id FROM invoices WHERE merchant_id=? AND method='qr' AND status IN ('pending','unknown')").all(id))this.patch(i.id,{status:'unknown',qr_data:null,payment_url:null,error_code:'AUTOMATION_PAUSED',next_poll:0});
    this.audit(id, null, 'automation.disconnected');
  }
  setMerchantState(id, state) { this.db.prepare('UPDATE merchants SET state=? WHERE id=?').run(state, id); }
  createInvoice(m, v, idem) {
    if (!/^[\w.:-]{8,120}$/.test(idem || '')) throw new AppError('INVALID_IDEMPOTENCY_KEY', 'Нужен Idempotency-Key длиной 8–120 символов.');
    const fingerprint = hash(JSON.stringify(v));
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM invoices WHERE merchant_id=? AND (idem=? OR order_id=?)').all(m.id, idem, v.order_id);
      if (existing.length) {
        if (existing.length !== 1 || existing[0].fingerprint !== fingerprint || existing[0].idem !== idem) throw new AppError('IDEMPOTENCY_CONFLICT', 'Этот заказ или ключ уже использован с другими параметрами. Повторите исходный Idempotency-Key.', 409);
        return { invoice: existing[0], replay: true };
      }
      const id = randomUUID(), at = now();
      this.db.prepare(`INSERT INTO invoices(id,merchant_id,order_id,idem,fingerprint,amount,currency,method,phone,description,public_token,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, m.id, v.order_id, idem, fingerprint, v.amount, v.currency, v.method,
        v.customer_phone ? seal(v.customer_phone, this.config.key, `phone:${id}`) : null,
        v.description, token(), 'queued', at, at);
      this.audit(m.id, id, 'invoice.queued');
      return { invoice: this.invoice(id), replay: false };
    });
  }
  invoice(id) { return this.db.prepare('SELECT * FROM invoices WHERE id=?').get(id); }
  byPublicToken(t) { return this.db.prepare('SELECT * FROM invoices WHERE public_token=?').get(t); }
  phone(i) { return i.phone ? unseal(i.phone, this.config.key, `phone:${i.id}`) : null; }
  listInvoices(merchantId, limit = 100) {
    return merchantId ? this.db.prepare('SELECT * FROM invoices WHERE merchant_id=? ORDER BY created_at DESC LIMIT ?').all(merchantId, limit)
      : this.db.prepare('SELECT * FROM invoices ORDER BY created_at DESC LIMIT ?').all(limit);
  }
  invoicePublic(i) {
    const payable=i.status==='pending'&&(!i.expires_at||i.expires_at>now());
    return { id: i.id, order_id: i.order_id, merchant_id: i.merchant_id, amount: i.amount, currency: i.currency,
      method: i.method, status: i.status, error_code: i.error_code, provider_id: i.provider_id,
      checkout_url: `${this.config.baseUrl}/p/${i.public_token}`, payment_url: payable?i.payment_url:null,
      qr_available: payable&&!!i.qr_data, expires_at: i.expires_at, created_at: i.created_at, updated_at: i.updated_at };
  }
  patch(id, changes) {
    const entries = Object.entries(changes);
    if (!entries.length || entries.some(([k]) => !mutable.has(k))) throw new Error('Invalid patch');
    return this.transaction(() => {
      const old = this.invoice(id);
      if (!old) throw new AppError('NOT_FOUND', 'Платёж не найден.', 404);
      if (terminal.has(old.status) && changes.status && changes.status !== old.status) throw new AppError('TERMINAL_STATE', 'Конечный статус нельзя перезаписать.', 409);
      this.db.prepare(`UPDATE invoices SET ${entries.map(([k]) => `${k}=?`).join(',')},updated_at=? WHERE id=?`).run(...entries.map(([,v]) => v), now(), id);
      const current = this.invoice(id);
      if (changes.status && changes.status !== old.status) {
        this.audit(old.merchant_id, id, 'invoice.status', `${old.status} → ${changes.status}`);
        const eventId = randomUUID();
        const body = JSON.stringify({ event_id: eventId, type: `invoice.${current.status}`, created_at: new Date().toISOString(), invoice: this.invoicePublic(current) });
        this.db.prepare('INSERT INTO events(id,merchant_id,invoice_id,body,next_at) VALUES(?,?,?,?,?)').run(eventId, old.merchant_id, id, body, now());
      }
      return current;
    });
  }
  recover() {
    for (const i of this.db.prepare("SELECT * FROM invoices WHERE status='processing'").all()) {
      this.patch(i.id, { status: i.submitted?'unknown':'failed', error_code: i.submitted?'PROCESS_INTERRUPTED':'PROCESS_INTERRUPTED_BEFORE_SUBMIT' });
    }
    for(const i of this.db.prepare("SELECT * FROM invoices WHERE method='qr' AND submitted=1 AND status IN ('pending','unknown')").all()){
      this.patch(i.id,{status:'unknown',error_code:'QR_RECONCILIATION_AFTER_RESTART',qr_data:null,payment_url:null,next_poll:0});
    }
  }
  nextJob(busy) {
    for(const i of this.db.prepare("SELECT * FROM invoices WHERE status='queued' ORDER BY created_at").iterate())if(!busy.has(i.merchant_id))return i;
  }
  nextPoll(busy, allowed=()=>true) {
    for(const i of this.db.prepare("SELECT * FROM invoices WHERE status IN ('pending','unknown') AND provider_id IS NOT NULL AND next_poll<=? ORDER BY next_poll").iterate(now()))if(!busy.has(i.merchant_id)&&allowed(i))return i;
  }
  blockedMerchants() {
    return this.db.prepare("SELECT DISTINCT merchant_id FROM invoices WHERE submitted=1 AND ((status='unknown' AND provider_id IS NULL) OR (method='qr' AND status IN ('processing','pending','unknown')))").all().map(i=>i.merchant_id);
  }
  retry(id) {
    const i = this.invoice(id);
    if (!i || !['requires_auth', 'failed'].includes(i.status) || i.submitted || i.provider_id) throw new AppError('RETRY_NOT_SAFE', 'Повтор запрещён: сначала требуется сверка операции.', 409);
    // A failure conclusively before submit is the only terminal state that can be requeued.
    this.db.prepare("UPDATE invoices SET status='queued',error_code=NULL,updated_at=? WHERE id=?").run(now(), id);
    this.audit(i.merchant_id, id, 'invoice.safe_retry');
  }
  outbox() { return this.db.prepare('SELECT e.*,m.webhook_url,m.webhook_secret FROM events e JOIN merchants m ON m.id=e.merchant_id WHERE e.delivered_at IS NULL AND e.dead=0 AND e.next_at<=? AND m.webhook_url!=? ORDER BY e.next_at LIMIT 10').all(now(), ''); }
  close() { this.db.close(); }
}
