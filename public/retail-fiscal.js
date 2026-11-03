import { esc, money, errorText } from '/assets/retail-shared.js';
const labels = {
  QUEUED: 'Ожидает отправки',
  SENDING: 'Фискализация',
  ISSUED: 'Чек выдан',
  FAILED: 'Нужна настройка',
  UNKNOWN: 'Нужна сверка',
};
export function fiscalReceiptMarkup(f) {
  if (!f) return '<p class="retail-hint">Внутренний документ. Фискальная касса не подключена.</p>';
  const r = f.receipt;
  return `<div class="terminal-status"><b>${f.mode === 'test' ? 'ТЕСТОВАЯ КАССА · ' : ''}${f.provider === 'webkassa' ? 'Webkassa' : 're:Kassa'} · ${labels[f.state] || 'Проверяем чек'}</b>${r ? `<p>Номер чека: ${esc(r.number)} · Смена: ${esc(r.shift ?? '—')}<br>Касса: ${esc(r.cashboxId)} · Сумма: ${money(r.total)}</p>${r.url ? `<a class="secondary" href="${esc(r.url)}" target="_blank" rel="noopener">Открыть фискальный чек</a>` : ''}` : '<p>Продажа сохранена. Пока провайдер не подтвердил чек, этот документ не является фискальным. Не оформляйте повторную продажу для получения чека.</p>'}${f.errorCode ? `<p class="error">${esc(errorText(f.errorCode))}${f.providerCode ? ' · Код провайдера ' + esc(f.providerCode) : ''}</p>` : ''}${['FAILED', 'UNKNOWN'].includes(f.state) ? `<button class="secondary" data-fiscal-retry="${f.id}">${f.state === 'UNKNOWN' ? 'Проверить прежний чек' : 'Повторить фискализацию'}</button>` : ''}</div>`;
}
export function mountFiscal(root, api, header) {
  let stopped = false,
    config,
    items = [],
    error = '',
    busy = false,
    provider = 'webkassa',
    timer;
  const draw = () => {
    if (stopped) return;
    root.innerHTML =
      header(
        'Фискальная касса',
        'Подключите кассу компании и получайте фискальные чеки при продаже.',
      ) +
      (error ? `<div class="notice red" role="alert">${esc(error)}</div>` : '') +
      `<section class="panel retail-info"><h2>Провайдер фискализации</h2><div class="payment-blocks fiscal-provider-blocks">${[
        ['webkassa', 'W', 'Webkassa'],
        ['rekassa', 're:', 're:Kassa'],
      ]
        .map(
          ([id, icon, name]) =>
            `<button class="payment-block ${provider === id ? 'selected' : ''}" data-fiscal-provider="${id}" aria-pressed="${provider === id}"><b>${icon}</b><span>${name}</span><small>Онлайн-ККМ Казахстана</small></button>`,
        )
        .join(
          '',
        )}</div><p>${config?.provider ? `Текущее подключение: <b>${config.provider === 'webkassa' ? 'Webkassa' : 're:Kassa'}</b> · ${config.mode === 'live' ? 'Рабочая касса' : 'Тестовый стенд'} · ${config.verified ? 'Доступ проверен' : 'Доступ не проверен'} · ${config.enabled ? 'Включено' : 'Не включено'}` : 'Касса ещё не подключена.'}</p>${config?.blocked ? '<div class="notice amber">Есть чеки, требующие исправления или сверки. Новые продажи с этой кассой приостановлены до их разрешения.</div>' : ''}<p class="retail-hint">Рабочая касса должна быть зарегистрирована у провайдера и ОФД. API-ключи и пароль передаются серверу и хранятся зашифрованными. Сохранённый пароль не показывается обратно.</p>${provider === 'rekassa' ? '<div class="notice">Для re:Kassa нужен ключ партнёрской интеграции и пароль стороннего приложения. Поддержка НДС требует сверки актуального партнёрского контракта; для компаний с НДС сейчас используйте Webkassa.</div>' : ''}<form id="fiscal-config-form"><div class="form-row"><label>Среда<select name="mode"><option value="test" ${config?.mode === 'test' ? 'selected' : ''}>Тестовый стенд — не рабочие чеки</option><option value="live" ${config?.mode === 'live' ? 'selected' : ''}>Рабочая касса</option></select></label><label>${provider === 'webkassa' ? 'Заводской номер кассы (SWK…)' : 'ID кассы re:Kassa (crs ID)'}<input name="cashboxId" required maxlength="100" value="${esc(config?.provider === provider ? config.cashboxId : '')}"></label></div><label>${provider === 'webkassa' ? 'Логин кассира Webkassa' : 'Номер кассы для входа re:Kassa'}<input name="login" required maxlength="150" autocomplete="off"></label><label>${provider === 'webkassa' ? 'Пароль кассира' : 'Пароль стороннего приложения'}<input name="password" type="password" required maxlength="300" autocomplete="new-password"></label><label>API-ключ интегратора<input name="apiKey" type="password" required maxlength="300" autocomplete="off"></label><button class="primary" ${busy ? 'disabled' : ''}>Сохранить подключение</button></form><div class="actions"><button class="secondary" id="verify-fiscal" ${!config?.provider || busy ? 'disabled' : ''}>Проверить доступ к кассе</button><button class="primary" id="enable-fiscal" ${!config?.verified || busy ? 'disabled' : ''}>${config?.enabled ? 'Отключить новые чеки' : 'Включить фискализацию'}</button><a class="text-button" href="/help/fiscal" target="_blank" rel="noopener">Инструкция по подключению →</a></div></section><section class="panel retail-info"><h2>Фискальные чеки продаж</h2><button class="secondary" id="refresh-fiscal-receipts">Обновить</button>${items.map((f) => fiscalReceiptMarkup(f)).join('') || '<p>Чеков пока нет. После подключения они будут появляться здесь автоматически.</p>'}</section>`;
    root.querySelectorAll('[data-fiscal-provider]').forEach(
      (b) =>
        (b.onclick = () => {
          provider = b.dataset.fiscalProvider;
          draw();
        }),
    );
    root.querySelector('#fiscal-config-form').onsubmit = (e) => {
      e.preventDefault();
      const body = {
        ...Object.fromEntries(new FormData(e.target)),
        provider,
        version: config?.version || 0,
      };
      run(async () => {
        config = await api('/fiscal/config', 'PUT', body, crypto.randomUUID());
      });
    };
    root.querySelector('#verify-fiscal').onclick = () =>
      run(async () => {
        config = await api('/fiscal/verify', 'POST', {});
      });
    root.querySelector('#enable-fiscal').onclick = () =>
      run(async () => {
        config = await api(
          '/fiscal/enable',
          'POST',
          { enabled: !config.enabled },
          crypto.randomUUID(),
        );
      });
    root.querySelector('#refresh-fiscal-receipts').onclick = () => run(load);
    root.querySelectorAll('[data-fiscal-retry]').forEach(
      (b) =>
        (b.onclick = () =>
          run(async () => {
            await api('/fiscal/receipts/' + b.dataset.fiscalRetry + '/retry', 'POST', {});
            await load();
          })),
    );
  };
  async function load() {
    config = await api('/fiscal/config');
    items = (await api('/fiscal/receipts')).items;
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
  run(async () => {
    await load();
    provider = config?.provider || provider;
  });
  timer = setInterval(async () => {
    if (
      stopped ||
      busy ||
      (root.contains(document.activeElement) &&
        ['INPUT', 'SELECT'].includes(document.activeElement.tagName))
    )
      return;
    try {
      await load();
      draw();
    } catch {}
  }, 10000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
