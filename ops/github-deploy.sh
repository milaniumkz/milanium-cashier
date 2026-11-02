#!/usr/bin/env bash
# Runs only on the target host, through the manually dispatched GitHub workflow.
set -euo pipefail
umask 077
mode=${1:-inspect}
if [[ "$mode" == inspect ]]; then
  uname -m
  cat /etc/os-release
  free -h
  df -h /
  ss -ltnp
  command -v node || true
  command -v nginx || true
  exit 0
fi
[[ "$mode" == deploy || "$mode" == prepare ]] || { echo 'Unknown operation' >&2; exit 1; }
release=${2:?commit SHA required}
archive=${3:?archive path required}
checksum=${4:?SHA256 required}
base_url=${5:-https://mbusiness.invalid:8443}
[[ "$release" =~ ^[a-f0-9]{40}$ && "$checksum" =~ ^[a-f0-9]{64}$ ]] || exit 1
[[ "$archive" =~ ^/root/mbusiness-upload-[0-9]+-[0-9]+/mbusiness-${release}\.tar\.gz$ ]] || exit 1
[[ $(id -u) == 0 ]] || { echo 'Deployment requires root for the dedicated service only.' >&2; exit 1; }
[[ $(uname -m) == x86_64 ]] || { echo 'This bootstrap requires Linux x86_64.' >&2; exit 1; }
for command in python3 curl tar sha256sum runuser systemctl nginx openssl ss; do
  command -v "$command" >/dev/null || { echo "Missing prerequisite: $command. No global packages will be installed." >&2; exit 1; }
done
readarray -t origin < <(python3 - "$base_url" <<'PY'
import re,sys,urllib.parse
try:
 u=urllib.parse.urlsplit(sys.argv[1]);p=u.port or 443
 assert u.scheme=='https' and u.hostname and not u.username and not u.password
 assert u.path in ('','/') and not u.query and not u.fragment
 assert re.fullmatch(r'[a-zA-Z0-9.-]+',u.hostname) and 1024<p<65536
 print(u.hostname);print(p)
except Exception:sys.exit(1)
PY
)
[[ ${#origin[@]} == 2 ]] || { echo 'Set a dedicated HTTPS domain and free port above 1024, e.g. https://mbusiness.example.kz:8443.' >&2; exit 1; }
domain=${origin[0]};proxy_port=${origin[1]};backend_port=3181
[[ "$proxy_port" != "$backend_port" ]] || exit 1
printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c - >/dev/null
root=/srv/mbusiness
if [[ -e "$root" || -L "$root" ]]; then
  [[ -d "$root" && ! -L "$root" && -f "$root/.mbusiness-owned" ]] || { echo '/srv/mbusiness is not owned by this installer; refusing to overwrite.' >&2; exit 1; }
  [[ $(cat "$root/.mbusiness-owned") == 'MBusiness isolated deployment v1' ]] || exit 1
else
  if id mbusiness >/dev/null 2>&1 || systemctl cat mbusiness.service >/dev/null 2>&1 || systemctl cat mbusiness-proxy.service >/dev/null 2>&1; then
    echo 'Pre-existing mbusiness user or unit without ownership marker; aborting.' >&2; exit 1
  fi
fi
for path in shared shared/data shared/proxy shared/proxy/tls shared/npm-cache shared/.env shared/proxy/nginx.conf shared/proxy/tls/fullchain.pem shared/proxy/tls/privkey.pem releases backups; do
  [[ ! -L "$root/$path" ]] || { echo "Unexpected symlink at $root/$path" >&2; exit 1; }
done
if [[ "$mode" == deploy ]]; then
# Dedicated TLS assets must already exist. Never borrow MTaxi's configuration or key.
cert=/etc/mbusiness/tls/fullchain.pem
cert_key=/etc/mbusiness/tls/privkey.pem
[[ -s "$cert" && -s "$cert_key" ]] || { echo 'Provision dedicated TLS files under /etc/mbusiness/tls first. MTaxi is unchanged.' >&2; exit 1; }
openssl x509 -in "$cert" -noout -checkend 86400 >/dev/null
openssl x509 -in "$cert" -noout -checkhost "$domain" >/dev/null
cert_pub=$(openssl x509 -in "$cert" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum)
key_pub=$(openssl pkey -in "$cert_key" -pubout -outform DER | sha256sum)
[[ "$cert_pub" == "$key_pub" ]] || { echo 'TLS certificate/key mismatch.' >&2; exit 1; }
fi
if [[ ! -f "$root/.mbusiness-owned" ]]; then
  ports=("$backend_port")
  if [[ "$mode" == deploy ]]; then ports+=("$proxy_port"); fi
  for port in "${ports[@]}"; do
    [[ -z $(ss -H -ltn "sport = :$port") ]] || { echo "Port $port is occupied; refusing to affect its service." >&2; exit 1; }
  done
fi
# All modifications from here on are confined to MBusiness paths, user and units.
install -d -m 0755 "$root" "$root/releases"
if [[ ! -f "$root/.mbusiness-owned" ]]; then
  printf '%s\n' 'MBusiness isolated deployment v1' > "$root/.mbusiness-owned"
fi
if ! id mbusiness >/dev/null 2>&1; then
  useradd --system --home-dir "$root" --no-create-home --shell /usr/sbin/nologin mbusiness
fi
install -d -o mbusiness -g mbusiness -m 0700 "$root/shared" "$root/shared/data" "$root/shared/proxy" "$root/shared/proxy/tls" "$root/shared/npm-cache"
node_version=v24.19.0
runtime="$root/runtime-$node_version"
if [[ ! -x "$runtime/bin/node" ]]; then
  stage=$(mktemp -d "$root/node-download.XXXXXX")
  trap 'rm -rf -- "$stage"' EXIT
  node_file="node-${node_version}-linux-x64.tar.xz"
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 "https://nodejs.org/dist/$node_version/SHASUMS256.txt" -o "$stage/SHASUMS256.txt"
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 "https://nodejs.org/dist/$node_version/$node_file" -o "$stage/$node_file"
  (cd "$stage"; awk -v name="$node_file" '$2==name {print}' SHASUMS256.txt > checked.sha256; [[ -s checked.sha256 ]]; sha256sum -c checked.sha256)
  [[ ! -e "$runtime" ]] || { echo 'Unexpected runtime directory.' >&2; exit 1; }
  mkdir "$stage/unpacked"
  tar -xJf "$stage/$node_file" -C "$stage/unpacked" --strip-components=1
  "$stage/unpacked/bin/node" --version
  mv "$stage/unpacked" "$runtime"
  rm -rf -- "$stage"
  trap - EXIT
fi
[[ $("$runtime/bin/node" -p 'process.versions.node.split(".")[0]') == 24 ]] || exit 1
release_dir="$root/releases/$release"
[[ ! -L "$release_dir" ]] || exit 1
if [[ ! -d "$release_dir" ]]; then
  pending_release=$(mktemp -d "$root/releases/.pending-${release}.XXXXXX")
  python3 - "$archive" "$pending_release" <<'PY'
import os,pathlib,shutil,sys,tarfile
root=pathlib.Path(sys.argv[2]);total=0
with tarfile.open(sys.argv[1]) as tar:
 for m in tar:
  path=pathlib.PurePosixPath(m.name)
  if path.is_absolute() or '..' in path.parts or m.issym() or m.islnk() or not (m.isdir() or m.isfile()):raise SystemExit('Unsafe archive entry')
  total+=m.size
  if total>100_000_000:raise SystemExit('Archive too large')
  dest=root.joinpath(*path.parts)
  if m.isdir():dest.mkdir(parents=True,exist_ok=True)
  else:
   dest.parent.mkdir(parents=True,exist_ok=True)
   with tar.extractfile(m) as source,open(dest,'xb') as target:shutil.copyfileobj(source,target)
   dest.chmod(0o644)
PY
  chown -R mbusiness:mbusiness "$pending_release"
  runuser -u mbusiness -- env PATH="$runtime/bin:/usr/bin:/bin" NPM_CONFIG_CACHE="$root/shared/npm-cache" bash -c 'cd "$1"; npm ci --omit=dev --no-audit --no-fund' _ "$pending_release"
  touch "$pending_release/.mbusiness-installed"
  mv "$pending_release" "$release_dir"
fi
[[ -f "$release_dir/.mbusiness-installed" ]] || { echo 'Incomplete release; refusing to run.' >&2; exit 1; }
[[ -f "$release_dir/src/server.js" && -f "$release_dir/ops/mbusiness.service" ]] || exit 1
# Keep secrets on the server. Never log them or overwrite an existing encryption key.
if [[ ! -f "$root/shared/.env" ]]; then
  "$runtime/bin/node" --input-type=module - "$root/shared/.env" "$base_url" <<'JS'
import {writeFileSync} from 'node:fs';import {randomBytes} from 'node:crypto';
const [file,base]=process.argv.slice(2);
writeFileSync(file,`NODE_ENV=production\nHOST=127.0.0.1\nPORT=3181\nPUBLIC_BASE_URL=${base}\nDATA_DIR=/srv/mbusiness/shared/data\nADMIN_PASSWORD=${randomBytes(24).toString('base64url')}\nENCRYPTION_KEY=${randomBytes(32).toString('base64')}\nDRIVER_MODE=kaspi\nLIVE_AUTOMATION_ENABLED=false\nTRUSTED_PROXY_IPS=127.0.0.1\nWEBHOOK_ALLOWED_ORIGINS=\n`,{mode:0o600,flag:'wx'});
JS
  chown mbusiness:mbusiness "$root/shared/.env"
fi
"$runtime/bin/node" --input-type=module - "$root/shared/.env" "$base_url" <<'JSENV'
import {readFileSync,writeFileSync} from 'node:fs';
const [file,url]=process.argv.slice(2);const text=readFileSync(file,'utf8');
const current=text.match(/^PUBLIC_BASE_URL=(.*)$/m)?.[1];
if(current!==url){
 if(current!=='https://mbusiness.invalid:8443')throw new Error('Existing public URL differs; explicit migration required.');
 writeFileSync(file,text.replace(/^PUBLIC_BASE_URL=.*$/m,'PUBLIC_BASE_URL='+url),{mode:0o600});
}
if(!/^PORT=3181$/m.test(text)||!/^DATA_DIR=\/srv\/mbusiness\/shared\/data$/m.test(text))throw new Error('Unexpected existing data/port configuration');
JSENV
if [[ "$mode" == deploy ]]; then
install -o mbusiness -g mbusiness -m 0600 "$cert" "$root/shared/proxy/tls/fullchain.pem"
install -o mbusiness -g mbusiness -m 0600 "$cert_key" "$root/shared/proxy/tls/privkey.pem"
sed -e '/^user mbusiness;/d' -e "s/mbusiness.example.kz/$domain/g" -e "s/listen 8443 ssl/listen $proxy_port ssl/" -e 's@/srv/mbusiness/proxy/@/srv/mbusiness/shared/proxy/@g' "$release_dir/ops/mbusiness-nginx.conf.example" > "$root/shared/proxy/nginx.conf"
chown mbusiness:mbusiness "$root/shared/proxy/nginx.conf"
runuser -u mbusiness -- nginx -p "$root/shared/proxy/" -c "$root/shared/proxy/nginx.conf" -t
nginx_bin=$(command -v nginx)
cat > /etc/systemd/system/mbusiness-proxy.service <<UNIT
[Unit]
Description=MBusiness separate HTTPS proxy
After=network-online.target mbusiness.service
[Service]
Type=simple
User=mbusiness
Group=mbusiness
ExecStart=$nginx_bin -p /srv/mbusiness/shared/proxy/ -c /srv/mbusiness/shared/proxy/nginx.conf -g "daemon off;"
Restart=on-failure
RestartSec=5
KillSignal=SIGQUIT
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/mbusiness/shared/proxy
MemoryMax=128M
CPUQuota=25%
[Install]
WantedBy=multi-user.target
UNIT
fi
# Back up only MBusiness state before applying additive migrations.
if [[ -f "$root/shared/data/cashier.sqlite" ]]; then
  install -d -m 0700 "$root/backups"
  backup="$root/backups/$(date -u +%Y%m%d-%H%M%S)-$release"
  python3 - "$root/shared/data/cashier.sqlite" "$backup.sqlite" <<'PYSQL'
import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as source, sqlite3.connect(sys.argv[2]) as target:source.backup(target)
PYSQL
  install -m 0600 "$root/shared/.env" "$backup.env"
fi
for link in "$root/runtime" "$root/current"; do
  [[ ! -e "$link" || -L "$link" ]] || { echo "Unexpected real directory at $link" >&2; exit 1; }
done
previous=$(readlink "$root/current" || true)
ln -sfn "$runtime" "$root/runtime"
ln -sfn "$release_dir" "$root/current"
install -m 0644 "$release_dir/ops/mbusiness.service" /etc/systemd/system/mbusiness.service
systemctl daemon-reload
systemctl enable mbusiness.service >/dev/null
if [[ "$mode" == deploy ]]; then systemctl enable mbusiness-proxy.service >/dev/null;fi
systemctl restart mbusiness.service
ready=false
for attempt in {1..20}; do
  if systemctl is-active --quiet mbusiness.service && curl --fail --silent http://127.0.0.1:3181/healthz >/dev/null && curl --fail --silent http://127.0.0.1:3181/ | grep -Fq MBusiness; then ready=true;break;fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  if [[ -n "$previous" && "$previous" == "$root/releases/"* ]]; then ln -sfn "$previous" "$root/current";systemctl restart mbusiness.service;fi
  echo 'MBusiness health check failed; existing MTaxi services were not changed.' >&2;exit 1
fi
if [[ "$mode" == prepare ]]; then
  echo 'MBusiness private backend is ready on 127.0.0.1:3181. Public HTTPS is not configured. Real banking remains disabled.'
  exit 0
fi
systemctl restart mbusiness-proxy.service
curl --fail --silent --show-error --resolve "$domain:$proxy_port:127.0.0.1" "$base_url/healthz"
echo "MBusiness deployed: $base_url; docs: $base_url/docs"
echo 'Retrieve the generated operator password privately from /srv/mbusiness/shared/.env; do not print it in Actions logs.'
