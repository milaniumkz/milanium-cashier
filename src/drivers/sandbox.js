import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { DriverError } from './errors.js';

// This is an explicit simulator. It never contacts Kaspi or moves money.
export class SandboxDriver {
  constructor(config, store) { this.config = config; this.store = store; }
  capabilities() { return { configured: true, phone: true, qr: true, sandbox: true }; }
  async create(merchant, invoice, beforeSubmit) {
    beforeSubmit();
    const id = 'test_' + randomUUID(), expires = Date.now() + 15 * 60_000;
    this.store.db.prepare('INSERT INTO sandbox_payments(id,merchant_id,reference,amount,currency,state,expires_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, merchant.id, invoice.id, invoice.amount, invoice.currency, 'pending', expires);
    const payment_url = `${this.config.baseUrl}/sandbox/pay/${invoice.public_token}`;
    const qr_data = (await QRCode.toDataURL(payment_url, { width: 300, margin: 2 })).split(',')[1];
    return { provider_id: id, payment_url, qr_data, expires_at: expires };
  }
  async poll(merchant, invoice) {
    const p = this.store.db.prepare('SELECT * FROM sandbox_payments WHERE id=?').get(invoice.provider_id);
    if (!p || p.merchant_id !== merchant.id || p.amount !== invoice.amount || p.reference !== invoice.id) throw new DriverError('PAYMENT_EVIDENCE_MISMATCH', true);
    if (p.state === 'pending' && p.expires_at < Date.now()) {
      this.store.db.prepare("UPDATE sandbox_payments SET state='expired' WHERE id=? AND state='pending'").run(p.id);
      return 'expired';
    }
    return p.state;
  }
  async close() {}
  async disconnect() {}
}
