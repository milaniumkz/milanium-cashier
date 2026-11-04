// This function is serialized by chrome.scripting. All dependencies must stay inside it.
// It never reads cookies, passwords, browser storage, account tokens or network traffic.
export async function pageAdapter(action,payload){
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const visible=element=>!!element&&element.isConnected&&element.getBoundingClientRect().width>0&&element.getBoundingClientRect().height>0&&getComputedStyle(element).visibility!=='hidden';
 const text=value=>String(value||'').replace(/[\s\u200b]+/g,' ').trim();
 const network=host=>/^(?:(?:www|m)\.)?vk\.(?:com|ru)$/.test(host)?'vk':/^(?:(?:www|m)\.)?ok\.ru$/.test(host)?'ok':null;
 const normalized=url=>{const u=new URL(url);u.search='';u.hash='';u.pathname=u.pathname.replace(/\/$/,'').replace(/^\/(?:public|event)(\d+)$/,'/club$1').replace(/^(\/group\/\d+)\/(?:topics|feed)$/,'$1');u.hostname=u.hostname.replace(/^(www|m)\./,'').replace(/^vk\.ru$/,'vk.com');return u.href;};
 const find=selector=>{try{const matches=document.querySelectorAll(selector);return matches.length===1?matches[0]:null;}catch{return null;}};
 const editable=element=>element&&(element.matches('textarea')||element.isContentEditable)&&!element.closest('form[action*=login],.reply_form,.comments,.comment,[data-testid*=comment]')&&element.getAttribute('type')!=='password';
 const select=element=>{if(element.id&&document.querySelectorAll('#'+CSS.escape(element.id)).length===1)return '#'+CSS.escape(element.id);for(const attr of ['data-testid','data-test-id','aria-label']){const v=element.getAttribute(attr);if(v&&v.length<150){const selector=element.tagName.toLowerCase()+'['+attr+'='+JSON.stringify(v)+']';if(document.querySelectorAll(selector).length===1)return selector;}}const parts=[];let node=element;for(let i=0;node&&node!==document.body&&i<9;i++,node=node.parentElement){let part=node.tagName.toLowerCase();const siblings=[...node.parentElement.children].filter(n=>n.tagName===node.tagName);if(siblings.length>1)part+=':nth-of-type('+(siblings.indexOf(node)+1)+')';parts.unshift(part);const selector=parts.join(' > ');if(document.querySelectorAll(selector).length===1)return selector;}throw new Error('SELECTOR_AMBIGUOUS');};
 const common=(a,b)=>{let node=a;while(node&&!node.contains(b))node=node.parentElement;return node===document.body||node===document.documentElement?null:node;};
 const label=button=>text(button?.innerText||button?.getAttribute('aria-label')||button?.value);
 const allowedButton=button=>visible(button)&&!button.disabled&&button.getAttribute('aria-disabled')!=='true'&&/опубликов|размест|поделить|отправить|post|publish|share/i.test(label(button))&&!/удал|войти|login|delete|коммент|comment|сообщени|message/i.test(label(button));
 const proofLinks=(job)=>[...document.querySelectorAll('a[href]')].map(a=>({a,url:new URL(a.getAttribute('href'),location.href)})).filter(({url})=>{if(network(url.hostname)!==job.network)return false;const match=job.network==='vk'?url.pathname.match(/^\/wall-([1-9]\d*)_([1-9]\d*)$/):url.pathname.match(/^\/group\/([1-9]\d*)\/topic\/([1-9]\d*)$/);if(!match)return false;const gid=new URL(job.group_url).pathname.match(job.network==='vk'?/^\/(?:club|public|event)(\d+)$/:/^\/group\/(\d+)$/)?.[1];return !gid||gid===match[1];});
 if(!network(location.hostname))return {ok:false,error:'TARGET_MISMATCH'};
 if(action==='calibrate'){
  if(document.querySelector('#mbusiness-calibration'))return {ok:false,error:'CALIBRATION_ALREADY_OPEN'};
  return new Promise(resolve=>{let editor,opener;const root=document.createElement('div');root.id='mbusiness-calibration';root.style.cssText='position:fixed;top:12px;left:12px;right:12px;z-index:2147483647';const shadow=root.attachShadow({mode:'closed'}),box=document.createElement('div');box.style.cssText='background:#143f32;color:white;padding:18px;border-radius:12px;font:16px sans-serif;box-shadow:0 4px 24px #0007';const note=document.createElement('span'),cancel=document.createElement('button');cancel.textContent='Отмена';cancel.style.cssText='margin-left:20px;padding:8px';note.textContent='MBusiness: нажмите кнопку создания нового поста или сразу поле текста, если форма уже открыта. Не поле комментария.';box.append(note,cancel);shadow.append(box);document.documentElement.append(root);let timeout;
   const finish=value=>{clearTimeout(timeout);document.removeEventListener('click',capture,true);root.remove();resolve(value);};
   cancel.onclick=()=>finish({ok:false,error:'CALIBRATION_CANCELLED'});
   const capture=event=>{if(event.composedPath().includes(root))return;const target=event.target;
    if(!editor&&!opener){const selected=target.closest('textarea,[contenteditable=true]');if(!editable(selected)){const candidate=target.closest('button,[role=button],a,[tabindex]')||target,caption=label(candidate);if(visible(candidate)&&caption.length<160&&/созда|напис|новост|новый|пост|что.{0,20}нов|замет|тем[ау]|create|write|new|post|update/i.test(caption)&&!/опубликов|размест|поделить|отправить|удал|войти|publish|share|delete|login|сообщени|message|коммент|comment/i.test(caption)){try{opener={selector:select(candidate),label:caption};note.textContent='Форма открывается. Теперь нажмите поле текста нового поста.';return;}catch{}}}}
    event.preventDefault();event.stopImmediatePropagation();
    if(!editor){const selected=target.closest('textarea,[contenteditable=true]');if(!editable(selected)||!visible(selected)){note.textContent='Выберите видимое поле текста нового поста (textarea/contenteditable).';return;}editor=selected;note.textContent='Теперь нажмите кнопку ПУБЛИКАЦИИ этого поста. Нажатие будет перехвачено — пост не отправится.';return;}
    const button=target.closest('button,[role=button],input[type=submit],a');if(!allowedButton(button)){note.textContent='Выберите доступную кнопку публикации, не кнопку входа, комментария или сообщения.';return;}const container=common(editor,button);if(!container){note.textContent='Поле и кнопка должны быть в одной форме нового поста. Начните заново, если выбрали неверное поле.';return;}try{const files=[...container.querySelectorAll('input[type=file]')].filter(el=>!el.accept||/image/i.test(el.accept));finish({ok:true,configuration:{opener:opener||null,editor:select(editor),button:select(button),button_label:label(button),container:select(container),image:files.length===1?select(files[0]):null,network:network(location.hostname)}});}catch{finish({ok:false,error:'SELECTOR_AMBIGUOUS'});}};
   document.addEventListener('click',capture,true);timeout=setTimeout(()=>finish({ok:false,error:'CALIBRATION_TIMEOUT'}),120000);
  });
 }
 const job=payload.job,configuration=payload.configuration;
 if(network(location.hostname)!==job.network||normalized(location.href)!==normalized(job.group_url))return {ok:false,error:'TARGET_MISMATCH'};
 if([...document.querySelectorAll('input[type=password],iframe[src*=captcha],[class*=captcha],[id*=captcha]')].some(visible)||/captcha|challenge|login|authcheck/i.test(location.pathname))return {ok:false,error:'AUTH_OR_CAPTCHA_REQUIRED'};
 let editor=find(configuration.editor),button=find(configuration.button),container=find(configuration.container);
 if(action==='prepare'&&!visible(editor)&&configuration.opener){const opener=find(configuration.opener.selector);if(!visible(opener)||label(opener)!==configuration.opener.label)return {ok:false,error:'COMPOSER_OPENER_CHANGED'};opener.click();}
 if(action==='prepare')for(let attempt=0;attempt<20&&(!visible(editor)||!visible(button));attempt++){await wait(500);editor=find(configuration.editor);button=find(configuration.button);container=find(configuration.container);}
 if(!editable(editor)||!visible(editor)||!container?.contains(editor)||!container.contains(button)||label(button)!==configuration.button_label)return {ok:false,error:'FORM_CHANGED'};
 const editorText=()=>text(editor.matches('textarea')?editor.value:editor.innerText);
 globalThis.__mbusinessJobs??={};
 if(action==='prepare'){
  if(editorText())return {ok:false,error:'EDITOR_NOT_EMPTY'};
  const previous=proofLinks(job).map(x=>normalized(x.url.href));
  editor.focus();if(editor.matches('textarea')){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(editor,job.body);}else{editor.textContent=job.body;}
  editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:job.body}));editor.dispatchEvent(new Event('change',{bubbles:true}));
  const imagesBefore=new Set([...container.querySelectorAll('img')].map(image=>image.src));
  if(payload.media){const input=configuration.image&&find(configuration.image);if(!input||input.type!=='file'||!container.contains(input))return {ok:false,error:'MEDIA_NOT_SUPPORTED'};const bytes=Uint8Array.from(atob(payload.media.data),c=>c.charCodeAt(0)),file=new File([bytes],payload.media.mime==='image/png'?'mbusiness.png':payload.media.mime==='image/webp'?'mbusiness.webp':'mbusiness.jpg',{type:payload.media.mime}),transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));await wait(3000);}
  for(let i=0;i<30;i++){const progress=[...container.querySelectorAll('[role=progressbar],.upload_progress,.upload-progress')].some(visible);const imageReady=!payload.media||[...container.querySelectorAll('img')].some(image=>visible(image)&&image.complete&&image.naturalWidth>0&&!imagesBefore.has(image.src));const uploadError=[...container.querySelectorAll('[role=alert],.upload_error,.upload-error')].some(el=>visible(el)&&/ошиб|не удалось|error|failed/i.test(el.innerText));if(uploadError)return {ok:false,error:'MEDIA_UPLOAD_FAILED'};if(!progress&&imageReady&&allowedButton(button)&&editorText()===text(job.body)){globalThis.__mbusinessJobs[job.id]={previous,clicked:false,expected:text(job.body)};return {ok:true};}await wait(1000);}
  return {ok:false,error:'FORM_OR_UPLOAD_NOT_READY'};
 }
 if(action==='send'){
  const state=globalThis.__mbusinessJobs[job.id];if(!Number.isSafeInteger(payload.expires_at)||Date.now()>payload.expires_at)return {ok:false,error:'SEND_PERMIT_EXPIRED'};if(!state||state.clicked||editorText()!==state.expected||!allowedButton(button))return {ok:false,error:'SEND_GUARD_FAILED'};
  state.clicked=true;button.click();
  for(let i=0;i<40;i++){await wait(1000);for(const {a,url}of proofLinks(job)){if(state.previous.includes(normalized(url.href)))continue;const card=a.closest('[data-post-id],.post,.feed-w,.feed-item,article,[data-item-id]');if(card&&text(card.innerText).includes(state.expected)&&(!editor.isConnected||!editorText())){url.search='';url.hash='';url.hostname=job.network==='vk'?'vk.com':'ok.ru';return {ok:true,post_url:url.href};}}}
  return {ok:false,error:'PUBLICATION_NOT_CONFIRMED'};
 }
 return {ok:false,error:'UNKNOWN_ACTION'};
}
