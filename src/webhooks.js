import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import { AppError, now } from './db.js';
import { unseal, signWebhook } from './crypto.js';

export function isPublicIPv4(ip) {
  if (net.isIP(ip) !== 4) return false; // deliberately reject IPv6 until a complete policy is supplied
  const [a,b,c] = ip.split('.').map(Number);
  if ([0,10,127].includes(a) || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) return false;
  if (a === 192 && (b === 0 || b === 2) || a === 198 && [18,19,51].includes(b) || a === 203 && b === 0 && c === 113) return false;
  return true;
}
export function validateWebhookUrl(value, config) {
  if (!value) return;
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || !config.webhookOrigins.includes(u.origin) || net.isIP(u.hostname)) {
    throw new AppError('WEBHOOK_NOT_ALLOWED', 'Укажите HTTPS-адрес из WEBHOOK_ALLOWED_ORIGINS без пароля, IP-адреса и фрагмента.');
  }
}
export async function sendWebhook(url, body, headers, config) {
  validateWebhookUrl(url, config);
  const u = new URL(url);
  const addresses = await dns.lookup(u.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some(a => !isPublicIPv4(a.address))) throw new Error('DESTINATION_NOT_PUBLIC');
  const pinned = addresses[0];
  // Resolve once and pin the validated IP while retaining hostname and TLS verification.
  return new Promise((resolve, reject) => {
    const req = https.request(u, { method: 'POST', timeout: 8000, headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      lookup: (_hostname, options, cb) => options?.all ? cb(null, [pinned]) : cb(null, pinned.address, 4),
    }, res => {
      res.resume();
      res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`HTTP_${res.statusCode}`)));
    });
    req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    req.on('error', reject); req.end(body);
  });
}
export class Outbox {
  constructor(store, config, send = sendWebhook) { this.store = store; this.config = config; this.send = send; this.running = false; }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const e of this.store.outbox()) {
        const t = Math.floor(now()/1000).toString();
        try {
          const secret = unseal(e.webhook_secret, this.config.key, `webhook:${e.merchant_id}`);
          await this.send(e.webhook_url, e.body, { 'Content-Type': 'application/json', 'X-Cashier-Event': e.id, 'X-Cashier-Timestamp': t, 'X-Cashier-Signature': `v1=${signWebhook(secret, t, e.body)}` }, this.config);
          this.store.db.prepare('UPDATE events SET delivered_at=?,attempts=attempts+1,last_error=NULL WHERE id=?').run(now(), e.id);
        } catch (err) {
          const attempts = e.attempts + 1;
          this.store.db.prepare('UPDATE events SET attempts=?,next_at=?,last_error=?,dead=? WHERE id=?').run(attempts, now() + Math.min(3600_000, 1000 * 2 ** attempts), /^HTTP_\d+$/.test(err.message) ? err.message : 'DELIVERY_FAILED', attempts >= 12 ? 1 : 0, e.id);
        }
      }
    } finally { this.running = false; }
  }
  start() { this.timer = setInterval(() => { if(!this.running)this.pending = this.tick().catch(() => {}); }, 1000); }
  async stop() { clearInterval(this.timer); await this.pending; }
}
