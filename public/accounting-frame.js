let frame,host,timer,companyId,currentSection,ready=false;
export function stopAccountingFrame(){clearTimeout(timer);frame=null;host=null;companyId=null;ready=false;}
function loading(message,failed=false){const el=host?.querySelector('.accounting-loading');if(!el)return;el.hidden=false;el.querySelector('p').textContent=message;el.querySelector('button').hidden=!failed;}
function watchLoad(){clearTimeout(timer);ready=false;loading('Открываем учёт… При первом входе загружается интерфейс.');timer=setTimeout(()=>loading('Учёт загружается дольше обычного. Проверьте соединение и повторите загрузку.',true),45000);}
function sendSection(){frame?.contentWindow?.postMessage({type:'mbusiness-accounting-section',section:currentSection},location.origin);}
export function mountAccountingFrame(target,company,section,title,go){
 currentSection=section;
 if(frame?.isConnected&&host?.parentElement===target&&companyId===company.id){frame.title='MBusiness: '+title;sendSection();return;}
 stopAccountingFrame();companyId=company.id;currentSection=section;
 const reminder=document.createElement('div');reminder.className='setup-reminder';const text=document.createElement('span');text.textContent='Новая компания? Подготовьте учёт по шагам.';const button=document.createElement('button');button.className='text-button';button.id='continue-setup';button.textContent='Продолжить настройку →';button.onclick=()=>go('setup');reminder.append(text,button);
 host=document.createElement('div');host.className='accounting-host';const loader=document.createElement('div');loader.className='accounting-loading';const mark=document.createElement('b');mark.textContent='M';const note=document.createElement('p');const retry=document.createElement('button');retry.className='secondary';retry.textContent='Повторить загрузку';retry.hidden=true;retry.onclick=()=>{watchLoad();frame.src='/accounting/?section='+encodeURIComponent(currentSection);};loader.append(mark,note,retry);
 frame=document.createElement('iframe');frame.id='accounting-frame';frame.title='MBusiness: '+title;frame.src='/accounting/?section='+encodeURIComponent(section);frame.onload=()=>sendSection();host.append(frame,loader);target.replaceChildren(reminder,host);watchLoad();
 fetch('/accounting-api/v1/companies/'+encodeURIComponent(company.id)+'/setup',{credentials:'same-origin'}).then(r=>r.ok?r.json():null).then(setup=>{if(setup?.finished&&reminder.isConnected)reminder.hidden=true;}).catch(()=>{});
}
window.addEventListener('message',event=>{if(!frame||event.origin!==location.origin||event.source!==frame.contentWindow||event.data?.type!=='mbusiness-accounting-state')return;if(event.data.ready){if(!ready)sendSection();ready=true;clearTimeout(timer);const el=host.querySelector('.accounting-loading');if(el)el.hidden=true;}else if(event.data.error){clearTimeout(timer);loading('Не удалось подключить учёт. Повторите загрузку или войдите в MBusiness заново.',true);}});
