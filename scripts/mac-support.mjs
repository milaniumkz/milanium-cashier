// No dependencies: diagnostics can run before Appium is installed.
const labels = new Set([
  'kaspi pay', 'kaspi qr', 'удалённая оплата', 'удаленная оплата', 'отправить счёт',
  'отправить счет', 'выставить счёт', 'выставить счет', 'счёт на оплату', 'счет на оплату',
  'номер телефона', 'телефон клиента', 'сумма', 'сумма оплаты', 'комментарий',
  'описание', 'номер заказа', 'оплатить', 'оплата', 'платежи', 'платёж', 'платеж',
  'история', 'история платежей', 'история оплат', 'продажи', 'детали', 'подробнее',
  'назад', 'далее', 'отмена', 'отменить', 'закрыть', 'готово', 'поиск', 'найти',
  'главная', 'счета', 'все', 'оплачен', 'оплачено', 'ожидает оплаты', 'не оплачен',
  'отклонён', 'отклонен', 'истёк', 'истек', 'отменён', 'отменен', 'qr', 'qr-код',
  'kzt', '₸', 'ссылка на оплату', 'поделиться', 'скопировать ссылку',
]);
function decode(value) {
  return value.replace(/&#(x[0-9a-f]+|\d+);|&(amp|quot|apos|lt|gt);/gi, (_, numeric, named) => {
    if (numeric) { const n = numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : Number(numeric); return n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
    return {amp:'&',quot:'"',apos:"'",lt:'<',gt:'>'}[named.toLowerCase()];
  });
}
export function parseDevices(output) {
  return output.split(/\r?\n/).map(s => s.trim()).filter(s => /^[a-zA-Z0-9_.:-]+\s+(device|unauthorized|offline)(\s|$)/.test(s)).map(s => {
    const [id, state] = s.split(/\s+/); return {id, state};
  });
}
export function focusedApp(output) {
  for (const line of output.split(/\r?\n/)) {
    if (!/mCurrentFocus|mFocusedApp|mResumedActivity|topResumedActivity/.test(line)) continue;
    const m = line.match(/\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\/([A-Za-z0-9_.$]+)/);
    if (m) return {app_package:m[1], app_activity:m[2]};
  }
  throw new Error('Не удалось определить открытое приложение. Разблокируйте Android и откройте Kaspi Pay.');
}
export function sanitizedNodes(xml, packageName) {
  if (!xml.includes('<hierarchy') || !xml.includes('</hierarchy>')) throw new Error('Android не вернул полную структуру экрана.');
  const nodes = [];
  for (const tag of xml.matchAll(/<node\s+[^>]*>/g)) {
    const attrs = Object.fromEntries([...tag[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], decode(m[2])]));
    if (attrs.package !== packageName) continue; // Exclude keyboard, notifications and system overlays.
    const node = {};
    const resource = attrs['resource-id'] || '';
    if (new RegExp('^' + packageName.replaceAll('.', '\\.') + ':id/[A-Za-z_][A-Za-z0-9_]*$').test(resource)) node.resource_id = resource;
    if (/^(android|androidx|com\.[A-Za-z0-9_.]+)\.[A-Za-z0-9_.$]+$/.test(attrs.class || '')) node.class = attrs.class;
    if (/^\[\d+,\d+\]\[\d+,\d+\]$/.test(attrs.bounds || '')) node.bounds = attrs.bounds;
    for (const k of ['clickable','enabled','focusable','scrollable','password']) if (['true','false'].includes(attrs[k])) node[k] = attrs[k] === 'true';
    for (const k of ['text','content-desc']) {
      const v = attrs[k] || '';
      node[k] = !v ? '' : attrs.password !== 'true' && labels.has(v.trim().toLowerCase()) ? v.trim() : '[скрыто]';
    }
    nodes.push(node);
  }
  if (!nodes.length) throw new Error('В структуре нет доступных элементов этого приложения. Нужна проверка экрана; автоматическая отправка не включена.');
  return nodes;
}
export function preferredAbi(arch, appleSilicon = false) {
  return arch === 'arm64' || appleSilicon ? 'arm64-v8a' : 'x86_64';
}
