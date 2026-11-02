const $ = s => document.querySelector(s);
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const labels = { queued:'В очереди', processing:'Создаётся', pending:'Ожидает оплаты', paid:'Оплачен', declined:'Отклонён', expired:'Истёк', unknown:'Нужна сверка', requires_auth:'Нужен вход', failed:'Ошибка', connected:'Подключено', disconnected:'Не подключено', sandbox:'Тестовая касса', device_ready:'Android готов', maintenance:'Ручной режим' };
const money = x => new Intl.NumberFormat('ru-RU').format(x || 0) + ' ₸';
const date = x => new Date(x).toLocaleString('ru-RU', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
let data, timer, loading = false, toastTimer, currentView = 'payments', selectedInvoice;
async function request(url, options = {}) {
  const r = await fetch(url, { credentials:'same-origin', ...options, headers:{ 'Content-Type':'application/json', ...options.headers } });
  const json = await r.json();
  if (!r.ok) { const e = new Error(json.error?.message || 'Не удалось выполнить запрос.'); e.status = r.status; e.fields = json.error?.fields; throw e; }
  return json;
}
const post = (url, body = {}, headers) => request(url, { method:'POST', body:JSON.stringify(body), headers });
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(()=>$('#toast').hidden=true,5000); }
const badge = status => el('span', labels[status] || status, `badge ${status}`);
const company = id => data.merchants.find(m=>m.id === id)?.name || id;
function empty(title, text, action, handler) { const e = el('div', undefined, 'empty'); e.append(el('div','↗','empty-symbol'),el('h3',title),el('p',text)); if(action){const b=el('button',action,'primary');b.onclick=handler;e.append(b);} return e; }
function table(headers, rows) { const wrap=el('div',undefined,'table-wrap'), t=el('table'), head=el('thead'), hr=el('tr'), body=el('tbody'); headers.forEach(h=>hr.append(el('th',h)));head.append(hr); rows.forEach(r=>body.append(r));t.append(head,body);wrap.append(t);return wrap; }
function renderPayments() {
  const status = $('#status-filter').value, search = $('#search').value.toLocaleLowerCase();
  const list = data.invoices.filter(i=>(!status||i.status===status) && `${i.order_id} ${company(i.merchant_id)}`.toLocaleLowerCase().includes(search));
  const target=$('#invoices-list');target.replaceChildren();
  if(!list.length){ target.append(data.merchants.length ? empty('Платежей пока нет','Создайте счёт или отправьте первый запрос через API.','Выставить счёт',openInvoice) : empty('Добавьте первую компанию','У каждой компании будут свои ключи, платежи и сессия кассира.','Добавить компанию',()=>$('#merchant-dialog').showModal())); return; }
  target.append(table(['Заказ / компания','Сумма','Способ','Статус','Создан'], list.map(i=>{
    const r=el('tr');r.tabIndex=0;r.setAttribute('aria-label',`Открыть заказ ${i.order_id}`);r.onclick=()=>showInvoice(i.id);r.onkeydown=e=>{if(e.key==='Enter')showInvoice(i.id);};
    const c=el('td',`№ ${i.order_id}`);c.append(el('small',company(i.merchant_id)));
    const s=el('td');s.append(badge(i.status));r.append(c,el('td',money(i.amount),'amount'),el('td',i.method==='phone'?'По телефону':'QR / ссылка'),s,el('td',date(i.created_at)));return r;
  })));
}
function renderCompanies() {
  const target=$('#merchant-list');target.replaceChildren();
  if(!data.merchants.length){target.append(empty('Нет подключённых компаний','Создайте компанию, чтобы получить ключ для её приложения.','Добавить компанию',()=>$('#merchant-dialog').showModal()));return;}
  for(const m of data.merchants){
    const card=el('article',undefined,'company-card'), top=el('div',undefined,'card-top');top.append(el('h3',m.name),badge(m.state));
    card.append(top,el('p',data.mode==='kaspi' ? 'Серверное подключение Kaspi' : m.device_udid ? `Android: ${m.device_udid}` : 'Android не привязан','muted'),el('p','Идентификатор компании','muted'),el('code',m.id),el('p',`Кабинет кассира: ${m.account_label}`),el('p',m.api_ip?`IP сервера API: ${m.api_ip}`:'API заблокирован: IP сервера не указан','muted'),el('p',m.webhook_url?`Webhook: ${m.webhook_url}`:'Webhook не настроен','muted'));
    const actions=el('div',undefined,'actions');
    const connect=el('button','Подключение','secondary');connect.onclick=()=>{
      if(data.mode==='kaspi'){openKaspi(m);return;}
      const content=el('div');content.append(el('p',data.mode==='sandbox'?'Тестовая касса уже готова. Счета не отправляются в Kaspi.':'Запустите команду на доверенном компьютере с доступом к данным сервиса. Войдите в установленное приложение на выделенном Android, затем подтвердите подключение в терминале.'));
      if(data.mode!=='sandbox')content.append(el('pre',`npm run connect -- ${m.id}`));
      info('Сессия кассира',content);
    };
    const rotate=el('button','Заменить API-ключ','secondary');rotate.onclick=async()=>{if(!confirm('Старый API-ключ перестанет работать. Создать новый?'))return;try{const r=await post(`/admin/merchants/${m.id}/key`);showSecrets(r);}catch(e){toast(e.message);}};
    const webhook=el('button','Webhook','secondary');webhook.onclick=async()=>{const url=prompt('HTTPS-адрес для уведомлений. Оставьте пустым для отключения.',m.webhook_url);if(url===null)return;try{await request(`/admin/merchants/${m.id}/webhook`,{method:'PATCH',body:JSON.stringify({webhook_url:url.trim()})});await refresh();toast('Адрес уведомлений сохранён');}catch(e){toast(e.message);}};
    const server=el('button','IP сервера API','secondary');server.onclick=async()=>{const ip=prompt('Один публичный исходящий IP backend-сервера компании (выдаст новый API-ключ):',m.api_ip||'');if(!ip)return;if(!confirm('Предыдущий API-ключ перестанет работать. Продолжить?'))return;try{showSecrets(await post(`/admin/merchants/${m.id}/api-server`,{ip:ip.trim()}));await refresh();}catch(e){toast(e.message);}};actions.append(connect,server,rotate,webhook);if(data.mode==='android'&&m.device_udid){const view=el('button','Открыть Android','primary');view.onclick=()=>openAndroid(m.id);actions.prepend(view);}
    if(data.mode!=='sandbox'&&m.state!=='disconnected'){const b=el('button','Приостановить','secondary');b.onclick=async()=>{if(!confirm(data.mode==='kaspi'?'Отключить серверную сессию Kaspi? Для подключения потребуется новый вход.':'Приостановить робота? Аккаунт в приложении Android останется авторизованным.'))return;try{await post(`/admin/merchants/${m.id}/disconnect`);await refresh();}catch(e){toast(e.message);}};actions.append(b);}
    card.append(actions);target.append(card);
  }
}
function renderEvents(){
  const t=$('#events-list');t.replaceChildren();
  if(!data.events.length){t.append(empty('Событий пока нет','Они появятся при изменении статуса платежей.'));return;}
  t.append(table(['Событие','Компания','Попытки','Доставка'],data.events.map(e=>{const r=el('tr'),c=el('td',e.id.slice(0,8)),s=el('td',e.delivered_at?'Доставлено':e.dead?'Приостановлена':data.merchants.find(m=>m.id===e.merchant_id)?.webhook_url?'В очереди':'Webhook не настроен');c.append(el('small',e.invoice_id.slice(0,8)));if(e.dead){const b=el('button','Повторить','secondary');b.onclick=async()=>{try{await post(`/admin/events/${e.id}/retry`);refresh();}catch(err){toast(err.message);}};s.append(b);}r.append(c,el('td',company(e.merchant_id)),el('td',String(e.attempts)),s);return r;})));
}
async function refresh(){
  if(loading)return;loading=true;
  try {
    data=await request('/admin/overview');$('#login').hidden=true;$('#workspace').hidden=false;
    const sandbox=data.mode==='sandbox';$('#mode-banner').textContent=sandbox?'ТЕСТОВЫЙ РЕЖИМ · Счета, QR и подтверждения имитируются. Деньги не списываются.':data.capabilities.configured?(data.mode==='kaspi'?'Kaspi · Серверное подключение. Реальные операции включены.':'Android-кассир · Перед отправкой проверяется компания и сумма операции.'):`Подключение Kaspi не настроено. Отправка реальных счетов отключена (${data.capabilities.reason}).`;
    $('#mode-banner').classList.toggle('live',!sandbox);$('#sidebar-mode').textContent=sandbox?'SANDBOX / ТЕСТОВАЯ КАССА':data.mode==='kaspi'?'KASPI / СЕРВЕР':'ANDROID-КАССИР';
    const stat=s=>data.stats.find(x=>x.status===s)?.count||0;
    $('#stat-paid').textContent=money(data.stats.find(x=>x.status==='paid')?.amount);$('#stat-count').textContent=`${stat('paid')} платежей`;
    $('#stat-pending').textContent=stat('pending');$('#stat-review').textContent=stat('unknown')+stat('requires_auth')+stat('failed');$('#stat-merchants').textContent=data.merchants.length;
    renderPayments();if(currentView==='companies')renderCompanies();if(currentView==='events')renderEvents();
    if(!timer)timer=setInterval(refresh,4000);
  }catch(e){if(e.status===401){$('#login').hidden=false;$('#workspace').hidden=true;clearInterval(timer);timer=null;}else toast(e.message);}
  finally{loading=false;}
}
function switchView(view){currentView=view;document.querySelectorAll('.view').forEach(e=>e.hidden=e.id!==`view-${view}`);document.querySelectorAll('[data-view]').forEach(e=>e.classList.toggle('active',e.dataset.view===view));$('#breadcrumb').textContent=`Рабочее пространство / ${ {payments:'Платежи',companies:'Компании',events:'Уведомления',api:'Интеграция',billing:'Баланс и заявки'}[view] }`;if(view==='companies')renderCompanies();if(view==='events')renderEvents();if(view==='billing')renderBilling();}
function info(title,content){$('#info-title').textContent=title;$('#info-content').replaceChildren(content);$('#info-dialog').showModal();}
function showSecrets(r){const c=el('div');c.append(el('p','Сохраните ключи сейчас. Повторно посмотреть их в кабинете нельзя.'));for(const [label,value] of [['API-ключ',r.api_key],['Секрет webhook',r.webhook_secret]])if(value){c.append(el('h3',label),el('pre',value));const b=el('button','Копировать','secondary');b.onclick=()=>navigator.clipboard.writeText(value).then(()=>toast('Скопировано')).catch(()=>toast('Выделите и скопируйте ключ вручную.'));c.append(b);}info('Ключи подключения',c);}
function openInvoice(){if(!data.merchants.length){$('#merchant-dialog').showModal();return;}const f=$('#invoice-form');f.reset();f.querySelector('.form-error').textContent='';$('#invoice-merchant').replaceChildren(...data.merchants.map(m=>{const o=el('option',m.name);o.value=m.id;return o;}));f.elements.order_id.value=`order-${Date.now()}`;f.dataset.idem=crypto.randomUUID();$('#phone-label').hidden=false;f.elements.customer_phone.required=true;$('#invoice-mode-note').textContent=data.mode==='sandbox'?'Будет создан тестовый счёт. Уведомление в Kaspi не отправляется.':data.mode==='kaspi'?'Будет отправлен реальный запрос в Kaspi через сервер.':'Будет отправлен реальный запрос через приложение кассира на выделенном Android.';$('#invoice-dialog').showModal();}
async function showInvoice(id){
  selectedInvoice=id;const i=data.invoices.find(v=>v.id===id);if(!i)return;
  $('#detail-title').textContent=`Заказ № ${i.order_id}`;const c=$('#detail-content');c.replaceChildren(badge(i.status));
  const dl=el('dl',undefined,'kv');for(const [k,v] of [['Компания',company(i.merchant_id)],['Сумма',money(i.amount)],['Идентификатор',i.id],['Счёт в кассе',i.provider_id||'Ещё не получен'],['Создан',date(i.created_at)],['Код ошибки',i.error_code||'—']])dl.append(el('dt',k),el('dd',v));c.append(dl);
  const a=el('a','Открыть страницу оплаты','primary');a.href=i.checkout_url;a.target='_blank';a.rel='noopener noreferrer';const actions=el('div',undefined,'detail-actions');actions.append(a);
  if(['failed','requires_auth'].includes(i.status)){const b=el('button','Повторить до отправки','secondary');b.onclick=async()=>{try{await post(`/admin/invoices/${id}/retry`);$('#detail-dialog').close();toast('Возвращено в очередь');await refresh();}catch(e){toast(e.message);}};actions.append(b);}
  if(['unknown','pending'].includes(i.status)){const b=el('button','Запросить сверку','secondary');b.onclick=async()=>{const pid=i.provider_id||prompt('Введите идентификатор существующего счёта из истории кассира. Новый счёт не будет создан.');if(!pid)return;try{await post(`/admin/invoices/${id}/reconcile`,{provider_id:pid});toast('Запрошена проверка существующего счёта');}catch(e){toast(e.message);}};actions.append(b);}
  c.append(actions);const title=el('h3','История операции');title.style.marginTop='28px';c.append(title);
  try{const items=await request(`/admin/invoices/${id}/audit`);if(selectedInvoice!==id)return;const ul=el('ul',undefined,'timeline');for(const item of items)ul.append(el('li',`${date(item.created_at)} · ${item.detail||item.action}`));c.append(ul);}catch(e){toast(e.message);}
  if(!$('#detail-dialog').open)$('#detail-dialog').showModal();
}
$('#login-form').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;$('#login-error').textContent='';try{await post('/admin/login',{password:e.target.password.value});e.target.reset();await refresh();}catch(err){$('#login-error').textContent=err.message;}finally{b.disabled=false;}};
$('#logout').onclick=async()=>{await post('/admin/logout');clearInterval(timer);timer=null;data=null;$('#workspace').hidden=true;$('#login').hidden=false;};
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>switchView(b.dataset.view));
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('#new-merchant').onclick=()=>$('#merchant-dialog').showModal();$('#new-invoice').onclick=openInvoice;
$('#status-filter').onchange=renderPayments;$('#search').oninput=renderPayments;
$('#merchant-form').onsubmit=async e=>{e.preventDefault();const f=e.target,b=f.querySelector('[type=submit]');b.disabled=true;f.querySelector('.form-error').textContent='';try{const r=await post('/admin/merchants',Object.fromEntries(new FormData(f)));$('#merchant-dialog').close();f.reset();await refresh();showSecrets(r);}catch(err){f.querySelector('.form-error').textContent=err.message;}finally{b.disabled=false;}};
$('#invoice-form').onchange=e=>{if(e.target.name==='method'){const phone=e.target.value==='phone';$('#phone-label').hidden=!phone;$('#invoice-form').elements.customer_phone.required=phone;}};
$('#invoice-form').onsubmit=async e=>{e.preventDefault();const f=e.target,b=f.querySelector('[type=submit]');b.disabled=true;f.querySelector('.form-error').textContent='';try{const body=Object.fromEntries(new FormData(f));body.amount=Number(body.amount);if(body.method==='qr')delete body.customer_phone;const r=await post('/admin/invoices',body,{'Idempotency-Key':f.dataset.idem});$('#invoice-dialog').close();await refresh();toast('Платёж поставлен в очередь');await showInvoice(r.id);}catch(err){f.querySelector('.form-error').textContent=err.message+(err.fields?` ${err.fields.map(v=>v.message).join(' ')}`:'');}finally{b.disabled=false;}};
refresh();

