import { randomUUID, timingSafeEqual } from 'node:crypto';
import { transaction } from './db.js';
import { fail, text, hashToken, newToken } from './security.js';
import {
  createGoodsOrder,
  getGoodsOrder,
  reserveGoodsOrder,
  shipGoodsOrder,
  receiveGoodsPayment,
} from './goods-commands.js';
const now = () => new Date().toISOString();
const active = "('QUEUED','DISPATCHED','UNKNOWN','PAID')";
export async function registerRetailTerminals(
  app,
  { db, auth, access, command, object, priced, sale, fiscal },
) {
  await db.exec(`CREATE TABLE IF NOT EXISTS retail_sale_channels(sale_id TEXT PRIMARY KEY REFERENCES retail_sales(id),channel TEXT NOT NULL,payment_kind TEXT NOT NULL DEFAULT 'card');
 CREATE TABLE IF NOT EXISTS retail_terminals(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),name TEXT NOT NULL,kind TEXT NOT NULL,model TEXT NOT NULL,connection TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,revoked BOOLEAN NOT NULL DEFAULT FALSE,driver TEXT,last_seen BIGINT,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS retail_terminal_payments(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),terminal_id TEXT NOT NULL REFERENCES retail_terminals(id),order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),actor_id TEXT NOT NULL REFERENCES users(id),wallet_id TEXT NOT NULL REFERENCES wallets(id),amount BIGINT NOT NULL,currency TEXT NOT NULL,state TEXT NOT NULL,payment_kind TEXT NOT NULL DEFAULT 'card',bank_reference TEXT,sale_id TEXT REFERENCES retail_sales(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS retail_one_terminal_payment ON retail_terminal_payments(terminal_id) WHERE state IN ${active};
 CREATE UNIQUE INDEX IF NOT EXISTS retail_bank_reference ON retail_terminal_payments(terminal_id,bank_reference) WHERE bank_reference IS NOT NULL;`);
  const base = '/v1/companies/:companyId/retail',
    route = (m, p, h) => app.route({ method: m, url: base + p, preHandler: auth, handler: h });
  const terminalView = (t) => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    model: t.model,
    connection: t.connection,
    revoked: t.revoked,
    driver: t.driver,
    lastSeen: t.last_seen,
    online: !t.revoked && !!t.driver && t.last_seen > Date.now() - 30000,
  });
  const payment = async (c, id) => {
    const p = await db
      .prepare('SELECT * FROM retail_terminal_payments WHERE company_id=? AND id=?')
      .get(c, id);
    if (!p) fail(404, 'terminal_payment_not_found');
    return { ...p, sale: p.sale_id ? await sale(c, p.sale_id) : null };
  };
  const terminal = async (c, id) => {
    const t = await db
      .prepare('SELECT * FROM retail_terminals WHERE company_id=? AND id=?')
      .get(c, id);
    if (!t) fail(404, 'terminal_not_found');
    return t;
  };
  route('GET', '/terminals', async (r) => {
    const c = await access(r, 'orders.read');
    return {
      items: (
        await db
          .prepare('SELECT * FROM retail_terminals WHERE company_id=? ORDER BY created_at')
          .all(c.id)
      ).map(terminalView),
    };
  });
  route('POST', '/terminals', async (r) => {
    let secret;
    const result = await command(r, '__owner_only__', 'retail.terminal.create', async (c) => {
      const b = object(r.body);
      if (
        !['kaspi', 'bank'].includes(b.kind) ||
        !['usb', 'bluetooth', 'network'].includes(b.connection)
      )
        fail(400, 'invalid_terminal');
      const id = randomUUID(),
        token = newToken();
      secret = token;
      await db
        .prepare(
          'INSERT INTO retail_terminals(id,company_id,name,kind,model,connection,token_hash,created_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          c.id,
          text(b.name, 'name', 100),
          b.kind,
          text(b.model, 'model', 100),
          b.connection,
          hashToken(token),
          now(),
        );
      // Credentials are returned once; ordinary list/read endpoints never expose them.
      return { id, terminal: terminalView(await terminal(c.id, id)) };
    });
    return { ...result, ...(secret ? { token: secret } : {}) };
  });
  route('POST', '/terminals/:id/key', async (r) => {
    let secret;
    const result = await command(r, '__owner_only__', 'retail.terminal.key', async (c) => {
      const t = await terminal(c.id, r.params.id);
      if (t.revoked) fail(409, 'terminal_revoked');
      if (
        await db
          .prepare(
            `SELECT 1 FROM retail_terminal_payments WHERE terminal_id=? AND state IN ${active}`,
          )
          .get(t.id)
      )
        fail(409, 'terminal_payment_active');
      secret = newToken();
      await db
        .prepare('UPDATE retail_terminals SET token_hash=?,driver=NULL,last_seen=NULL WHERE id=?')
        .run(hashToken(secret), t.id);
      return { id: t.id, terminal: terminalView(await terminal(c.id, t.id)) };
    });
    return { ...result, ...(secret ? { token: secret } : {}) };
  });
  route('POST', '/terminals/:id/revoke', (r) =>
    command(r, '__owner_only__', 'retail.terminal.revoke', async (c) => {
      const t = await terminal(c.id, r.params.id);
      if (
        await db
          .prepare(
            `SELECT 1 FROM retail_terminal_payments WHERE terminal_id=? AND state IN ${active}`,
          )
          .get(t.id)
      )
        fail(409, 'terminal_payment_active');
      await db.prepare('UPDATE retail_terminals SET revoked=TRUE WHERE id=?').run(t.id);
      return { id: t.id, revoked: true };
    }),
  );
  route('POST', '/terminal-payments', (r) =>
    command(r, 'orders.write', 'retail.terminal.payment', async (c) => {
      for (const p of [
        'orders.fulfill',
        'payments.write',
        'wallets.transact',
        'catalog.read',
        'inventory.read',
      ])
        await access(r, p);
      await fiscal.requireReady(c.id);
      const b = object(r.body),
        t = await terminal(c.id, b.terminalId);
      if (!terminalView(t).online) fail(409, 'terminal_offline');
      if (c.currency !== 'KZT') fail(400, 'terminal_currency_unsupported');
      if (
        await db
          .prepare(
            `SELECT 1 FROM retail_terminal_payments WHERE terminal_id=? AND state IN ${active}`,
          )
          .get(t.id)
      )
        fail(409, 'terminal_payment_active');
      const preview = await priced(c, b);
      if (preview.total !== b.expectedTotal || preview.total <= 0)
        fail(409, 'retail_price_changed');
      const w = await db
        .prepare('SELECT * FROM wallets WHERE company_id=? AND id=?')
        .get(c.id, text(b.walletId, 'walletId'));
      if (!w) fail(404, 'wallet_not_found');
      if (w.scope !== preview.scope) fail(400, 'incompatible_ledger_scope');
      const order = await createGoodsOrder(db, c, preview);
      await fiscal.captureOrder(c.id, order.id, preview);
      await reserveGoodsOrder(db, c, order.id);
      const id = randomUUID();
      await db
        .prepare(
          "INSERT INTO retail_terminal_payments(id,company_id,terminal_id,order_id,actor_id,wallet_id,amount,currency,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'QUEUED',?,?)",
        )
        .run(id, c.id, t.id, order.id, r.user.id, w.id, preview.total, c.currency, now(), now());
      return payment(c.id, id);
    }),
  );
  route('GET', '/terminal-payments/by-key', async (r) => {
    const c = await access(r, 'orders.read'),
      old = await db
        .prepare('SELECT response FROM idempotency WHERE company_id=? AND actor_id=? AND key=?')
        .get(c.id, r.user.id, text(r.query.key, 'key', 128));
    if (!old) fail(404, 'terminal_payment_not_found');
    return payment(c.id, JSON.parse(old.response).id);
  });
  route('GET', '/terminal-payments/:id', async (r) => {
    const c = await access(r, 'orders.read');
    return payment(c.id, r.params.id);
  });
  async function release(p) {
    for (const row of await db
      .prepare('SELECT * FROM reservations WHERE order_id=?')
      .all(p.order_id))
      await db
        .prepare('UPDATE batches SET reserved=reserved-? WHERE id=?')
        .run(row.quantity, row.batch_id);
    await db.prepare('DELETE FROM reservations WHERE order_id=?').run(p.order_id);
    await db.prepare("UPDATE orders SET status='CANCELLED' WHERE id=?").run(p.order_id);
  }
  route('POST', '/terminal-payments/:id/cancel', (r) =>
    command(r, 'orders.write', 'retail.terminal.cancel', async (c) => {
      const p = await payment(c.id, r.params.id);
      if (p.state !== 'QUEUED') fail(409, 'terminal_cancel_requires_bank');
      await release(p);
      await db
        .prepare("UPDATE retail_terminal_payments SET state='CANCELLED',updated_at=? WHERE id=?")
        .run(now(), p.id);
      return payment(c.id, p.id);
    }),
  );
  async function finalize(companyId, id) {
    return transaction(db, async () => {
      const c = await db.prepare('SELECT * FROM companies WHERE id=? FOR UPDATE').get(companyId),
        p = await payment(c.id, id);
      if (p.state === 'COMPLETED') return p;
      if (p.state !== 'PAID') fail(409, 'terminal_not_paid');
      await db.prepare("SELECT set_config('app.actor_id',?,true)").get(p.actor_id);
      await shipGoodsOrder(db, c, p.order_id);
      const order = await getGoodsOrder(db, c.id, p.order_id);
      await receiveGoodsPayment(db, c, p.order_id, {
        amount: p.amount,
        walletId: p.wallet_id,
        businessDate: order.data.businessDate,
      });
      const sid = randomUUID();
      await db
        .prepare('INSERT INTO retail_sales VALUES(?,?,?,?,?,?,?,?)')
        .run(sid, c.id, p.order_id, p.actor_id, 'terminal', p.amount, 0, now());
      const t = await terminal(c.id, p.terminal_id);
      await db
        .prepare('INSERT INTO retail_sale_channels VALUES(?,?,?)')
        .run(sid, t.kind === 'kaspi' ? 'kaspi' : 'bank', p.payment_kind);
      await db
        .prepare(
          "UPDATE retail_terminal_payments SET state='COMPLETED',sale_id=?,updated_at=? WHERE id=?",
        )
        .run(sid, now(), p.id);
      await db
        .prepare(
          'INSERT INTO audit(company_id,actor_id,action,resource_id,created_at) VALUES(?,?,?,?,?)',
        )
        .run(c.id, p.actor_id, 'retail.terminal.completed', p.id, now());
      await fiscal.enqueue(c.id, sid);
      return payment(c.id, p.id);
    });
  }
  route('POST', '/terminal-payments/:id/finalize', async (r) => {
    const c = await access(r, 'orders.fulfill');
    await access(r, 'payments.write');
    await access(r, 'wallets.transact');
    return finalize(c.id, r.params.id);
  });
  const bridge = async (r) => {
    const expected = process.env.MBUSINESS_BRIDGE_SECRET,
      actual = r.headers['x-mbusiness-bridge-key'];
    if (
      !expected ||
      typeof actual !== 'string' ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(r.ip) ||
      Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    )
      fail(401, 'terminal_auth_required');
  };
  async function agent(r) {
    const token = r.headers['x-retail-terminal-token'];
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      fail(401, 'terminal_auth_required');
    const t = await db
      .prepare('SELECT * FROM retail_terminals WHERE token_hash=? AND NOT revoked')
      .get(hashToken(token));
    if (!t) fail(401, 'terminal_auth_required');
    return t;
  }
  app.post('/internal/retail/terminal/poll', { preHandler: bridge }, async (r) => {
    const t = await agent(r),
      b = object(r.body),
      driver = text(b.driver, 'driver', 100);
    if (b.protocol !== 1 || b.ready !== true) fail(409, 'terminal_driver_not_ready');
    return transaction(db, async () => {
      await db.prepare('SELECT id FROM companies WHERE id=? FOR UPDATE').get(t.company_id);
      await agent(r);
      await db
        .prepare('UPDATE retail_terminals SET driver=?,last_seen=? WHERE id=?')
        .run(driver, Date.now(), t.id);
      const p = await db
        .prepare(
          `SELECT * FROM retail_terminal_payments WHERE terminal_id=? AND state IN ${active} ORDER BY created_at LIMIT 1`,
        )
        .get(t.id);
      if (!p || p.state === 'PAID') return { command: null };
      const operation = p.state === 'QUEUED' ? 'pay' : 'status';
      if (operation === 'pay')
        await db
          .prepare("UPDATE retail_terminal_payments SET state='DISPATCHED',updated_at=? WHERE id=?")
          .run(now(), p.id);
      return {
        command: { id: p.id, operation, amount: p.amount, currency: p.currency, terminalId: t.id },
      };
    });
  });
  app.post('/internal/retail/terminal/result', { preHandler: bridge }, async (r) => {
    const t = await agent(r),
      b = object(r.body);
    if (!['approved', 'declined', 'unknown'].includes(b.status))
      fail(400, 'invalid_terminal_result');
    const result = await transaction(db, async () => {
      await db.prepare('SELECT id FROM companies WHERE id=? FOR UPDATE').get(t.company_id);
      const p = await payment(t.company_id, text(b.id, 'id'));
      if (p.terminal_id !== t.id) fail(404, 'terminal_payment_not_found');
      if (b.paymentKind && !['card', 'mobile'].includes(b.paymentKind))
        fail(400, 'invalid_payment_kind');
      if (b.amount !== p.amount || b.currency !== p.currency) fail(409, 'terminal_result_mismatch');
      if (['COMPLETED', 'PAID', 'DECLINED', 'CANCELLED'].includes(p.state)) {
        if (
          (['COMPLETED', 'PAID'].includes(p.state) && b.status !== 'approved') ||
          (p.state === 'DECLINED' && b.status !== 'declined') ||
          p.state === 'CANCELLED' ||
          (p.bank_reference && b.bankReference !== p.bank_reference)
        )
          fail(409, 'terminal_result_conflict');
        return p;
      }
      if (!['DISPATCHED', 'UNKNOWN'].includes(p.state)) fail(409, 'terminal_not_dispatched');
      const reference = b.status === 'unknown' ? null : text(b.bankReference, 'bankReference', 150);
      if (b.status === 'declined') await release(p);
      await db
        .prepare(
          'UPDATE retail_terminal_payments SET state=?,bank_reference=?,payment_kind=?,updated_at=? WHERE id=?',
        )
        .run(
          b.status === 'approved' ? 'PAID' : b.status === 'declined' ? 'DECLINED' : 'UNKNOWN',
          reference,
          b.paymentKind || 'card',
          now(),
          p.id,
        );
      return payment(t.company_id, p.id);
    });
    if (result.state === 'PAID') {
      try {
        await finalize(t.company_id, result.id);
      } catch {
        /* Keep the confirmed bank result even if accounting is temporarily blocked. */
      }
    }
    const p = await payment(t.company_id, result.id);
    return { id: p.id, state: p.state };
  });
}
