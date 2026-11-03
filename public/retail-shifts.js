import { esc, money, date, minor } from '/assets/retail-shared.js';
export function mountShifts(root, api, header, wallets) {
  let stopped = false,
    error = '',
    rows = [],
    after = null,
    busy = false;
  const draw = () => {
    if (stopped) return;
    root.innerHTML =
      header(
        'Смены магазина',
        'Открывайте смену денежного счёта и фиксируйте фактически пересчитанную сумму при закрытии.',
      ) +
      (error ? `<p class="notice red" role="alert">${esc(error)}</p>` : '') +
      `<section class="panel retail-info"><h2>Открыть смену</h2><form id="open-shop-shift"><label>Денежный счёт<select name="walletId" required><option value="">Выберите счёт</option>${wallets.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></label><button class="primary" ${busy ? 'disabled' : ''}>Открыть смену</button></form><p class="retail-hint">Открытие и закрытие смены не меняет деньги. Это фактический пересчёт, без автоматической корректировки недостачи или излишка. Z-отчёт фискальной кассы закрывайте у провайдера.</p></section><section class="panel retail-info"><h2>Смены</h2>${rows.map((s) => `<article class="terminal-card"><div class="panel-head"><h3>${esc(wallets.find((w) => w.id === s.wallet_id)?.name || 'Денежный счёт')}</h3><span class="badge">${s.status === 'OPEN' ? 'Открыта' : 'Закрыта'}</span></div><p>Кассир: ${esc(s.opened_by_name)} · Открыта ${date(s.opened_at)}<br>На открытие: ${money(s.opening)}</p>${s.status === 'OPEN' ? `<form data-close-shift="${s.id}"><label>Пересчитано по факту, ₸<input name="amount" inputmode="decimal" required></label><button class="secondary">Закрыть учётную смену</button></form>` : `<p>По учёту на закрытие: ${money(s.expected_balance)} · Факт: ${money(s.closing)} · Разница: ${money(s.difference)}</p>`}</article>`).join('') || '<p>Смен пока нет.</p>'}<button class="secondary" id="more-shop-shifts" ${!after ? 'disabled' : ''}>Загрузить ещё</button></section>`;
    root.querySelector('#open-shop-shift').onsubmit = (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      run(async () => {
        await api('/shifts', 'POST', body, crypto.randomUUID());
        await load();
      });
    };
    root.querySelectorAll('[data-close-shift]').forEach(
      (f) =>
        (f.onsubmit = (e) => {
          e.preventDefault();
          const amount = new FormData(f).get('amount');
          run(async () => {
            await api(
              '/shifts/' + f.dataset.closeShift + '/close',
              'POST',
              { countedAmount: minor(amount) },
              crypto.randomUUID(),
            );
            await load();
          });
        }),
    );
    root.querySelector('#more-shop-shifts').onclick = () =>
      run(async () => {
        const r = await api('/shifts?limit=50&after=' + after);
        rows.push(...r.items);
        after = r.nextCursor;
      });
  };
  async function load() {
    const r = await api('/shifts?limit=50');
    rows = r.items;
    after = r.nextCursor;
  }
  async function run(fn) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await fn();
    } catch (e) {
      error = e.message;
    } finally {
      busy = false;
      draw();
    }
  }
  run(load);
  return () => {
    stopped = true;
  };
}