let androidId=null,androidTimer=null,androidBusy=false,androidObjectUrl=null,androidQueue=Promise.resolve();
function androidSerial(fn){const task=androidQueue.then(fn);androidQueue=task.catch(()=>{});return task;}
async function androidScreen(){
  if(androidBusy||!$('#android-dialog').open)return;
  androidBusy=true;const target=androidId;
  try{await androidSerial(async()=>{
    if(!$('#android-dialog').open||target!==androidId)return;
    const r=await fetch(`/admin/android/${target}/screen`);
    if(!r.ok){const j=await r.json();if(r.status===409&&j.error?.code==='BUSY')return;throw new Error(j.error?.message||'Экран недоступен');}
    const blob=await r.blob();if(!$('#android-dialog').open||target!==androidId)return;
    if(androidObjectUrl)URL.revokeObjectURL(androidObjectUrl);
    androidObjectUrl=URL.createObjectURL(blob);$('#android-screen').src=androidObjectUrl;
    $('#android-screen').hidden=false;$('#android-loading').hidden=true;$('#android-error').textContent='';
  });}catch(e){$('#android-error').textContent=e.message;}finally{androidBusy=false;}
}
async function openAndroid(id){
  if(!confirm('Приостановить робота и перейти к ручному управлению этим Android? Активный QR будет скрыт до сверки.'))return;
  try{await post(`/admin/android/${id}/manual`);androidId=id;$('#android-screen').hidden=true;$('#android-loading').hidden=false;$('#android-dialog').showModal();await androidScreen();if($('#android-dialog').open)androidTimer=setInterval(androidScreen,2000);await refresh();}catch(e){toast(e.message);}
}
async function androidInput(body){
  const target=androidId;
  try{await androidSerial(async()=>{if($('#android-dialog').open&&target===androidId)await post(`/admin/android/${target}/input`,body);});await androidScreen();}catch(e){$('#android-error').textContent=e.message;}
}
$('#android-screen').onclick=e=>{const img=e.currentTarget,r=img.getBoundingClientRect();androidInput({action:'tap',x:Math.round((e.clientX-r.left)*img.naturalWidth/r.width),y:Math.round((e.clientY-r.top)*img.naturalHeight/r.height)});};
$('#android-text-form').onsubmit=e=>{e.preventDefault();const input=$('#android-text'),text=input.value;input.value='';if(text)androidInput({action:'text',text});};
$('#android-back').onclick=()=>androidInput({action:'back'});$('#android-refresh').onclick=androidScreen;
$('#android-resume').onclick=async()=>{try{await androidSerial(()=>post(`/admin/android/${androidId}/resume`));$('#android-dialog').close();await refresh();toast('Кассир проверен. Робот запущен.');}catch(e){$('#android-error').textContent=e.message;}};
$('#android-dialog').addEventListener('close',()=>{clearInterval(androidTimer);$('#android-text').value='';$('#android-screen').removeAttribute('src');if(androidObjectUrl)URL.revokeObjectURL(androidObjectUrl);androidObjectUrl=null;});

