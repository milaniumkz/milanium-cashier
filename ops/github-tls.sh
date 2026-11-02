#!/usr/bin/env bash
# Obtain a dedicated certificate using only a new HTTP vhost. Existing vhosts are unchanged.
set -euo pipefail
umask 077
base_url=${1:?dedicated HTTPS origin required}
[[ $(id -u) == 0 && -f /srv/mbusiness/.mbusiness-owned ]] || exit 1
[[ $(cat /srv/mbusiness/.mbusiness-owned) == 'MBusiness isolated deployment v1' ]] || exit 1
readarray -t origin < <(python3 - "$base_url" <<'PY'
import sys,urllib.parse
u=urllib.parse.urlsplit(sys.argv[1]);p=u.port or 443
assert u.scheme=='https' and u.hostname=='mbusiness.89.126.192.185.sslip.io'
assert p==8443 and u.path in ('','/') and not u.query and not u.fragment and not u.username
print(u.hostname);print(p)
PY
)
[[ ${#origin[@]} == 2 ]] || exit 1
domain=${origin[0]};port=${origin[1]}
for command in certbot nginx curl openssl systemctl;do command -v "$command" >/dev/null;done
nginx -t
existing_master=$(systemctl show nginx.service -p MainPID --value)
# Read-only baseline for the existing MTaxi site.
mtaxi_url=https://mtaxi.89.126.192.185.sslip.io
baseline=$(curl --fail --silent --show-error --resolve mtaxi.89.126.192.185.sslip.io:443:127.0.0.1 "$mtaxi_url/" | sha256sum)
config=/etc/nginx/conf.d/mbusiness-acme.conf
[[ ! -L "$config" ]] || exit 1
if [[ -e "$config" ]] && ! grep -Fq '# Managed by MBusiness isolated ACME' "$config";then echo 'Existing unrelated config at target path; abort.' >&2;exit 1;fi
root=/srv/mbusiness
install -d -m 0755 "$root/acme-webroot/.well-known/acme-challenge"
install -d -m 0700 "$root/acme-work" "$root/acme-logs" /etc/mbusiness/acme /etc/mbusiness/tls
snapshot=$(mktemp "$root/nginx-config-hashes.XXXXXX")
find /etc/nginx -maxdepth 2 -type f ! -path "$config" -print0 | sort -z | xargs -0 sha256sum > "$snapshot"
previous=$(mktemp "$root/previous-acme-conf.XXXXXX")
had_config=false
if [[ -f "$config" ]];then cp "$config" "$previous";had_config=true;fi
pending=$(mktemp /etc/nginx/conf.d/.mbusiness-acme.XXXXXX)
cat > "$pending" <<CONF
# Managed by MBusiness isolated ACME
server {
    listen 80;
    server_name $domain;
    location ^~ /.well-known/acme-challenge/ {
        root /srv/mbusiness/acme-webroot;
        default_type text/plain;
        try_files \$uri =404;
    }
    location / { return 308 https://\$host:$port\$request_uri; }
}
CONF
chmod 0644 "$pending"
mv -T "$pending" "$config"
rollback_config(){
 if [[ "$had_config" == true ]];then cp "$previous" "$config";else rm -f "$config";fi
 nginx -t && systemctl reload nginx.service
}
if ! nginx -t;then rollback_config;exit 1;fi
systemctl reload nginx.service
if [[ $(systemctl show nginx.service -p MainPID --value) != "$existing_master" ]];then echo 'Unexpected proxy master replacement.' >&2;exit 1;fi
sha256sum -c "$snapshot" >/dev/null
current=$(curl --fail --silent --show-error --resolve mtaxi.89.126.192.185.sslip.io:443:127.0.0.1 "$mtaxi_url/" | sha256sum)
if [[ "$current" != "$baseline" ]];then rollback_config;echo 'MTaxi baseline changed; reverted only the new MBusiness HTTP config.' >&2;exit 1;fi
certbot certonly --non-interactive --agree-tos --register-unsafely-without-email \
 --webroot -w "$root/acme-webroot" -d "$domain" --cert-name mbusiness \
 --config-dir /etc/mbusiness/acme --work-dir "$root/acme-work" --logs-dir "$root/acme-logs" --keep-until-expiring
cert=/etc/mbusiness/acme/live/mbusiness/fullchain.pem
key=/etc/mbusiness/acme/live/mbusiness/privkey.pem
openssl x509 -in "$cert" -noout -checkhost "$domain"
for destination in /etc/mbusiness/tls/fullchain.pem /etc/mbusiness/tls/privkey.pem;do
 [[ ! -L "$destination" ]] || { echo 'Unexpected TLS symlink; refusing to overwrite.' >&2;exit 1; }
done
install -m 0600 "$cert" /etc/mbusiness/tls/fullchain.pem
install -m 0600 "$key" /etc/mbusiness/tls/privkey.pem
sha256sum -c "$snapshot" >/dev/null
rm -f "$snapshot" "$previous"
echo 'Dedicated MBusiness TLS certificate ready. Existing MTaxi configs and HTTPS response are unchanged.'
