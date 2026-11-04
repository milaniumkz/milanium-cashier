import {SERVICE_ORIGIN} from './config.js';
const $=s=>document.querySelector(s);
$('#dashboard').href=SERVICE_ORIGIN+'/#publishing';
async function render(){const data=await chrome.storage.local.get(['token','enabled','status','company_name']);$('#pair').hidden=!!data.token;$('#controls').hidden=!data.token;$('#company').textContent=data.company_name||'';$('#enabled').checked=!!data.enabled;$('#status').textContent=data.status||'Откройте MBusiness → Публикации → Браузер и получите код.';}
async function command(message,button){if(button)button.disabled=true;try{const response=await chrome.runtime.sendMessage(message);if(response?.error)throw new Error(response.error);await render();}catch(e){$('#status').textContent=e.message;}finally{if(button)button.disabled=false;}}
$('#pair-button').onclick=()=>command({type:'pair',code:$('#code').value.trim()},$('#pair-button'));
$('#enabled').onchange=()=>command({type:'enable',value:$('#enabled').checked});
$('#calibrate').onclick=()=>{command({type:'calibrate'});window.close();};
$('#check').onclick=()=>command({type:'check'},$('#check'));
$('#disconnect').onclick=()=>command({type:'disconnect'},$('#disconnect'));
chrome.storage.onChanged.addListener(()=>render());render();