function openKaspi(merchant){
  const content=el('div'),note=el('p','Укажите телефон кассира. Название кабинета должно точно совпадать с компанией в Kaspi. Код SMS вводится здесь и не сохраняется в браузере.');
  const form=el('form'),input=el('input'),button=el('button','Получить SMS','primary'),error=el('p','','form-error');
  input.type='tel';input.placeholder='+77001234567';input.required=true;input.autocomplete='off';button.type='submit';
  form.append(input,button,error);content.append(note,form);let step='start';
  form.onsubmit=async e=>{e.preventDefault();button.disabled=true;error.textContent='';const value=input.value;input.value='';
    try{await post(`/admin/kaspi/${merchant.id}/${step}`,step==='start'?{phone:value}:{otp:value});
      if(step==='start'){step='verify';input.type='password';input.inputMode='numeric';input.placeholder='Код SMS';button.textContent='Подключить';note.textContent='Введите код SMS. Сессия будет храниться только на сервере.';input.focus();}
      else{$('#info-dialog').close();await refresh();toast('Кассир подключён');}
    }catch(e){error.textContent=e.message;}finally{button.disabled=false;}
  };
  info('Подключение Kaspi',content);$('#info-dialog').addEventListener('close',()=>{input.value='';},{once:true});
}

async function renderBilling(){
 await renderServiceCashier();
 try{const result=await request('/admin/topups');const target=$('#billing-list');target.replaceChildren();
 if(!result.data.length)target.append(empty('Заявок пока нет','Заявки компаний на пополнение появятся здесь.'));
 else target.append(table(['Компания / заявка','Сумма','Дата','Статус','Действия'],result.data.map(t=>{
 const row=el('tr'),company=el('td',t.name),actions=el('td');company.append(el('small',t.id));
 if(t.status==='pending')for(const [decision,label] of [['approved','Подтвердить перевод'],['rejected','Отклонить']]){const b=el('button',label,'secondary');b.onclick=async()=>{
 let bank_reference;if(decision==='approved'){bank_reference=prompt('После проверки оплаты в банке укажите уникальный идентификатор перевода:');if(!bank_reference)return;}
 if(!confirm(decision==='approved'?`Зачислить ${t.amount} ₸ компании ${t.name}?`:'Отклонить заявку?'))return;
 b.disabled=true;try{await post(`/admin/topups/${t.id}/review`,{decision,...(bank_reference?{bank_reference}: {})});await renderBilling();}catch(e){toast(e.message);}finally{b.disabled=false;}};actions.append(b);}
 row.append(company,el('td',money(t.amount)),el('td',date(t.created_at)),el('td',({pending:'Ожидает проверки',approved:'Зачислено',rejected:'Отклонено'})[t.status]),actions);return row;
 })));
 const contracts=$('#contract-list');contracts.replaceChildren();
 for(const item of result.individual){const card=el('article',undefined,'company-card');card.append(el('h3',item.name),el('pre',item.detail));const b=el('button','Предложить тариф','primary');b.onclick=async()=>{
 const daily_limit=Number(prompt('Дневной лимит (больше 700):','1000'));if(!Number.isInteger(daily_limit)||daily_limit<701)return;
 const price=Number(prompt('Стоимость за календарный месяц, ₸:'));if(!Number.isInteger(price)||price<1)return;
 try{await post(`/admin/merchants/${item.merchant_id}/contract`,{daily_limit,price});toast('Предложение доступно компании в разделе тарифов.');}catch(e){toast(e.message);}
 };card.append(b);contracts.append(card);}
 }catch(e){toast(e.message);}
}
$('#refresh-billing').onclick=renderBilling;

