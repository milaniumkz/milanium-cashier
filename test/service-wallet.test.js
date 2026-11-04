import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ServiceWallet, aiUsageCost } from '../src/service-wallet.js';
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE merchants(id TEXT PRIMARY KEY); INSERT INTO merchants VALUES('a'),('b');");
  const store = { db, transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
  t.after(() => db.close()); return new ServiceWallet(store);
}
const request = { ref: 'request:one', actor: 'staff:one', kind: 'ai', ceiling: 300000000, snapshot: { model: 'test', rate_version: 1, fx: 500000000 } };
test('service balance: reserve, actual half-dollar cost, replay and cross-company isolation', t => {
  const w = fixture(t);
  w.credit('a', 1000000000, 'transfer:1', 'Verified bank transfer');
  assert.equal(w.credit('a', 1000000000, 'transfer:1', 'Verified bank transfer').balance, 1000000000);
  assert.throws(() => w.credit('b', 1000000000, 'transfer:1', 'Verified bank transfer'), { code: 'PAYMENT_CONFLICT' });
  assert.equal(w.reserve('a', request).replay, false);
  assert.equal(w.reserve('a', request).replay, true);
  assert.equal(w.wallet('a').available, 700000000);
  assert.throws(() => w.reserve('b', request), { code: 'INSUFFICIENT_SERVICE_BALANCE' });
  const amount = aiUsageCost({ input: 1000000, output: 0, rates: { input: 500000, cached: 0, output: 0 }, fx: 500000000 });
  assert.equal(amount, 250000000); // $0.50 at 500 KZT/USD = 250 KZT.
  w.settle('a', request.ref, amount, 'provider:response:1');
  w.settle('a', request.ref, amount, 'provider:response:1');
  assert.equal(w.wallet('a').balance, 750000000);
  assert.equal(w.wallet('a').reserved, 0);
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM service_ledger WHERE amount<0').get().n, 1);
  assert.throws(() => w.settle('a', request.ref, amount + 1, 'provider:response:1'), { code: 'OPERATION_CONFLICT' });
});
test('unknown response retains reserve; overrun cannot debit; verified failure releases', t => {
  const w = fixture(t); w.credit('a', 500000000, 'transfer:2', 'Verified');
  w.reserve('a', request); w.unknown('a', request.ref);
  assert.equal(w.operation('a', request.ref).status, 'unknown');
  assert.equal(w.reserve('a', request).replay, true);
  assert.throws(() => w.settle('a', request.ref, 300000001, 'provider:overrun'), { code: 'COST_EXCEEDS_RESERVE' });
  assert.equal(w.wallet('a').reserved, 300000000);
  w.release('a', request.ref, 'provider:confirmed-not-executed');
  assert.equal(w.wallet('a').available, 500000000);
  assert.throws(() => w.settle('a', request.ref, 1, 'late'), { code: 'OPERATION_CONFLICT' });
});
test('client-direct advertising is never charged; unsafe amounts and changed retries rejected', t => {
  const w = fixture(t); w.credit('a', 500000000, 'transfer:3', 'Verified');
  for (const kind of ['meta_ads', 'tiktok_ads', 'advertising']) assert.throws(() => w.reserve('a', { ...request, kind }), { code: 'NON_BILLABLE_COST' });
  w.reserve('a', request);
  assert.throws(() => w.reserve('a', { ...request, ceiling: 1 }), { code: 'OPERATION_CONFLICT' });
  assert.throws(() => w.credit('a', 0.1, 'bad', 'Verified'), { code: 'INVALID_AMOUNT' });
  assert.throws(() => aiUsageCost({ input: 1, cached: 2, output: 0, rates: {}, fx: 1 }), { code: 'INVALID_USAGE' });
  assert.equal(aiUsageCost({ input: 1, output: 0, rates: { input: 1, cached: 0, output: 0 }, fx: 1 }), 1);
});
