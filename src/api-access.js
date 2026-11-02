import net from 'node:net';
import { AppError } from './db.js';

// Canonical text also makes IPv4-mapped IPv6 sockets match IPv4 bindings.
export function normalizeIp(value) {
  if(typeof value!=='string'||!value||value.includes('%')||!net.isIP(value))return null;
  if(net.isIP(value)===4)return value;
  const url=new URL(`http://[${value}]/`);const canonical=url.hostname.slice(1,-1).toLowerCase();
  if(canonical.startsWith('::ffff:')){
    const parts=canonical.slice(7).split(':');
    if(parts.length===2){const high=parseInt(parts[0],16),low=parseInt(parts[1],16);return `${high>>>8}.${high&255}.${low>>>8}.${low&255}`;}
  }
  return canonical;
}
export function publicServerIp(value){
 const ip=normalizeIp(value);if(!ip)return null;
 if(net.isIP(ip)===4){
  const [a,b,c]=ip.split('.').map(Number);
  if(a===0||a===10||a===127||a>=224||a===100&&b>=64&&b<=127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0&&(c===0||c===2)||b===88&&c===99)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113)return null;
 }else{
  // Bind individual global-unicast addresses only. No local, multicast, NAT64 or tunnel prefixes.
  const parts=ip.split(':');const first=parseInt(parts[0],16),second=parseInt(parts[1]||'0',16);
  if(!Number.isFinite(first)||first<0x2000||first>0x3fff||ip.startsWith('2001:db8:')||ip==='2001:db8::'||ip.startsWith('2002:')||first===0x2001&&second<0x200||ip.startsWith('3fff:'))return null;
 }
 return ip;
}
export function clientServerIp(req,config){
 const peer=normalizeIp(req.raw.socket.remoteAddress);
 if(!peer)return null;
 const trusted=(config.trustedProxyIps||[]).map(normalizeIp);
 if(!trusted.includes(peer))return peer;
 // Exactly one configured reverse proxy. It must overwrite X-Forwarded-For, not append client input.
 const forwarded=req.headers['x-forwarded-for'];
 return typeof forwarded==='string'&&!forwarded.includes(',')?normalizeIp(forwarded.trim()):null;
}
export function requireApiServer(req,merchant,config){
 if(!merchant.api_ip)throw new AppError('API_SERVER_REQUIRED','Привяжите API-ключ к IP сервера в разделе «API и webhooks».',403);
 if(clientServerIp(req,config)!==normalizeIp(merchant.api_ip))throw new AppError('API_IP_NOT_ALLOWED','API-ключ недоступен с IP этого сервера.',403);
}
