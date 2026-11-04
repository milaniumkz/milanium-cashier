// The cross-site GET is deliberately public. Once this same-origin document has
// loaded, this fresh fetch carries the Strict session cookie. State still binds
// the provider code to the original company, actor and exact authenticated session.
const status=document.querySelector('#callback-status');
try{
 const q=new URLSearchParams(location.search),match=location.pathname.match(/^\/social\/publishing\/(vk|ok)\/callback$/),endpoint=location.pathname==='/social/instagram/callback'?'/account/social/instagram/callback':match?'/account/publishing/'+match[1]+'/callback':null;
 if(!endpoint)throw new Error('Неизвестный канал подключения.');
 const body={state:q.get('state')||'',...(q.has('code')?{code:q.get('code')}:{error:q.get('error')||'cancelled'})};
 // Remove the short-lived authorization code from browser history immediately.
 history.replaceState(null,'',location.pathname);
 const r=await fetch(endpoint,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),data=await r.json();
 if(!r.ok)throw new Error(data.error?.message||'Не удалось завершить подключение. Войдите в кабинет и начните заново.');
 if(!['/#social','/#publishing'].includes(data.redirect))throw new Error('Некорректный ответ сервера.');
 location.replace(data.redirect);
}catch(e){status.textContent=e.message;}
