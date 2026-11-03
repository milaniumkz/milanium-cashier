import { esc, date } from '/assets/retail-shared.js';
export function mountEquipment(root, api, header) {
  let stopped = false,
    timer,
    items = [],
    secret = null,
    error = '',
    busy = false;
  const connections = { usb: 'USB', bluetooth: 'Bluetooth', network: 'Локальная сеть' };
  const draw = () => {
    if (stopped) return;
    root.innerHTML =
      header(
        'Оборудование кассы',
        'Подключите сканер, камеру и банковский терминал к рабочему месту кассира.',
      ) +
      (error ? `<p class="notice red" role="alert">${esc(error)}</p>` : '') +
      `<div class="retail-feature-grid"><article class="card"><h2>Сканер штрихкодов</h2><p>USB или Bluetooth в режиме клавиатуры. Сканируйте код и Enter в кассе, карточке товара или ревизии. Отдельное разрешение браузера не требуется.</p></article><article class="card"><h2>Камера</h2><p>Кнопка «Камера» открывает запрос разрешения. На телефоне выбирается задняя камера. Если доступ запрещён, разрешите его в настройках сайта.</p></article><article class="card"><h2>Фискальная касса</h2><a class="text-button" href="/#retail-fiscal">Настроить фискализацию →</a><p>Подключите Webkassa или re:Kassa в разделе фискальной кассы. Зарегистрированные чеки будут связаны с продажами.</p></article></div><section class="panel retail-info"><h2>Банковские терминалы</h2><p>Выберите оборудование и установите агент на компьютер кассы. Для управления платежами нужен совместимый драйвер банка. USB, Bluetooth и сеть — варианты соединения; поддержку протокола подтверждает поставщик терминала.</p><div class="terminal-grid">${items.map((t) => `<article class="terminal-card"><span class="badge">${t.revoked ? 'Отключён' : t.online ? 'Агент на связи' : 'Агент не подключён'}</span><h3>${esc(t.name)}</h3><p>${t.kind === 'kaspi' ? 'Kaspi Smart POS' : 'Банковский терминал'} · ${esc(t.model)}<br>${connections[t.connection]}<br>${t.driver ? esc(t.driver) : 'Драйвер ещё не подключён'}<br>${t.lastSeen ? 'Последняя связь: ' + date(t.lastSeen) : 'Ожидает настройки'}</p>${!t.revoked ? `<button class="secondary" data-key="${t.id}">Получить новый ключ агента</button><button class="text-button danger" data-revoke-terminal="${t.id}">Отключить</button>` : ''}</article>`).join('') || '<p>Терминалы пока не добавлены.</p>'}</div></section>${secret ? `<section class="panel retail-info" id="terminal-secret"><h2>Настройка агента</h2><p>Сохраните файл настройки на компьютере кассы. Он содержит ключ доступа к одному терминалу и показывается только сейчас. Заполните команду драйвера банка и запустите агент по инструкции.</p><div class="actions"><button class="primary" id="download-terminal-config">Скачать настройки</button><a class="secondary" href="/downloads/terminal-agent.mjs" download>Скачать агент Node.js 24</a><a class="secondary" href="/help/terminals" target="_blank" rel="noopener">Инструкция подключения</a><button class="text-button" id="hide-terminal-secret">Настройки сохранены</button></div></section>` : ''}<section class="panel retail-info"><h2>Добавить терминал</h2><form id="terminal-form"><div class="form-row"><label>Название<input name="name" required maxlength="100" placeholder="Касса №1"></label><label>Тип<select name="kind"><option value="kaspi">Kaspi Smart POS</option><option value="bank">Другой банковский терминал</option></select></label></div><div class="form-row"><label>Модель<input name="model" required maxlength="100" placeholder="Модель на корпусе терминала"></label><label>Соединение<select name="connection"><option value="usb">USB</option><option value="bluetooth">Bluetooth</option><option value="network">Локальная сеть</option></select></label></div><button class="primary" ${busy ? 'disabled' : ''}>Добавить и настроить</button></form></section>`;
    root.querySelector('#terminal-form').onsubmit = (e) => {
      e.preventDefault();
      run(async () => {
        const data = Object.fromEntries(new FormData(e.target)),
          r = await api('/terminals', 'POST', data, crypto.randomUUID());
        if (r.token) secret = { ...r.terminal, token: r.token };
        await load();
      });
    };
    root.querySelectorAll('[data-key]').forEach(
      (b) =>
        (b.onclick = () =>
          run(async () => {
            const r = await api(
              '/terminals/' + b.dataset.key + '/key',
              'POST',
              {},
              crypto.randomUUID(),
            );
            if (r.token) secret = { ...r.terminal, token: r.token };
            else error = 'Ключ не получен. Повторите выпуск ключа.';
          })),
    );
    root.querySelectorAll('[data-revoke-terminal]').forEach(
      (b) =>
        (b.onclick = () => {
          if (confirm('Отключить агент этого терминала?'))
            run(async () => {
              await api(
                '/terminals/' + b.dataset.revokeTerminal + '/revoke',
                'POST',
                {},
                crypto.randomUUID(),
              );
              if (secret?.id === b.dataset.revokeTerminal) secret = null;
              await load();
            });
        }),
    );
    root.querySelector('#hide-terminal-secret')?.addEventListener('click', () => {
      secret = null;
      draw();
    });
    root.querySelector('#download-terminal-config')?.addEventListener('click', () => {
      const config = {
        server: location.origin,
        terminalId: secret.id,
        token: secret.token,
        database: 'terminal-agent.sqlite',
        device: { model: secret.model, connection: secret.connection, address: '' },
        adapter: { command: '', args: [] },
      };
      const url = URL.createObjectURL(
          new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }),
        ),
        a = document.createElement('a');
      a.href = url;
      a.download = 'mbusiness-terminal-' + secret.id + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  };
  const load = async () => {
    items = (await api('/terminals')).items;
  };
  const run = async (fn) => {
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
  };
  run(load);
  timer = setInterval(async () => {
    if (
      stopped ||
      busy ||
      root.querySelector('#terminal-form input') === document.activeElement ||
      secret
    )
      return;
    try {
      await load();
      const focused =
        root.contains(document.activeElement) && document.activeElement.tagName !== 'BODY';
      if (!focused) draw();
    } catch {}
  }, 10000);
  return () => {
    stopped = true;
    clearInterval(timer);
    secret = null;
  };
}
