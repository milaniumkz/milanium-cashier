import { AppError } from './db.js';

export class MetaProvider {
  constructor({ fetchImpl = fetch } = {}) { this.fetch = fetchImpl; }
  async request(channel, version, path, accessToken, { method = 'GET', body } = {}) {
    const host = channel === 'instagram' ? 'https://graph.instagram.com' : 'https://graph.facebook.com';
    const url = new URL(`${host}/${version}/${path}`);
    let response;
    try {
      response = await this.fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new AppError('META_RESULT_UNKNOWN', 'Связь с Meta прервана. Результат операции требует сверки.', 502); }
    let data;
    try { data = await response.json(); } catch { throw new AppError('META_RESULT_UNKNOWN', 'Meta вернула нечитаемый результат. Требуется сверка.', 502); }
    if (!response.ok || data.error) {
      const err = new AppError(data.error?.code === 190 ? 'META_TOKEN_EXPIRED' : 'META_REJECTED', 'Meta отклонила запрос. Проверьте токен, разрешения и состояние аккаунта в Meta.', 409);
      err.providerCode = String(data.error?.code || response.status).slice(0, 30);
      throw err;
    }
    return data;
  }
  async verify(channel, credentials, platform) {
    const { access_token: token, external_id: id, waba_id } = credentials;
    if (channel === 'whatsapp') {
      const data = await this.request(channel, platform.version, `${id}?fields=id,display_phone_number,verified_name`, token);
      if (String(data.id) !== id) throw new AppError('META_ID_MISMATCH', 'Meta вернула другой номер.', 409);
      // Validate membership in the declared WABA, not merely possession of some readable phone ID.
      const phones = await this.request(channel, platform.version, `${waba_id}/phone_numbers?fields=id&limit=100`, token);
      if (!phones.data?.some(p => String(p.id) === id)) throw new AppError('META_WABA_MISMATCH', 'Номер не найден в выбранном WhatsApp Business Account (первые 100 номеров).', 409);
      const debug = await this.request(channel, platform.version, `debug_token?input_token=${encodeURIComponent(token)}`, `${platform.app_id}|${platform.app_secret}`);
      if (!debug.data?.is_valid || String(debug.data.app_id) !== platform.app_id || !debug.data.scopes?.includes('whatsapp_business_messaging')) throw new AppError('META_APP_MISMATCH', 'Токен должен быть выпущен для приложения MBusiness с правами WhatsApp.', 409);
      const expiries=[debug.data.expires_at,debug.data.data_access_expires_at].filter(x=>Number.isSafeInteger(x)&&x>0);return { label: `${data.verified_name || 'WhatsApp'} · ${data.display_phone_number || id}`,expires_at:expiries.length?Math.min(...expiries)*1000:null };
    }
    const data = await this.request(channel, platform.version, 'me?fields=user_id,username', token);
    if (String(data.user_id || data.id) !== id) throw new AppError('META_ID_MISMATCH', 'Токен принадлежит другому Instagram-аккаунту.', 409);
    return { label: data.username ? `@${data.username}` : id };
  }
  async subscribe(channel, credentials, platform) {
    const result=await this.request(channel, platform.version, `${channel === 'whatsapp' ? credentials.waba_id : credentials.external_id}/subscribed_apps`, credentials.access_token, { method: 'POST', body: channel === 'instagram' ? { subscribed_fields: 'messages,messaging_postbacks,messaging_seen' } : {} });
    if(result.success!==true)throw new AppError('META_SUBSCRIPTION_FAILED','Meta не подтвердила подписку на сообщения.',409);
    return result;
  }
  async send(connection, secret, platform, recipient, text) {
    const body = connection.channel === 'whatsapp'
      ? { messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient, type: 'text', text: { preview_url: false, body: text } }
      : { recipient: { id: recipient }, message: { text } };
    const result = await this.request(connection.channel, platform.version, `${connection.external_id}/messages`, secret.access_token, { method: 'POST', body });
    const id = connection.channel === 'whatsapp' ? result.messages?.[0]?.id : result.message_id;
    if (typeof id !== 'string' || !id) throw new AppError('META_RESULT_UNKNOWN', 'Meta не вернула идентификатор сообщения. Не отправляйте повторно до сверки.', 502);
    return id;
  }
  async refreshInstagram(accessToken) {
    const url=new URL('https://graph.instagram.com/refresh_access_token');url.search=new URLSearchParams({grant_type:'ig_refresh_token',access_token:accessToken});let response,data;
    try{response=await this.fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000)});data=await response.json();}catch{throw new AppError('META_TOKEN_REFRESH_FAILED','Не удалось обновить доступ Instagram.',409);}
    if(!response.ok||typeof data.access_token!=='string'||!Number.isSafeInteger(data.expires_in)||data.expires_in<=0)throw new AppError('META_TOKEN_REFRESH_FAILED','Переподключите Instagram для обновления доступа.',409);
    return {access_token:data.access_token,expires_at:Date.now()+data.expires_in*1000};
  }
  async facebookCode(code, platform) {
    let response,data;
    try {
      const url=new URL('https://graph.facebook.com/'+platform.version+'/oauth/access_token');
      url.search=new URLSearchParams({client_id:platform.app_id,client_secret:platform.app_secret,code});
      response=await this.fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000)});data=await response.json();
    } catch { throw new AppError('META_OAUTH_FAILED','Не удалось завершить вход Facebook. Начните подключение заново.',409); }
    if(!response.ok||!data.access_token)throw new AppError('META_OAUTH_FAILED','Facebook не выдал доступ к WhatsApp Business. Проверьте разрешения приложения.',409);
    return data.access_token;
  }
  async instagramCode(code, platform, redirectUri) {
    let response, short;
    try {
      response = await this.fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), body: new URLSearchParams({ client_id: platform.app_id, client_secret: platform.app_secret, grant_type: 'authorization_code', redirect_uri: redirectUri, code }) });
      short = await response.json();
    } catch { throw new AppError('META_OAUTH_FAILED', 'Не удалось обменять код Instagram. Начните подключение заново.', 409); }
    // Current Instagram Login returns {data:[{access_token,user_id,permissions}]}.
    const token = short.data?.[0] || short;
    if (!response.ok || !token.access_token || !token.user_id) throw new AppError('META_OAUTH_FAILED', 'Instagram не выдал доступ. Проверьте настройки приложения и разрешения.', 409);
    let long;
    try {
      const url = new URL('https://graph.instagram.com/access_token');
      url.search = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: platform.app_secret, access_token: token.access_token });
      const result = await this.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
      long = await result.json();
      if (!result.ok || !long.access_token) throw new Error('exchange');
    } catch { throw new AppError('META_OAUTH_FAILED', 'Не удалось получить длительный доступ Instagram. Повторите подключение.', 409); }
    return { access_token: long.access_token, external_id: String(token.user_id), expires_at: Date.now() + Number(long.expires_in || 3600) * 1000 };
  }
}

export class TelegramProvider {
  constructor({ fetchImpl = fetch } = {}) { this.fetch = fetchImpl; }
  async request(token, method, body = {}) {
    let response, data;
    try {
      response = await this.fetch(`https://api.telegram.org/bot${token}/${method}`, { method:'POST', redirect:'error', signal:AbortSignal.timeout(15000), headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
      data = await response.json();
    } catch { throw new AppError('META_RESULT_UNKNOWN','Связь с Telegram прервана. Требуется сверка результата.',502); }
    if (!response.ok || !data.ok) throw new AppError('TELEGRAM_REJECTED','Telegram отклонил запрос. Проверьте токен бота и разрешения.',409);
    return data.result;
  }
}
