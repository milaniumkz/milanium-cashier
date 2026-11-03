import { randomUUID } from 'node:crypto';
import { fail, text, integer, businessDate } from './security.js';
import { postJournal } from './accounting.js';
import { getGoodsOrder } from './goods-commands.js';
export async function registerRetailReturns(app, { db, auth, access, command, sale, fiscal }) {
  await db.exec(`CREATE TABLE IF NOT EXISTS retail_returns(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),sale_id TEXT NOT NULL REFERENCES retail_sales(id),actor_id TEXT NOT NULL REFERENCES users(id),data TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS retail_return_allocations(return_id TEXT NOT NULL REFERENCES retail_returns(id),batch_id TEXT NOT NULL REFERENCES batches(id),quantity BIGINT NOT NULL,unit_cost BIGINT NOT NULL,PRIMARY KEY(return_id,batch_id));`);
  const base = '/v1/companies/:companyId/retail',
    route = (m, p, h) => app.route({ method: m, url: base + p, preHandler: auth, handler: h });
  async function history(c, id) {
    await sale(c, id);
    const rows = await db
      .prepare(
        'SELECT r.*,u.name actor_name FROM retail_returns r JOIN users u ON u.id=r.actor_id WHERE r.company_id=? AND r.sale_id=? ORDER BY r.created_at',
      )
      .all(c, id);
    return Promise.all(
      rows.map(async (r) => ({
        ...r,
        data: JSON.parse(r.data),
        fiscal: await fiscal.getReceipt(c, r.id),
      })),
    );
  }
  async function preview(c, saleId, b) {
    const s = await sale(c.id, saleId),
      order = s.order;
    if (!['CLOSED', 'SHIPPED'].includes(order.status) || order.paid < order.data.total)
      fail(409, 'sale_not_fully_paid');
    const old = await history(c.id, saleId),
      returned = new Map();
    for (const r of old)
      for (const item of r.data.items)
        returned.set(item.productId, (returned.get(item.productId) || 0) + item.quantity);
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 100)
      fail(400, 'invalid_items');
    const seen = new Set(),
      items = [];
    for (const line of b.items) {
      const productId = text(line.productId, 'productId');
      if (seen.has(productId)) fail(400, 'duplicate_product');
      seen.add(productId);
      const originals = order.data.items.filter((i) => i.productId === productId);
      if (originals.length !== 1) fail(409, 'return_ambiguous_lines');
      const source = originals[0],
        quantity = integer(line.quantity, 'quantity', 1),
        before = returned.get(productId) || 0;
      if (before + quantity > source.quantity) fail(409, 'return_quantity_exceeded');
      const part = (amount) =>
          Math.round((amount * (before + quantity)) / source.quantity) -
          Math.round((amount * before) / source.quantity),
        net = integer(part(source.net), 'return_net'),
        vat = integer(part(source.vat || 0), 'return_vat');
      items.push({
        productId,
        name: source.productName,
        quantity,
        net,
        vat,
        total: net + vat,
        alreadyReturned: before,
      });
    }
    const total = integer(
      items.reduce((n, i) => n + i.total, 0),
      'return_total',
    );
    if (total <= 0) fail(400, 'zero_refund_total');
    return {
      sale: s,
      items,
      total,
      net: items.reduce((n, i) => n + i.net, 0),
      vat: items.reduce((n, i) => n + i.vat, 0),
    };
  }
  route('GET', '/sales/:id/returns', async (r) => {
    const c = await access(r, 'orders.read');
    return { items: await history(c.id, r.params.id) };
  });
  route('POST', '/sales/:id/refund-preview', async (r) => {
    const c = await access(r, 'orders.read');
    const p = await preview(c, r.params.id, r.body || {});
    return { items: p.items, total: p.total, net: p.net, vat: p.vat };
  });
  route('POST', '/sales/:id/returns', (r) =>
    command(r, 'orders.edit', 'retail.refund', async (c) => {
      for (const permission of ['orders.fulfill', 'payments.write', 'wallets.transact'])
        await access(r, permission);
      const b = r.body || {};
      if (b.refundConfirmed !== true) fail(400, 'refund_confirmation_required');
      const p = await preview(c, r.params.id, b);
      if (p.total !== b.expectedTotal) fail(409, 'refund_total_changed');
      await fiscal.requireRefundReady(c.id, p.sale.id);
      const w = await db
        .prepare('SELECT * FROM wallets WHERE company_id=? AND id=?')
        .get(c.id, text(b.walletId, 'walletId'));
      if (!w) fail(404, 'wallet_not_found');
      if (w.scope !== p.sale.order.data.scope) fail(400, 'incompatible_ledger_scope');
      if (w.balance < p.total) fail(409, 'insufficient_wallet_balance');
      const id = randomUUID(),
        date = businessDate(b.businessDate, c.timezone),
        allocations = [];
      let cost = 0;
      for (const item of p.items) {
        const rows = await db
          .prepare(
            'SELECT a.*,b.product_id,COALESCE((SELECT sum(ra.quantity) FROM retail_return_allocations ra JOIN retail_returns rr ON rr.id=ra.return_id WHERE rr.sale_id=? AND ra.batch_id=a.batch_id),0) returned FROM shipment_allocations a JOIN batches b ON b.id=a.batch_id WHERE a.order_id=? AND b.product_id=? ORDER BY b.received_sequence',
          )
          .all(p.sale.id, p.sale.order_id, item.productId);
        let remaining = item.quantity;
        for (const row of rows) {
          const quantity = Math.min(remaining, row.quantity - row.returned);
          if (quantity > 0) {
            allocations.push({ batchId: row.batch_id, quantity, unitCost: row.unit_cost });
            cost = integer(cost + quantity * row.unit_cost, 'return_cost');
            remaining -= quantity;
          }
          if (!remaining) break;
        }
        if (remaining) fail(409, 'return_stock_history_mismatch');
      }
      const posting = await postJournal(db, c, {
        scope: w.scope,
        projectId: p.sale.order.data.projectId,
        businessDate: date,
        description: 'Возврат розничной продажи ' + p.sale.order.data.number,
        lines: [
          ...(p.net ? [{ account: 'revenue', debit: p.net }] : []),
          ...(p.vat ? [{ account: 'vat_payable', debit: p.vat }] : []),
          { account: 'wallet:' + w.id, credit: p.total },
        ],
      });
      if (cost)
        await postJournal(db, c, {
          scope: w.scope,
          projectId: p.sale.order.data.projectId,
          businessDate: date,
          description: 'Возврат товара на склад ' + p.sale.order.data.number,
          lines: [
            { account: 'inventory', debit: cost },
            { account: 'cogs', credit: cost },
          ],
        });
      const data = {
        number: 'ВЗ-' + id.slice(0, 8),
        saleNumber: p.sale.order.data.number,
        items: p.items,
        total: p.total,
        net: p.net,
        vat: p.vat,
        cost,
        walletId: w.id,
        businessDate: date,
        scope: w.scope,
        paymentKind: p.sale.method === 'cash' ? 'cash' : p.sale.payment_kind || 'card',
        bankRefundManual: p.sale.method !== 'cash',
      };
      await db
        .prepare('INSERT INTO retail_returns VALUES(?,?,?,?,?,?)')
        .run(id, c.id, p.sale.id, r.user.id, JSON.stringify(data), new Date().toISOString());
      for (const a of allocations) {
        await db
          .prepare('INSERT INTO retail_return_allocations VALUES(?,?,?,?)')
          .run(id, a.batchId, a.quantity, a.unitCost);
        await db
          .prepare('UPDATE batches SET quantity=quantity+? WHERE id=?')
          .run(a.quantity, a.batchId);
      }
      await db
        .prepare(
          'INSERT INTO wallet_entries(id,company_id,wallet_id,amount,kind,reference_id,created_at,journal_id) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          randomUUID(),
          c.id,
          w.id,
          -p.total,
          'RETAIL_REFUND',
          id,
          new Date().toISOString(),
          posting.id,
        );
      await db
        .prepare('INSERT INTO movements VALUES(?,?,?,?,?)')
        .run(id, c.id, 'RETAIL_RETURN', JSON.stringify(data), new Date().toISOString());
      const f = await fiscal.enqueueRefund(c.id, p.sale.id, id, data);
      return { id, saleId: p.sale.id, data, fiscal: f };
    }),
  );
}
