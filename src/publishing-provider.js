import {createHash} from 'node:crypto';
import {AppError} from './db.js';
const md5=s=>createHash('md5').update(s).digest('hex');
const fail=(code='PUBLISH_PROVIDER_REJECTED')=>new AppError(code,code==='PUBLISH_RESULT_UNKNOWN'?'Результат публикации неизвестен. Сверьте группу перед повторными действиями.':'Площадка отклонила запрос. Проверьте разрешения приложения и права в группе.',409);
export function okSignature(params,accessToken,appSecret){return md5(Object.keys(params).sort().map(k=>`${k}=${params[k]}`).join('')+md5(accessToken+appSecret));}
export class PublishingProvider{
 constructor({fetchImpl=fetch}={}){this.fetch=fetchImpl;}
 async json(url,options={}){let response,data;try{response=await this.fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(20000)});data=await response.json();}catch{throw fail('PUBLISH_RESULT_UNKNOWN');}if(!response.ok||data.error||data.error_code)throw fail();return data;}
 async exchange(network,code,p,redirect){
  const params={client_id:p.app_id,client_secret:p.app_secret,redirect_uri:redirect,code};
  const data=network==='vk'?await this.json('https://oauth.vk.com/access_token?'+new URLSearchParams(params)):await this.json('https://api.ok.ru/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...params,grant_type:'authorization_code'})});
  if(!data.access_token)throw fail();return {access_token:data.access_token,expires_at:data.expires_in?Date.now()+Number(data.expires_in)*1000:null};
 }
 async call(network,method,params,credentials,p){
  if(network==='vk'){const data=await this.json('https://api.vk.com/method/'+method,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...params,access_token:credentials.access_token,v:p.version})});if(data.response===undefined)throw fail();return data.response;}
  const fields={...params,application_key:p.public_key,format:'json',method};const sig=okSignature(fields,credentials.access_token,p.app_secret);
  return this.json('https://api.ok.ru/fb.do',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...fields,access_token:credentials.access_token,sig})});
 }
 async profile(network,credentials,p){const data=await this.call(network,network==='vk'?'users.get':'users.getCurrentUser',{},credentials,p),u=network==='vk'?data[0]:data;if(!u||(network==='vk'?!u.id:!u.uid))throw fail();return {id:String(network==='vk'?u.id:u.uid),name:[u.first_name,u.last_name].filter(Boolean).join(' ')||String(u.uid||u.id)};}
 async groups(network,credentials,p){
  if(network==='vk'){const result=await this.call(network,'groups.get',{filter:'admin,editor',extended:'1',fields:'can_post,is_admin,admin_level',count:'1000'},credentials,p);return (result.items||[]).filter(g=>g.is_admin&&Number(g.admin_level)>=2&&Number(g.can_post)===1).map(g=>({id:String(g.id),name:g.name,url:'https://vk.com/'+(g.screen_name||'club'+g.id)}));}
  const result=await this.call(network,'group.getUserGroupsV2',{count:'100'},credentials,p);const list=(result.groups||[]).filter(g=>g.status==='ADMIN'||(Array.isArray(g.role)&&g.role.some(r=>['EDITOR','SUPER_MODERATOR'].includes(r))));
  if(!list.length)return [];const info=await this.call(network,'group.getInfo',{uids:list.map(g=>g.groupId).join(','),fields:'uid,name'},credentials,p);return (Array.isArray(info)?info:info.groups||[]).filter(g=>list.some(x=>String(x.groupId)===String(g.uid))).map(g=>({id:String(g.uid),name:g.name,url:'https://ok.ru/group/'+g.uid}));
 }
 async upload(network,group,credentials,p,media){
  const vk=network==='vk',setup=await this.call(network,vk?'photos.getWallUploadServer':'photosV2.getUploadUrl',vk?{group_id:group}:{gid:group,count:'1'},credentials,p);
  let url;try{url=new URL(setup.upload_url);}catch{throw fail();}
  // Only provider-generated upload destinations; no arbitrary user-controlled URLs.
  const domains=vk?['vk.com','vk.ru','userapi.com','vkuser.net','vkuserphoto.ru']:['ok.ru','mycdn.me','odnoklassniki.ru'];
  if(url.protocol!=='https:'||url.username||url.password||url.port||!domains.some(d=>url.hostname===d||url.hostname.endsWith('.'+d)))throw new AppError('UNSAFE_UPLOAD_HOST','Площадка вернула неподдерживаемый адрес загрузки.',409);
  const form=new FormData();form.set(vk?'photo':'pic1',new Blob([media.bytes],{type:media.mime}),media.mime==='image/png'?'image.png':media.mime==='image/webp'?'image.webp':'image.jpg');
  const data=await this.json(url,{method:'POST',body:form});
  if(vk){const photos=await this.call(network,'photos.saveWallPhoto',{group_id:group,photo:data.photo,server:String(data.server),hash:data.hash},credentials,p);if(!photos[0]?.id)throw fail();return 'photo'+photos[0].owner_id+'_'+photos[0].id;}
  const photo=Object.values(data.photos||{})[0];if(!photo?.token)throw fail();return photo.token;
 }
 async post(network,job,credentials,p,media){
  const attachment=media?await this.upload(network,job.external_group_id,credentials,p,media):null;
  if(network==='vk'){const result=await this.call(network,'wall.post',{owner_id:'-'+job.external_group_id,from_group:'1',message:job.body,guid:job.id.replaceAll('-','').slice(0,16),...(attachment?{attachments:attachment}:{})},credentials,p);if(!result.post_id)throw fail('PUBLISH_RESULT_UNKNOWN');return {id:String(result.post_id),url:`https://vk.com/wall-${job.external_group_id}_${result.post_id}`};}
  const result=await this.call(network,'mediatopic.post',{gid:job.external_group_id,type:'GROUP_THEME',attachment:JSON.stringify({media:[{type:'text',text:job.body},...(attachment?[{type:'photo',list:[{id:attachment}]}]:[])],onBehalfOfGroup:'true'})},credentials,p);if(typeof result!=='string'&&typeof result!=='number')throw fail('PUBLISH_RESULT_UNKNOWN');return {id:String(result),url:`https://ok.ru/group/${job.external_group_id}/topic/${result}`};
 }
}