async function renderServiceCashier(){
 const target=$('#service-cashier-panel');if(!target)return;
 try{const s=await request('/admin/billing/cashier');target.replaceChildren();const title=el('h2','Кассир MBusiness для оплаты тарифов');const note=el('p','Этот кассир принимает оплату за тарифы сервиса. Кассиры клиентских компаний подключаются отдельно.','muted');
 const form=el('form');form.id='service-cashier-form';const label=el('label','Точное название организации в Kaspi'),input=el('input');input.name='account_label';input.required=true;input.minLength=2;input.value=s.merchant?.account_label||'';label.append(input);
 const enableLabel=el('label','Разрешить оплату тарифов после проверки кассира'),enabled=el('input');enabled.type='checkbox';enabled.name='enabled';enabled.checked=s.enabled;enableLabel.prepend(enabled);
 const save=el('button','Сохранить настройки','primary');save.type='submit';const error=el('p','','error');form.append(label,enableLabel,save,error);form.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{await post('/admin/billing/cashier',{account_label:input.value,enabled:enabled.checked});await renderServiceCashier();}catch(err){error.textContent=err.message;}finally{save.disabled=false;}};
 target.append(title,note,form,el('p',s.connected?'Кассир подключён':s.configured?'Нужен вход кассира':'Кассир не настроен'));
 if(s.configured&&s.mode==='kaspi'){const connect=el('button','Войти по SMS','secondary');connect.onclick=()=>{const c=el('div'),f=el('form'),field=el('input'),submit=el('button','Получить SMS','primary'),err=el('p','','error');field.type='tel';field.placeholder='+77001234567';field.required=true;submit.type='submit';f.append(field,submit,err);c.append(el('p','Введите телефон кассира сервиса. SMS-код вводится в этой форме и не сохраняется в браузере.'),f);let stage='start';f.onsubmit=async e=>{e.preventDefault();const value=field.value;field.value='';submit.disabled=true;try{await post('/admin/billing/cashier/'+stage,stage==='start'?{phone:value}:{otp:value});if(stage==='start'){stage='verify';field.type='password';field.inputMode='numeric';field.placeholder='Код SMS';submit.textContent='Подключить кассира';}else{$('#info-dialog').close();await renderServiceCashier();}}catch(e){err.textContent=e.message;}finally{submit.disabled=false;}};info('Кассир MBusiness',c);};target.append(connect);if(s.connected){const disconnect=el('button','Отключить кассира сервиса','secondary danger');disconnect.onclick=async()=>{if(!confirm('Отключить кассира и приостановить новые оплаты тарифов?'))return;try{await post('/admin/billing/cashier/disconnect');await renderServiceCashier();}catch(e){alert(e.message);}};target.append(disconnect);}}
 const payments=await request('/admin/billing/payments');if(payments.data.length)target.append(table(['Компания','Тариф','Сумма','Статус'],payments.data.map(p=>{const row=el('tr');row.append(el('td',p.company_name),el('td',p.plan_name),el('td',money(p.amount)),el('td',p.activated_at?'Активирован':labels[p.status]||p.status));return row;})));
 }catch(e){target.replaceChildren(el('p',e.message,'error'));}
}
