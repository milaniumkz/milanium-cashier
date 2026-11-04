import { randomUUID } from 'node:crypto';
import { AppError } from './db.js';

// All amounts are integer micro-KZT. Never accept a model's claimed cost.
const integer = (value, name, positive = false) => {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new AppError('INVALID_AMOUNT', `Некорректное значение: ${name}.`, 400);
  return value;
};
const reference = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:_./-]{1,180}$/.test(value)) throw new AppError('INVALID_REFERENCE', 'Некорректный идентификатор операции.', 400);
  return value;
};
const safe = value => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError('AMOUNT_OVERFLOW', 'Сумма превышает допустимую точность.', 400);
  return Number(value);
};
export function aiUsageCost({ input, cached = 0, output, rates, fx }) {
  for (const [name, value] of Object.entries({ input, cached, output, fx })) integer(value, name, name === 'fx');
  if (cached > input) throw new AppError('INVALID_USAGE', 'Кэшированные токены превышают входящие.', 400);
  for (const name of ['input', 'cached', 'output']) integer(rates[name], `rates.${name}`);
  // Rates: micro-USD per million tokens; FX: micro-KZT per USD.
  // Round once, upwards, to one micro-KZT; never round each token separately.
  const numerator = (BigInt(input - cached) * BigInt(rates.input) + BigInt(cached) * BigInt(rates.cached) + BigInt(output) * BigInt(rates.output)) * BigInt(fx);
  return safe((numerator + 999999999999n) / 1000000000000n);
}

export class ServiceWallet {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS service_wallets (
        merchant_id TEXT PRIMARY KEY REFERENCES merchants(id),
        balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0),
        reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=balance)
      );
      CREATE TABLE IF NOT EXISTS service_operations (
        id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id),
        reference TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('reserved','unknown','settled','released')),
        ceiling INTEGER NOT NULL CHECK(ceiling>0), charged INTEGER,
        snapshot TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(merchant_id,reference)
      );
      CREATE TABLE IF NOT EXISTS service_ledger (
        id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id),
        reference TEXT NOT NULL UNIQUE, amount INTEGER NOT NULL,
        balance_after INTEGER NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
  }
  wallet(id) {
    this.db.prepare('INSERT OR IGNORE INTO service_wallets(merchant_id) VALUES(?)').run(id);
    const row = this.db.prepare('SELECT * FROM service_wallets WHERE merchant_id=?').get(id);
    return { ...row, available: row.balance - row.reserved, currency: 'KZT', scale: 1000000 };
  }
  operation(id, ref) { return this.db.prepare('SELECT * FROM service_operations WHERE merchant_id=? AND reference=?').get(id, ref); }
  // Internal only: caller must independently verify a bank payment before crediting.
  credit(id, amount, bankReference, detail, insideTransaction = false) {
    integer(amount, 'amount', true); reference(bankReference);
    if (typeof detail !== 'string' || !detail.trim() || detail.length > 1000) throw new AppError('INVALID_DETAIL', 'Нужно основание пополнения.', 400);
    const execute = () => {
      const ref = `bank:${bankReference}`;
      const prior = this.db.prepare('SELECT * FROM service_ledger WHERE reference=?').get(ref);
      if (prior) {
        if (prior.merchant_id !== id || prior.amount !== amount || prior.detail !== detail) throw new AppError('PAYMENT_CONFLICT', 'Банковский платёж уже использован.', 409);
        return this.wallet(id);
      }
      const wallet = this.wallet(id), balance = safe(BigInt(wallet.balance) + BigInt(amount));
      this.db.prepare('UPDATE service_wallets SET balance=? WHERE merchant_id=?').run(balance, id);
      this.db.prepare('INSERT INTO service_ledger VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, ref, amount, balance, detail, Date.now());
      return this.wallet(id);
    };
    return insideTransaction ? execute() : this.store.transaction(execute);
  }
  reserve(id, { ref, actor, kind, ceiling, snapshot }, insideTransaction = false) {
    reference(ref); reference(actor); integer(ceiling, 'ceiling', true);
    // Advertising budgets paid directly by clients are never platform charges.
    if (!['ai', 'platform_service'].includes(kind)) throw new AppError('NON_BILLABLE_COST', 'Рекламный бюджет оплачивается напрямую провайдеру.', 400);
    const encoded = JSON.stringify(snapshot);
    if (!encoded || encoded.length > 16000) throw new AppError('INVALID_SNAPSHOT', 'Нужен снимок условий тарификации.', 400);
    const execute = () => {
      const previous = this.operation(id, ref);
      if (previous) {
        if (previous.actor !== actor || previous.kind !== kind || previous.ceiling !== ceiling || previous.snapshot !== encoded) throw new AppError('OPERATION_CONFLICT', 'Параметры операции изменились.', 409);
        return { operation: previous, replay: true };
      }
      const wallet = this.wallet(id);
      if (wallet.available < ceiling) throw new AppError('INSUFFICIENT_SERVICE_BALANCE', 'Недостаточно средств на балансе услуг.', 402);
      this.db.prepare('UPDATE service_wallets SET reserved=reserved+? WHERE merchant_id=?').run(ceiling, id);
      const time = Date.now();
      this.db.prepare('INSERT INTO service_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), id, ref, actor, kind, 'reserved', ceiling, null, encoded, null, time, time);
      return { operation: this.operation(id, ref), replay: false };
    };
    return insideTransaction ? execute() : this.store.transaction(execute);
  }
  unknown(id, ref) {
    this.db.prepare("UPDATE service_operations SET status='unknown',updated_at=? WHERE merchant_id=? AND reference=? AND status='reserved'").run(Date.now(), id, ref);
    return this.operation(id, ref);
  }
  settle(id, ref, amount, evidence, insideTransaction = false) { return this.finish(id, ref, 'settled', integer(amount, 'amount'), evidence, insideTransaction); }
  release(id, ref, evidence, insideTransaction = false) { return this.finish(id, ref, 'released', 0, evidence, insideTransaction); }
  finish(id, ref, status, amount, evidence, insideTransaction = false) {
    if (typeof evidence !== 'string' || !evidence.trim() || evidence.length > 16000) throw new AppError('INVALID_EVIDENCE', 'Нужно подтверждение результата провайдера.', 400);
    const execute = () => {
      const op = this.operation(id, ref);
      if (!op) throw new AppError('NOT_FOUND', 'Операция не найдена.', 404);
      if (['settled', 'released'].includes(op.status)) {
        if (op.status !== status || op.charged !== amount || op.result !== evidence) throw new AppError('OPERATION_CONFLICT', 'Операция уже завершена с другим результатом.', 409);
        return op;
      }
      if (amount > op.ceiling) throw new AppError('COST_EXCEEDS_RESERVE', 'Стоимость выше резерва: требуется сверка.', 409);
      const wallet = this.wallet(id);
      this.db.prepare('UPDATE service_wallets SET balance=balance-?,reserved=reserved-? WHERE merchant_id=?').run(amount, op.ceiling, id);
      this.db.prepare('UPDATE service_operations SET status=?,charged=?,result=?,updated_at=? WHERE id=?').run(status, amount, evidence, Date.now(), op.id);
      if (status === 'settled') this.db.prepare('INSERT INTO service_ledger VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, `usage:${op.id}`, -amount, wallet.balance - amount, evidence, Date.now());
      return this.operation(id, ref);
    };
    return insideTransaction ? execute() : this.store.transaction(execute);
  }
}
