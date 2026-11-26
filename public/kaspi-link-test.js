const element = id => document.getElementById(id);
const form = element('invoice');
const submit = form.querySelector('button[type="submit"]');
const status = element('status');
const retry = element('retry');
let attempt;
let invoiceId;

async function api(path, options) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error?.message || 'Запрос не выполнен.');
    error.status = response.status;
    throw error;
  }
  return body;
}

async function checkConnection() {
  const check = element('check');
  const connection = element('connection');
  check.disabled = true;
  form.hidden = true;
  try {
    const { company, user, mode, capabilities, billing } = await api('/account/overview');
    if (!user.is_owner) connection.textContent = 'Выставлять счёт может владелец кабинета компании.';
    else if (mode !== 'kaspi' || !capabilities.configured) connection.textContent = 'На этом сервере недоступно выставление реальных счетов через Kaspi.';
    else if (company.state !== 'connected') connection.textContent = 'Подключите кассира в кабинете MBusiness и проверьте подключение снова.';
    else if (!billing.active || billing.remaining_today < 1) connection.textContent = 'Нужен активный тариф 1Kaspi с доступным лимитом счетов.';
    else {
      connection.textContent = 'Кассир подключён · ' + company.name;
      form.hidden = false;
    }
  } catch (error) {
    connection.textContent = error.status === 401 ? 'Войдите в MBusiness и проверьте подключение снова.' : error.message;
  } finally {
    check.disabled = false;
  }
}

function showPayment(invoice) {
  const payment = new URL(invoice.payment_url);
  if (payment.protocol !== 'https:' || !['qr.kaspi.kz', 'pay.kaspi.kz'].includes(payment.host) || payment.username || payment.password) throw new Error('Сервер не вернул ссылку Kaspi.');
  element('payment-link').value = payment.href;
  element('open').href = payment.href;
  element('share').hidden = typeof navigator.share !== 'function';
  const checkout = new URL(invoice.checkout_url);
  const token = checkout.pathname.match(/^\/p\/([\w-]+)$/)?.[1];
  const qr = element('qr');
  qr.hidden = !invoice.qr_available || !token;
  if (!qr.hidden) qr.href = '/public/payments/' + token + '/qr';
  element('result').hidden = false;
  status.textContent = '';
}

async function waitForInvoice() {
  for (let check = 0; check < 15; check++) {
    const invoice = await api('/account/invoices/' + encodeURIComponent(invoiceId));
    if (invoice.payment_url) {
      showPayment(invoice);
      return;
    }
    if (!['queued', 'processing'].includes(invoice.status)) {
      status.textContent = 'Ссылка Kaspi недоступна для этого счёта. Откройте раздел «Счета» в MBusiness.';
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  status.textContent = 'Счёт ещё обрабатывается. Проверьте его статус чуть позже.';
  retry.hidden = false;
}

async function run(action) {
  submit.disabled = true;
  retry.hidden = true;
  element('result').hidden = true;
  status.textContent = 'Получаем ссылку Kaspi…';
  try {
    await action();
  } catch (error) {
    status.textContent = error.message;
    retry.hidden = !invoiceId;
  } finally {
    submit.disabled = false;
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  const amount = form.elements.amount.valueAsNumber;
  if (attempt && attempt.amount !== amount) {
    status.textContent = 'Сначала повторите запрос с исходной суммой ' + attempt.amount + ' ₸, чтобы уточнить статус предыдущего счёта.';
    return;
  }
  invoiceId = null;
  attempt ??= { amount, key: crypto.randomUUID() };
  run(async () => {
    const invoice = await api('/account/invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.key },
      body: JSON.stringify({ amount, currency: 'KZT', method: 'qr', order_id: 'kaspi-link-test-' + attempt.key })
    });
    attempt = null;
    invoiceId = invoice.id;
    await waitForInvoice();
  });
});

retry.onclick = () => run(waitForInvoice);
element('check').onclick = checkConnection;
element('copy').onclick = async () => {
  const input = element('payment-link');
  try {
    await navigator.clipboard.writeText(input.value);
    status.textContent = 'Ссылка скопирована.';
  } catch {
    input.select();
    status.textContent = 'Скопируйте выделенную ссылку.';
  }
};
element('share').onclick = async () => {
  try {
    await navigator.share({ url: element('payment-link').value });
  } catch (error) {
    if (error.name !== 'AbortError') status.textContent = 'Используйте кнопку «Скопировать».';
  }
};
checkConnection();
