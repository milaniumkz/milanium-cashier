const $=s=>document.querySelector(s), token=location.pathname.split('/').pop(), sandbox=document.body.dataset.sandbox==='true';
const labels={queued:'Счёт в очереди',processing:'Счёт создаётся',pending:'Ожидаем оплату',paid:'Оплата подтверждена',declined:'Платёж отклонён',expired:'Срок оплаты истёк',unknown:'Проверяем результат операции',requires_auth:'Продавцу нужно подключить кассу',failed:'Не удалось создать счёт'};
let busy=false, timer;
async function refresh(){if(busy)return;busy=true;try{
  const r=await fetch(`/public/payments/${encodeURIComponent(token)}`);const p=await r.json();if(!r.ok)throw new Error(p.error?.message||'Платёж недоступен.');
  $('#merchant').textContent=p.merchant_name;$('#order').textContent=`Заказ № ${p.order_id}`;$('#amount').textContent=new Intl.NumberFormat('ru-RU').format(p.amount)+' ₸';$('#status').textContent=labels[p.status]||p.status;
  $('#status').className=`badge ${p.status}`;$('#error').textContent='';$('#payment-mode').hidden=p.mode!=='sandbox';if(p.mode==='sandbox')$('#payment-mode').textContent='ТЕСТОВАЯ КАССА · Это не Kaspi. Денежных операций нет.';
  $('#hint').textContent=p.status==='paid'?'Продавец получил подтверждение. Можно вернуться в приложение.':p.status==='unknown'?'Не оплачивайте повторно, пока продавец сверяет результат.':p.method==='phone'&&p.mode==='android'?'Откройте полученный счёт в приложении Kaspi.kz.':p.status==='pending'?'Оплатите по ссылке или отсканируйте QR другим телефоном.':'';
  $('#expiry').textContent=p.qr_expired&&p.status==='pending'?'QR истёк. Дождитесь проверки статуса или обратитесь к продавцу.':p.expires_at&&p.status==='pending'?`Действует до ${new Date(p.expires_at).toLocaleTimeString('ru-RU')}`:'';
  if(sandbox){for(const s of ['#simulate-paid','#simulate-declined'])$(s).hidden=p.status!=='pending'||p.qr_expired;}
  else {
    $('#qr').hidden=!p.qr_url;if(p.qr_url&&$('#qr').getAttribute('src')!==p.qr_url)$('#qr').src=p.qr_url;
    $('#pay-link').hidden=!p.payment_url;if(p.payment_url){$('#pay-link').href=p.payment_url;$('#pay-link').textContent=p.mode==='sandbox'?'Открыть тестовую кассу':'Открыть Kaspi';}
  }
  if(['paid','declined','expired','failed'].includes(p.status))clearInterval(timer);
}catch(e){$('#error').textContent=e.message;}finally{busy=false;}}
if(sandbox)for(const state of ['paid','declined'])$(`#simulate-${state}`).onclick=async()=>{for(const b of document.querySelectorAll('button'))b.disabled=true;try{const r=await fetch(`/sandbox/payments/${encodeURIComponent(token)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state})});if(!r.ok){const v=await r.json();throw new Error(v.error?.message||'Ошибка.');}$('#hint').textContent='Результат записан. Ожидаем проверку сервиса…';}catch(e){$('#error').textContent=e.message;}finally{for(const b of document.querySelectorAll('button'))b.disabled=false;}};
timer=setInterval(refresh,3000);refresh();
