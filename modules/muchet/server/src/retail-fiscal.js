import { randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { transaction } from './db.js';
import { fail, text } from './security.js';
import { createFiscalDriver, FiscalError, endpoints } from './fiscal-drivers.js';
const now = () => new Date().toISOString();
export async function registerRetailFiscal(app, { db, auth, access, command, transport, worker }) {
  await db.exec(`CREATE TABLE IF NOT EXISTS retail_fiscal_config(company_id TEXT PRIMARY KEY REFERENCES companies(id),provider TEXT NOT NULL,mode TEXT NOT NULL,cashbox_id TEXT NOT NULL,credentials TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,verified BOOLEAN NOT NULL DEFAULT FALSE,enabled BOOLEAN NOT NULL DEFAULT FALSE,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS retail_fiscal_jobs(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),sale_id TEXT NOT NULL REFERENCES retail_sales(id),source_id TEXT NOT NULL UNIQUE,source_kind TEXT NOT NULL DEFAULT 'sale',provider TEXT NOT NULL,mode TEXT NOT NULL,cashbox_id TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,error_code TEXT,provider_code TEXT,attempts INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE UNIQUE INDEX IF NOT EXISTS retail_fiscal_one_sending ON retail_fiscal_jobs(company_id) WHERE state='SENDING';CREATE INDEX IF NOT EXISTS retail_fiscal_jobs_company_state ON retail_fiscal_jobs(company_id,state,created_at);CREATE INDEX IF NOT EXISTS retail_fiscal_jobs_queue ON retail_fiscal_jobs(state,created_at);`);
  const key = () => {
    if (!process.env.MBUSINESS_BRIDGE_SECRET) fail(503, 'fiscal_key_not_configured');
    return createHash('sha256')
      .update('mbusiness-fiscal-v1:' + process.env.MBUSINESS_BRIDGE_SECRET)
      .digest();
  };
  function encrypt(id, provider, value) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key(), iv);
    cipher.setAAD(Buffer.from(id + ':' + provider));
    return Buffer.concat([
      iv,
      cipher.update(JSON.stringify(value)),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64');
  }
  function decrypt(c) {
    try {
      const raw = Buffer.from(c.credentials, 'base64'),
        decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(c.company_id + ':' + c.provider));
      decipher.setAuthTag(raw.subarray(-16));
      return JSON.parse(
        Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()]).toString(),
      );
    } catch {
      fail(503, 'fiscal_credentials_unavailable');
    }
  }
  const config = (id) =>
    db.prepare('SELECT * FROM retail_fiscal_config WHERE company_id=?').get(id);
  const driver = (c) =>
    createFiscalDriver(
      { provider: c.provider, mode: c.mode, cashboxId: c.cashbox_id, ...decrypt(c) },
      { transport },
    );
  const publicConfig = (c) =>
    c
      ? {
          provider: c.provider,
          mode: c.mode,
          cashboxId: c.cashbox_id,
          version: c.version,
          verified: c.verified,
          enabled: c.enabled,
          credentialsSaved: true,
        }
      : { provider: null, enabled: false, verified: false, version: 0 };
  const view = (j) =>
    j
      ? {
          id: j.id,
          saleId: j.sale_id,
          sourceId: j.source_id,
          sourceKind: j.source_kind,
          provider: j.provider,
          mode: j.mode,
          state: j.state,
          receipt: j.receipt ? JSON.parse(j.receipt) : null,
          errorCode: j.error_code,
          providerCode: j.provider_code,
        }
      : null;
  const base = '/v1/companies/:companyId/retail/fiscal',
    route = (method, path, handler) =>
      app.route({ method, url: base + path, preHandler: auth, handler });
  async function status(id) {
    const c = await config(id),
      blocked = await db
        .prepare(
          "SELECT count(*) FILTER(WHERE state IN ('FAILED','UNKNOWN')) n,count(*) FILTER(WHERE state<>'ISSUED') pending FROM retail_fiscal_jobs WHERE company_id=?",
        )
        .get(id);
    return { ...publicConfig(c), blocked: c?.enabled && c?.verified ? blocked.n : blocked.pending };
  }
  async function requireReady(id) {
    const c = await config(id);
    const s = await status(id);
    if (s.blocked) fail(409, 'fiscal_unresolved_receipts');
    if (!c?.enabled) return;
    decrypt(c);
    const company = await db.prepare('SELECT currency FROM companies WHERE id=?').get(id);
    if (company.currency !== 'KZT') fail(409, 'fiscal_currency_unsupported');
    if (!c.verified) fail(409, 'fiscal_not_verified');
    const settings = await db
      .prepare('SELECT vat_registered FROM company_settings WHERE company_id=?')
      .get(id);
    if (c.provider === 'rekassa' && settings?.vat_registered)
      fail(409, 'rekassa_vat_contract_required');
  }
  route('GET', '/status', async (r) => {
    const c = await access(r, 'orders.read');
    return status(c.id);
  });
  route('GET', '/config', async (r) => {
    const c = await access(r, '__owner_only__');
    return status(c.id);
  });
  route('PUT', '/config', (r) =>
    command(r, '__owner_only__', 'retail.fiscal.configure', async (c) => {
      const b = r.body;
      if (!b || !endpoints[b.provider]?.[b.mode]) fail(400, 'fiscal_invalid_provider');
      const old = await config(c.id);
      if ((old?.version || 0) !== b.version) fail(409, 'version_conflict');
      const terminalBusy = await db
        .prepare(
          "SELECT 1 FROM retail_terminal_payments WHERE company_id=? AND state IN ('QUEUED','DISPATCHED','UNKNOWN','PAID') LIMIT 1",
        )
        .get(c.id);
      if (
        terminalBusy &&
        (!old ||
          old.provider !== b.provider ||
          old.mode !== b.mode ||
          old.cashbox_id !== b.cashboxId)
      )
        fail(409, 'terminal_payment_active');
      const cashboxId = text(b.cashboxId, 'cashboxId', 100);
      if (!/^[A-Za-z0-9_-]+$/.test(cashboxId)) fail(400, 'fiscal_invalid_cashbox');
      if (
        await db
          .prepare(
            "SELECT 1 FROM retail_fiscal_jobs WHERE company_id=? AND state IN ('QUEUED','SENDING','UNKNOWN','FAILED') LIMIT 1",
          )
          .get(c.id)
      ) {
        if (
          !old ||
          old.provider !== b.provider ||
          old.mode !== b.mode ||
          old.cashbox_id !== cashboxId
        )
          fail(409, 'fiscal_unresolved_receipts');
      }
      const credentials = encrypt(c.id, b.provider, {
        login: text(b.login, 'login', 150),
        password:
          typeof b.password === 'string' && b.password.length > 0 && b.password.length <= 300
            ? b.password
            : fail(400, 'invalid_password'),
        apiKey: text(b.apiKey, 'apiKey', 300),
      });
      await db
        .prepare(
          'INSERT INTO retail_fiscal_config(company_id,provider,mode,cashbox_id,credentials,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(company_id) DO UPDATE SET provider=EXCLUDED.provider,mode=EXCLUDED.mode,cashbox_id=EXCLUDED.cashbox_id,credentials=EXCLUDED.credentials,verified=FALSE,enabled=FALSE,version=retail_fiscal_config.version+1,updated_at=EXCLUDED.updated_at',
        )
        .run(c.id, b.provider, b.mode, cashboxId, credentials, now());
      return publicConfig(await config(c.id));
    }),
  );
  route('POST', '/verify', async (r) => {
    const company = await access(r, '__owner_only__'),
      c = await config(company.id);
    if (!c) fail(409, 'fiscal_not_configured');
    try {
      const verified = await driver(c).verify();
      const row = await db
        .prepare(
          'UPDATE retail_fiscal_config SET verified=TRUE,updated_at=? WHERE company_id=? AND version=? RETURNING *',
        )
        .get(now(), company.id, c.version);
      if (!row) fail(409, 'version_conflict');
      return { ...publicConfig(row), cashboxName: verified.name };
    } catch (e) {
      if (e instanceof FiscalError) fail(502, e.code);
      throw e;
    }
  });
  route('POST', '/enable', (r) =>
    command(r, '__owner_only__', 'retail.fiscal.enable', async (c) => {
      const current = await config(c.id);
      if (!current?.verified) fail(409, 'fiscal_not_verified');
      if (r.body?.enabled !== true && r.body?.enabled !== false)
        fail(400, 'fiscal_confirmation_required');
      if (
        r.body.enabled === false &&
        (await db
          .prepare(
            "SELECT 1 FROM retail_terminal_payments WHERE company_id=? AND state IN ('QUEUED','DISPATCHED','UNKNOWN','PAID') LIMIT 1",
          )
          .get(c.id))
      )
        fail(409, 'terminal_payment_active');
      if (
        r.body.enabled === false &&
        (await db
          .prepare(
            "SELECT 1 FROM retail_fiscal_jobs WHERE company_id=? AND state<>'ISSUED' LIMIT 1",
          )
          .get(c.id))
      )
        fail(409, 'fiscal_unresolved_receipts');
      await db
        .prepare('UPDATE retail_fiscal_config SET enabled=?,updated_at=? WHERE company_id=?')
        .run(r.body.enabled, now(), c.id);
      if (r.body.enabled) {
        const settings = await db
          .prepare('SELECT vat_registered FROM company_settings WHERE company_id=?')
          .get(c.id);
        if (current.provider === 'rekassa' && settings?.vat_registered)
          fail(409, 'rekassa_vat_contract_required');
      }
      return publicConfig(await config(c.id));
    }),
  );
  async function snapshot(companyId, d) {
    const c = await config(companyId);
    if (!c?.enabled) return null;
    await requireReady(companyId);
    const items = [];
    const codes = { шт: 796, штука: 796, pcs: 796, кг: 166, kg: 166, л: 112, l: 112, м: 6, m: 6 };
    for (const line of d.items) {
      const row = await db
        .prepare("SELECT data FROM documents WHERE company_id=? AND kind='nomenklatura' AND id=?")
        .get(companyId, line.productId);
      if (!row) fail(404, 'product_not_found');
      const p = JSON.parse(row.data),
        unitCode =
          codes[
            String(p.unit || 'шт')
              .toLowerCase()
              .trim()
              .replace(/\.$/, '')
          ];
      if (!unitCode || (c.provider === 'rekassa' && unitCode !== 796))
        fail(409, 'fiscal_unit_contract_required');
      items.push({
        productId: line.productId,
        name: line.productName,
        quantity: line.quantity,
        total: line.total,
        vat: line.vat || 0,
        unitCode,
        gtin: p.gtin || (/^(\d{8}|\d{12,14})$/.test(p.barcode || '') ? p.barcode : ''),
        ntin: p.ntin || '',
      });
    }
    return { provider: c.provider, mode: c.mode, cashboxId: c.cashbox_id, items };
  }
  async function captureOrder(companyId, orderId, d) {
    const snap = await snapshot(companyId, d);
    if (snap)
      await db
        .prepare(
          "UPDATE orders SET data=(data::jsonb || jsonb_build_object('retailFiscalSnapshot',?::jsonb))::text WHERE company_id=? AND id=?",
        )
        .run(JSON.stringify(snap), companyId, orderId);
  }
  async function enqueue(companyId, saleId) {
    const c = await config(companyId);
    if (!c?.enabled) return null;
    if (!c.verified) fail(409, 'fiscal_not_verified');
    const old = await db.prepare('SELECT * FROM retail_fiscal_jobs WHERE source_id=?').get(saleId);
    if (old) return view(old);
    const s = await db
      .prepare(
        'SELECT s.*,ch.payment_kind FROM retail_sales s LEFT JOIN retail_sale_channels ch ON ch.sale_id=s.id WHERE s.company_id=? AND s.id=?',
      )
      .get(companyId, saleId);
    if (!s) fail(404, 'sale_not_found');
    const order = await db
        .prepare('SELECT data FROM orders WHERE company_id=? AND id=?')
        .get(companyId, s.order_id),
      d = JSON.parse(order.data),
      id = randomUUID(),
      items = [];
    const snap = d.retailFiscalSnapshot || (await snapshot(companyId, d));
    if (
      !snap ||
      snap.provider !== c.provider ||
      snap.mode !== c.mode ||
      snap.cashboxId !== c.cashbox_id
    )
      fail(409, 'fiscal_configuration_changed');
    items.push(...snap.items);
    const payload = {
      id,
      kind: 'sale',
      number: d.number,
      total: d.total,
      vatRegistered: !!d.vatBasisPoints,
      paymentKind: s.method === 'cash' ? 'cash' : s.payment_kind || 'card',
      tendered: s.tendered,
      change: s.change_amount,
      items,
    };
    await db
      .prepare(
        "INSERT INTO retail_fiscal_jobs(id,company_id,sale_id,source_id,provider,mode,cashbox_id,payload,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'QUEUED',?,?)",
      )
      .run(
        id,
        companyId,
        saleId,
        saleId,
        c.provider,
        c.mode,
        c.cashbox_id,
        JSON.stringify(payload),
        now(),
        now(),
      );
    return { id, state: 'QUEUED', mode: c.mode, provider: c.provider };
  }
  async function requireRefundReady(companyId, saleId) {
    const parent = await db
      .prepare('SELECT * FROM retail_fiscal_jobs WHERE company_id=? AND source_id=?')
      .get(companyId, saleId);
    if (!parent) return;
    if (parent.state !== 'ISSUED') fail(409, 'fiscal_original_not_issued');
    const c = await config(companyId);
    if (
      !c?.enabled ||
      !c.verified ||
      c.provider !== parent.provider ||
      c.mode !== parent.mode ||
      c.cashbox_id !== parent.cashbox_id
    )
      fail(409, 'fiscal_original_connection_required');
    const receipt = JSON.parse(parent.receipt);
    if (!receipt.registrationNumber || !receipt.dateTime) fail(409, 'fiscal_return_basis_missing');
    await requireReady(companyId);
  }
  async function enqueueRefund(companyId, saleId, returnId, refund) {
    const parent = await db
      .prepare('SELECT * FROM retail_fiscal_jobs WHERE company_id=? AND source_id=?')
      .get(companyId, saleId);
    if (!parent) return null;
    await requireRefundReady(companyId, saleId);
    const original = JSON.parse(parent.payload),
      id = randomUUID(),
      payload = {
        id,
        kind: 'refund',
        number: refund.number,
        total: refund.total,
        vatRegistered: original.vatRegistered,
        paymentKind: refund.paymentKind,
        tendered: 0,
        change: 0,
        parent: JSON.parse(parent.receipt),
        items: refund.items.map((i) => ({
          ...original.items.find((p) => p.productId === i.productId),
          ...i,
        })),
      };
    await db
      .prepare(
        "INSERT INTO retail_fiscal_jobs(id,company_id,sale_id,source_id,source_kind,provider,mode,cashbox_id,payload,state,created_at,updated_at) VALUES(?,?,?,?,'refund',?,?,?,?,'QUEUED',?,?)",
      )
      .run(
        id,
        companyId,
        saleId,
        returnId,
        parent.provider,
        parent.mode,
        parent.cashbox_id,
        JSON.stringify(payload),
        now(),
        now(),
      );
    return { id, state: 'QUEUED', mode: parent.mode, provider: parent.provider };
  }
  const getReceipt = async (companyId, saleId) =>
    view(
      await db
        .prepare('SELECT * FROM retail_fiscal_jobs WHERE company_id=? AND source_id=?')
        .get(companyId, saleId),
    );
  async function finish(j, receipt) {
    await db
      .prepare(
        "UPDATE retail_fiscal_jobs SET state='ISSUED',receipt=?,error_code=NULL,provider_code=NULL,updated_at=? WHERE id=?",
      )
      .run(JSON.stringify(receipt), now(), j.id);
  }
  async function processOne() {
    const j = await transaction(db, async () => {
      await db
        .prepare(
          "UPDATE retail_fiscal_jobs SET state='UNKNOWN',error_code='fiscal_interrupted',updated_at=? WHERE state='SENDING' AND updated_at<?",
        )
        .run(now(), new Date(Date.now() - 120000).toISOString());
      const candidate = await db
        .prepare(
          "SELECT c.id FROM companies c JOIN retail_fiscal_config f ON f.company_id=c.id WHERE f.enabled AND f.verified AND EXISTS(SELECT 1 FROM retail_fiscal_jobs j WHERE j.company_id=c.id AND j.state='QUEUED') AND NOT EXISTS(SELECT 1 FROM retail_fiscal_jobs blocked WHERE blocked.company_id=c.id AND blocked.state IN ('SENDING','UNKNOWN','FAILED')) ORDER BY c.id LIMIT 1 FOR UPDATE OF c SKIP LOCKED",
        )
        .get();
      if (!candidate) return null;
      const row = await db
        .prepare(
          "SELECT * FROM retail_fiscal_jobs WHERE company_id=? AND state='QUEUED' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
        )
        .get(candidate.id);
      if (!row) return null;
      await db
        .prepare(
          "UPDATE retail_fiscal_jobs SET state='SENDING',attempts=attempts+1,updated_at=? WHERE id=?",
        )
        .run(now(), row.id);
      return row;
    });
    if (!j) return null;
    try {
      const c = await config(j.company_id);
      if (!c || c.provider !== j.provider || c.mode !== j.mode || c.cashbox_id !== j.cashbox_id)
        throw new FiscalError('fiscal_configuration_changed');
      await finish(j, await driver(c).issue(JSON.parse(j.payload)));
    } catch (e) {
      await db
        .prepare(
          'UPDATE retail_fiscal_jobs SET state=?,error_code=?,provider_code=?,updated_at=? WHERE id=?',
        )
        .run(
          e instanceof FiscalError && !e.unknown ? 'FAILED' : 'UNKNOWN',
          e instanceof FiscalError ? e.code : 'fiscal_unknown',
          e instanceof FiscalError ? e.providerCode : null,
          now(),
          j.id,
        );
    }
    return getReceipt(j.company_id, j.source_id);
  }
  route('GET', '/receipts', async (r) => {
    const c = await access(r, 'orders.read');
    return {
      items: (
        await db
          .prepare(
            'SELECT * FROM retail_fiscal_jobs WHERE company_id=? ORDER BY created_at DESC LIMIT 100',
          )
          .all(c.id)
      ).map(view),
    };
  });
  route('POST', '/receipts/:id/retry', async (r) => {
    const c = await access(r, 'payments.write'),
      j = await db
        .prepare('SELECT * FROM retail_fiscal_jobs WHERE company_id=? AND id=?')
        .get(c.id, r.params.id);
    if (!j) fail(404, 'fiscal_receipt_not_found');
    if (j.state === 'UNKNOWN') {
      try {
        const cfg = await config(c.id);
        if (
          !cfg ||
          cfg.provider !== j.provider ||
          cfg.mode !== j.mode ||
          cfg.cashbox_id !== j.cashbox_id
        )
          fail(409, 'fiscal_configuration_changed');
        const receipt = await driver(cfg).recover(JSON.parse(j.payload));
        if (receipt) await finish(j, receipt);
      } catch (e) {
        if (!(e instanceof FiscalError)) throw e;
      }
    } else if (j.state === 'FAILED') {
      await db
        .prepare(
          "UPDATE retail_fiscal_jobs SET state='QUEUED',error_code=NULL,updated_at=? WHERE id=? AND state='FAILED'",
        )
        .run(now(), j.id);
    }
    return getReceipt(c.id, j.source_id);
  });
  let timer,
    running,
    closed = false;
  if (worker ?? process.env.APP_ENV === 'production') {
    timer = setInterval(() => {
      if (!closed && !running)
        running = processOne()
          .catch(() => {})
          .finally(() => {
            running = null;
          });
    }, 2000);
    timer.unref();
  }
  app.addHook('onClose', async () => {
    closed = true;
    clearInterval(timer);
    await running;
  });
  return {
    requireReady,
    requireRefundReady,
    enqueue,
    enqueueRefund,
    captureOrder,
    getReceipt,
    processOne,
  };
}
