// Own adapters based on the published Webkassa v4 collection and re:Kassa partner protocol.
// Endpoints are fixed: company settings cannot turn this into an arbitrary HTTP proxy.
export const endpoints = {
  webkassa: { test: 'https://devkkm.webkassa.kz', live: 'https://kkm.webkassa.kz' },
  rekassa: { test: 'https://api-test.rekassa.kz', live: 'https://app.rekassa.kz/partner' },
};
export class FiscalError extends Error {
  constructor(code, { unknown = false, providerCode = null } = {}) {
    super(code);
    this.code = code;
    this.unknown = unknown;
    this.providerCode = providerCode;
  }
}
const reject = (code, unknown = false, providerCode = null) => {
  throw new FiscalError(code, { unknown, providerCode });
};
export const money = (n) => ({ bills: String(Math.floor(n / 100)), coins: n % 100 });
const minor = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0 || v > 1e10) return NaN;
  return Math.round(v * 100);
};
const fromMoney = (n) =>
  n &&
  /^\d+$/.test(String(n.bills)) &&
  Number.isInteger(Number(n.coins)) &&
  Number(n.coins) >= 0 &&
  Number(n.coins) < 100
    ? Number(n.bills) * 100 + Number(n.coins)
    : NaN;
const safeUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
};
const data = (r) => (r?.data && typeof r.data === 'object' ? r.data : r);
// Splitting a line preserves the exact charged total with two-decimal unit prices.
export function fiscalLines(payload) {
  return payload.items.flatMap((item) => {
    if (
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 1_000_000_000 ||
      !Number.isSafeInteger(item.total) ||
      item.total < 0 ||
      item.total > 1e12
    )
      reject('fiscal_invalid_amount');
    const price = Math.floor(item.total / item.quantity),
      remainder = item.total % item.quantity,
      parts = [
        { quantity: item.quantity - remainder, unitPrice: price },
        { quantity: remainder, unitPrice: price + 1 },
      ].filter((p) => p.quantity);
    let usedVat = 0;
    return parts.map((p, i) => {
      const total = p.quantity * p.unitPrice,
        vat =
          i === parts.length - 1
            ? item.vat - usedVat
            : Math.round((item.vat * total) / (item.total || 1));
      usedVat += vat;
      return { ...item, ...p, total, vat };
    });
  });
}
export function createFiscalDriver(cfg, { transport } = {}) {
  const origin = endpoints[cfg.provider]?.[cfg.mode];
  if (!origin) reject('fiscal_invalid_provider');
  async function http(method, path, body, headers = {}, mutating = false) {
    let r;
    try {
      if (transport) r = await transport({ method, url: origin + path, body, headers });
      else {
        const response = await fetch(origin + path, {
          method,
          headers: { 'content-type': 'application/json', ...headers },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: 'error',
          signal: AbortSignal.timeout(20000),
        });
        const raw = await response.text();
        let value;
        try {
          value = JSON.parse(raw);
        } catch {
          value = raw;
        }
        r = { status: response.status, data: value };
      }
    } catch {
      reject('fiscal_connection_failed', mutating);
    }
    if (r.status < 200 || r.status >= 300)
      reject(
        r.status === 401 || r.status === 403 ? 'fiscal_auth_failed' : 'fiscal_provider_rejected',
        mutating && ![400, 401, 403, 422].includes(r.status),
      );
    if (cfg.provider === 'webkassa' && r.data?.Errors?.length) {
      const code = String(r.data.Errors[0].Code ?? '');
      reject(
        'fiscal_provider_rejected',
        mutating && code === '14',
        /^\d{1,8}$/.test(code) ? code : null,
      );
    }
    return r.data;
  }
  async function prepare() {
    if (cfg.provider === 'webkassa') {
      const auth = await http(
        'POST',
        '/api/v4/Authorize',
        { Login: cfg.login, Password: cfg.password },
        { 'x-api-key': cfg.apiKey },
      );
      const token = auth?.Data?.Token;
      if (typeof token !== 'string' || !token) reject('fiscal_auth_failed');
      const call = (path, b, mutating = false) =>
        http(
          'POST',
          '/api/v4/' + path,
          { Token: token, ...b },
          { 'x-api-key': cfg.apiKey },
          mutating,
        );
      const response = await call('Cashboxes', {}),
        d = response?.Data,
        rows = Array.isArray(d) ? d : d?.Cashboxes || d?.Items || [];
      const cashbox = rows.find((c) => String(c.UniqueNumber) === cfg.cashboxId);
      if (!cashbox) reject('fiscal_cashbox_not_found');
      return { call, cashbox, token };
    }
    const a = await http(
      'POST',
      '/api/auth/login?apiKey=' + encodeURIComponent(cfg.apiKey) + '&format=json',
      { number: cfg.login, password: cfg.password },
    );
    const token = typeof a === 'string' ? a : a?.token;
    if (typeof token !== 'string' || !token) reject('fiscal_auth_failed');
    if (a?.id != null && String(a.id) !== cfg.cashboxId) reject('fiscal_cashbox_not_found');
    const call = (method, path, b, mutating = false, headers = {}) =>
        http(method, path, b, { Authorization: 'Bearer ' + token, ...headers }, mutating),
      response = await call('GET', '/api/crs/' + encodeURIComponent(cfg.cashboxId)),
      cashbox = [
        response?.cashRegister,
        response?.data?.cashRegister,
        response,
        response?.data,
      ].find((c) => String(c?.id) === cfg.cashboxId);
    if (String(cashbox?.id) !== cfg.cashboxId) reject('fiscal_cashbox_not_found');
    return { call, cashbox, token };
  }
  function webReceipt(d, p) {
    if (
      !d ||
      String(d.ExternalCheckNumber) !== p.id ||
      minor(d.Total) !== p.total ||
      String(d.Cashbox?.UniqueNumber) !== cfg.cashboxId ||
      !d.CheckNumber
    )
      reject('fiscal_response_mismatch', true);
    return {
      provider: 'webkassa',
      mode: cfg.mode,
      number: String(d.CheckNumber),
      providerId: String(d.CheckNumber),
      shift: d.ShiftNumber,
      total: p.total,
      cashboxId: cfg.cashboxId,
      registrationNumber: d.Cashbox.RegistrationNumber,
      dateTime: d.DateTime,
      offline: !!d.OfflineMode,
      url: safeUrl(d.TicketUrl || d.TicketPrintUrl),
      externalId: p.id,
    };
  }
  function rekReceipt(raw, p) {
    const core = raw?.data?.ticket || raw?.ticket || data(raw),
      id = raw?.id || raw?.data?.id || core?.id,
      number = raw?.ticketNumber || raw?.data?.ticketNumber || core?.ticketNumber;
    if (
      (typeof raw?.status === 'string' && raw.status.toUpperCase() !== 'OK') ||
      !id ||
      !number ||
      fromMoney(core?.amounts?.total) !== p.total
    )
      reject('fiscal_response_mismatch', true);
    return {
      provider: 'rekassa',
      mode: cfg.mode,
      number: String(number),
      providerId: String(id),
      shift: raw.shiftNumber ?? core.shiftNumber,
      total: p.total,
      cashboxId: cfg.cashboxId,
      registrationNumber:
        raw?.data?.service?.regInfo?.kkm?.fnsKkmId ||
        core.registrationNumber ||
        core.cashRegister?.registrationNumber,
      dateTime: core.dateTime,
      offline: !!(raw.offline || core.offline),
      url: safeUrl(raw.ticketUrl || core.ticketUrl || raw.url || core.url),
      externalId: p.id,
    };
  }

  async function verify() {
    const c = await prepare();
    return { cashboxId: cfg.cashboxId, name: c.cashbox.Name || c.cashbox.name || cfg.cashboxId };
  }
  async function issue(p) {
    const ctx = await prepare(),
      lines = fiscalLines(p);
    if (cfg.provider === 'webkassa') {
      const body = {
        CashboxUniqueNumber: cfg.cashboxId,
        OperationType: p.kind === 'refund' ? 3 : 2,
        Positions: lines.map((i) => ({
          Count: i.quantity,
          Price: i.unitPrice / 100,
          TaxPercent: p.vatRegistered ? 16 : 0,
          Tax: i.vat / 100,
          TaxType: p.vatRegistered ? 100 : 0,
          PositionName: i.name,
          PositionCode: i.productId,
          PositionType: 0,
          UnitCode: i.unitCode || 796,
          GTIN: i.gtin || undefined,
          NTIN: i.ntin || undefined,
        })),
        Payments: [
          {
            Sum: p.total / 100,
            PaymentType: p.paymentKind === 'cash' ? 0 : p.paymentKind === 'mobile' ? 4 : 1,
          },
        ],
        Change: p.kind === 'refund' ? 0 : p.change / 100,
        RoundType: 0,
        ExternalCheckNumber: p.id,
        ExternalOrderNumber: p.number,
        ...(p.kind === 'refund'
          ? {
              ReturnBasisDetails: {
                CheckNumber: p.parent.number,
                DateTime: p.parent.dateTime,
                RegistrationNumber: p.parent.registrationNumber,
                Total: p.parent.total / 100,
                IsOffline: p.parent.offline,
              },
            }
          : {}),
      };
      return webReceipt((await ctx.call('check', body, true))?.Data, p);
    }
    if (p.vatRegistered) reject('rekassa_vat_contract_required');
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Almaty',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hourCycle: 'h23',
      })
        .formatToParts(new Date())
        .filter((x) => x.type !== 'literal')
        .map((x) => [x.type, Number(x.value)]),
    );
    const body = {
      operation: p.kind === 'refund' ? 'OPERATION_SELL_RETURN' : 'OPERATION_SELL',
      dateTime: {
        date: { year: parts.year, month: parts.month, day: parts.day },
        time: { hour: parts.hour, minute: parts.minute, second: parts.second },
      },
      domain: { type: 'DOMAIN_SERVICES' },
      items: lines.map((i) => ({
        type: 'ITEM_TYPE_COMMODITY',
        commodity: {
          name: i.name,
          sectionCode: '1',
          quantity: i.quantity * 1000,
          price: money(i.unitPrice),
          sum: money(i.total),
          measureUnitCode: 796,
          auxiliary: [{ key: 'UNIT_TYPE', value: 'PIECE' }],
          ...(i.gtin ? { barcode: i.gtin } : {}),
          ...(i.ntin ? { ntin: i.ntin } : {}),
        },
      })),
      payments: [
        {
          type:
            p.paymentKind === 'cash'
              ? 'PAYMENT_CASH'
              : p.paymentKind === 'mobile'
                ? 'PAYMENT_MOBILE'
                : 'PAYMENT_CARD',
          sum: money(p.total),
        },
      ],
      amounts: {
        total: money(p.total),
        taken: money(p.paymentKind === 'cash' && p.kind !== 'refund' ? p.tendered : 0),
        change: money(p.kind === 'refund' ? 0 : p.change),
      },
      operator: { code: 0 },
      ...(p.kind === 'refund'
        ? {
            parentTicket: {
              parentTicketNumber: p.parent.number,
              parentTicketDataTime: p.parent.dateTime,
              kgdKkmId: p.parent.registrationNumber,
              parentTicketTotal: money(p.parent.total),
              parentTicketIsOffline: p.parent.offline,
            },
          }
        : {}),
    };
    return rekReceipt(
      await ctx.call(
        'POST',
        '/api/crs/' + encodeURIComponent(cfg.cashboxId) + '/tickets',
        body,
        true,
        { 'X-Request-ID': p.id },
      ),
      p,
    );
  }
  async function recover(p) {
    if (cfg.provider !== 'webkassa') return null;
    const c = await prepare(),
      x = (await c.call('XReport', { CashboxUniqueNumber: cfg.cashboxId }))?.Data,
      current = Number(x?.ShiftNumber);
    if (!Number.isSafeInteger(current) || current < 1) return null;
    for (const shift of [current, current - 1].filter((v) => v > 0))
      for (let skip = 0; skip < 10000; skip += 100) {
        const response = await c.call('Check/History', {
            CashboxUniqueNumber: cfg.cashboxId,
            ShiftNumber: shift,
            Skip: skip,
            Take: 100,
          }),
          d = response?.Data,
          rows = Array.isArray(d) ? d : d?.Items || d?.Checks || [];
        const found = rows.find((r) => String(r.ExternalCheckNumber) === p.id);
        if (found) {
          const number = found.Number ?? found.CheckNumber;
          const full = (
            await c.call('Check/HistoryByNumber', {
              cashboxUniqueNumber: cfg.cashboxId,
              Number: number,
              shiftNumber: shift,
            })
          )?.Data;
          return webReceipt(full, p);
        }
        if (rows.length < 100) break;
      }
    return null;
  }
  return { verify, issue, recover };
}
