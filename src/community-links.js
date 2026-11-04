import {AppError} from './db.js';

export function normalizeCommunityUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new AppError('COMMUNITY_URL_INVALID', 'Вставьте полную HTTPS-ссылку на группу VK или Одноклассников.', 400); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || /[%\\]/.test(url.pathname)) throw new AppError('COMMUNITY_URL_INVALID', 'Используйте HTTPS-ссылку без логина, пароля и порта.', 400);
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
  let path = url.pathname.replace(/\/$/, '');
  const network = ['vk.com', 'vk.ru'].includes(host) ? 'vk' : host === 'ok.ru' ? 'ok' : null;
  const post=network==='vk'?path.match(/^\/wall-([1-9]\d{0,39})_[1-9]\d*$/):network==='ok'?path.match(/^\/group\/([1-9]\d{0,39})\/topic\/[1-9]\d*$/):null;
  if(post)path=network==='vk'?'/club'+post[1]:'/group/'+post[1];
  const slug = path.slice(1);
  const reserved = /^(?:id\d+|profile|feed|im|messenger|messages|settings|login|join|away|friends|video|music|search|apps|dev|oauth|al_[a-z_]+)(?:\/|$)/i;
  const valid = network === 'vk' ? /^\/[a-zA-Z0-9_.]{2,100}$/.test(path) && !reserved.test(slug) : network === 'ok' && (/^\/group\/[1-9]\d{0,39}$/.test(path) || (/^\/[a-zA-Z0-9_.]{2,100}$/.test(path) && !reserved.test(slug)));
  if (!valid) throw new AppError('COMMUNITY_URL_INVALID', 'Нужна ссылка на страницу группы: https://vk.com/имя или https://ok.ru/group/номер.', 400);
  return { network, url: `https://${network === 'vk' ? 'vk.com' : 'ok.ru'}${network==='vk'?path.replace(/^\/(?:public|event)(\d+)$/,'/club$1'):path}` };
}
