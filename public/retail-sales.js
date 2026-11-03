import { esc, money, date } from '/assets/retail-shared.js';
import { fiscalReceiptMarkup } from '/assets/retail-fiscal.js';
export function mountSales(root, api, header, wallets) {
  let stopped = false,
    busy = false,
    error = '',
    sales = [],
    selected,
    returns = [],
    preview;
  const draw = () => {
    if (stopped) return;
    root.innerHTML =
      header(
        'Продажи и возвраты',
        'История продаж магазина, частичные возвраты товара и денег, фискальные чеки.',
      ) +
      (error ? `<p class="notice red" role="alert">${esc(error)}</p>` : '') +
      (!selected
        ? `<section class="panel retail-info"><h2>Последние 50 продаж</h2>${sales.map((s) => `<button class="retail-history-row" data-shop-sale="${s.id}"><span>${esc(s.order.data.number)} · ${date(s.created_at)}<small>${s.method === 'cash' ? 'Наличные' : s.channel === 'kaspi' ? 'Kaspi терминал' : 'Другой терминал'} · ${esc(s.actor_name)}</small></span><b>${money(s.order.data.total)}</b></button>`).join('') || '<p>Продаж пока нет.</p>'}</section>`
        : `<section class="panel retail-info"><button class="text-button" id="all-shop-sales">← Все продажи</button><h2>Продажа ${esc(selected.order.data.number)}</h2><p>${date(selected.created_at)} · ${esc(selected.actor_name)} · ${money(selected.order.data.total)}</p>${fiscalReceiptMarkup(selected.fiscal)}<h3>Вернуть товар</h3>${selected.method !== 'cash' ? '<div class="notice amber">Банковский возврат сейчас выполняется отдельно на терминале. Здесь фиксируйте его только после подтверждения банка. Команда возврата в банк не отправляется.</div>' : ''}<form id="shop-refund-form">${selected.order.data.items
            .map((i) => {
              const used = returns.reduce(
                (n, r) =>
                  n +
                  r.data.items
                    .filter((x) => x.productId === i.productId)
                    .reduce((n, x) => n + x.quantity, 0),
                0,
              );
              return `<label>${esc(i.productName)} · Куплено ${i.quantity} · Уже возвращено ${used}<input type="number" data-refund-product="${i.productId}" min="0" max="${i.quantity - used}" step="1" value="0"></label>`;
            })
            .join(
              '',
            )}<label>Счёт возврата<select name="walletId" required><option value="">Выберите</option>${wallets
            .filter((w) => w.scope === selected.order.data.scope)
            .map((w) => `<option value="${w.id}">${esc(w.name)}</option>`)
            .join(
              '',
            )}</select></label><label>Дата возврата<input name="businessDate" type="date" required value="${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(new Date())}"></label><button class="secondary" type="button" id="preview-shop-refund">Рассчитать сумму возврата</button><div id="refund-summary">${preview ? `<strong class="pos-total">К возврату ${money(preview.total)}</strong>` : ''}</div><label class="inline-label"><input name="confirmed" type="checkbox" required>Товар возвращён на склад, деньги действительно возвращены покупателю</label><button class="primary" type="submit" ${!preview || busy ? 'disabled' : ''}>Оформить возврат</button></form></section><section class="panel retail-info"><h2>Оформленные возвраты</h2>${returns.map((r) => `<article class="terminal-card"><h3>${esc(r.data.number)} · ${money(r.data.total)}</h3><p>${date(r.created_at)} · ${esc(r.actor_name)}</p>${fiscalReceiptMarkup(r.fiscal)}</article>`).join('') || '<p>Возвратов нет.</p>'}</section>`);
    root.querySelectorAll('[data-shop-sale]').forEach(
      (b) =>
        (b.onclick = () =>
          run(async () => {
            selected = await api('/sales/' + b.dataset.shopSale);
            returns = (await api('/sales/' + selected.id + '/returns')).items;
            preview = null;
          })),
    );
    root.querySelector('#all-shop-sales')?.addEventListener('click', () => {
      selected = null;
      draw();
    });
    const form = root.querySelector('#shop-refund-form');
    if (form) {
      const items = () =>
        [...form.querySelectorAll('[data-refund-product]')]
          .filter((el) => Number(el.value) > 0)
          .map((el) => ({ productId: el.dataset.refundProduct, quantity: Number(el.value) }));
      let quotedItems;
      form.querySelectorAll('[data-refund-product]').forEach(
        (el) =>
          (el.oninput = () => {
            preview = null;
            form.querySelector('[type=submit]').disabled = true;
            root.querySelector('#refund-summary').textContent =
              'Пересчитайте сумму после изменения количества.';
          }),
      );
      root.querySelector('#preview-shop-refund').onclick = async () => {
        try {
          quotedItems = items();
          preview = await api('/sales/' + selected.id + '/refund-preview', 'POST', {
            items: quotedItems,
          });
          root.querySelector('#refund-summary').textContent = 'К возврату: ' + money(preview.total);
          form.querySelector('[type=submit]').disabled = false;
        } catch (e) {
          root.querySelector('#refund-summary').textContent = e.message;
        }
      };
      form.onsubmit = (e) => {
        e.preventDefault();
        const values = Object.fromEntries(new FormData(form));
        if (!preview) return;
        const body = {
          items: quotedItems,
          expectedTotal: preview.total,
          walletId: values.walletId,
          businessDate: values.businessDate,
          refundConfirmed: values.confirmed === 'on',
        };
        const key = 'refund-' + crypto.randomUUID();
        const storage = 'mbusiness-refund:' + selected.id;
        try {
          localStorage.setItem(storage, JSON.stringify({ body, key }));
        } catch {
          error = 'Не удалось сохранить команду возврата на устройстве.';
          draw();
          return;
        }
        run(async () => {
          try {
            await api('/sales/' + selected.id + '/returns', 'POST', body, key);
          } catch (e) {
            if (e.status >= 400 && e.status < 500 && e.code !== 'idempotency_conflict')
              localStorage.removeItem(storage);
            throw e;
          }
          localStorage.removeItem(storage);
          returns = (await api('/sales/' + selected.id + '/returns')).items;
          preview = null;
        });
      };
      const pending = localStorage.getItem('mbusiness-refund:' + selected.id);
      if (pending) {
        form.querySelectorAll('input,select,button').forEach((el) => (el.disabled = true));
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'primary';
        b.textContent = 'Проверить / повторить предыдущий возврат';
        b.onclick = () =>
          run(async () => {
            const p = JSON.parse(pending);
            try {
              await api('/sales/' + selected.id + '/returns', 'POST', p.body, p.key);
            } catch (e) {
              if (e.status >= 400 && e.status < 500 && e.code !== 'idempotency_conflict')
                localStorage.removeItem('mbusiness-refund:' + selected.id);
              throw e;
            }
            localStorage.removeItem('mbusiness-refund:' + selected.id);
            returns = (await api('/sales/' + selected.id + '/returns')).items;
            preview = null;
          });
        form.append(b);
      }
    }
    root.querySelectorAll('[data-fiscal-retry]').forEach(
      (b) =>
        (b.onclick = () =>
          run(async () => {
            await api('/fiscal/receipts/' + b.dataset.fiscalRetry + '/retry', 'POST', {});
            selected = await api('/sales/' + selected.id);
            returns = (await api('/sales/' + selected.id + '/returns')).items;
          })),
    );
  };
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
  run(async () => {
    sales = (await api('/sales')).items;
  });
  return () => {
    stopped = true;
  };
}
