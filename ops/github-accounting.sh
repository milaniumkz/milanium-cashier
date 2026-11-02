#!/usr/bin/env bash
# Isolated accounting database/API for MBusiness. Never operates on MTaxi resources.
set -euo pipefail
umask 077
release_dir=${1:?release directory}
root=/srv/mbusiness
[[ $(id -u) == 0 && "$release_dir" =~ ^/srv/mbusiness/releases/[a-f0-9]{40}$ && -f "$root/.mbusiness-owned" ]] || exit 1
[[ -f "$release_dir/modules/muchet/build/web/main.dart.js" ]] || { echo 'Accounting UI artifact missing';exit 1; }
command -v docker >/dev/null || { echo 'Docker is required; no daemon or MTaxi packages will be changed.';exit 1; }
container=mbusiness-accounting-db
state="$root/shared/accounting"
if [[ -e "$state" ]];then
 [[ -f "$state/.mbusiness-accounting-owned" && ! -L "$state" ]] || { echo 'Accounting directory not owned by this installer';exit 1; }
else
 ! systemctl cat mbusiness-accounting.service >/dev/null 2>&1 || { echo 'Existing accounting unit without ownership marker';exit 1; }
 [[ -z $(ss -H -ltn 'sport = :55439') && -z $(ss -H -ltn 'sport = :3191') ]] || { echo 'Dedicated accounting port occupied';exit 1; }
 ! docker container inspect "$container" >/dev/null 2>&1 || { echo 'Existing accounting container without ownership marker';exit 1; }
 install -d -m 0700 "$state"
 touch "$state/.mbusiness-accounting-owned"
fi
for own_path in "$state/database.env" "$state/api.env" "$state/init.sql" "$state/postgres" "$state/files";do
 [[ ! -L "$own_path" ]] || { echo 'Unexpected symlink in accounting state';exit 1; }
done
python3 - "$state" "$root/shared/.env" <<'PY'
import pathlib,secrets,sys
state=pathlib.Path(sys.argv[1]);main=pathlib.Path(sys.argv[2])
if not (state/'database.env').exists():
 admin=secrets.token_hex(32);app=secrets.token_hex(32);bridge=secrets.token_hex(32)
 (state/'database.env').write_text(f'POSTGRES_USER=mbusiness_db_admin\nPOSTGRES_PASSWORD={admin}\nPOSTGRES_DB=mbusiness_accounting\n')
 (state/'init.sql').write_text(f"BEGIN;\nCREATE ROLE mbusiness_app LOGIN PASSWORD '{app}';\nALTER SCHEMA public OWNER TO mbusiness_app;\nGRANT CONNECT ON DATABASE mbusiness_accounting TO mbusiness_app;\nCOMMIT;\n")
 (state/'api.env').write_text(f'APP_ENV=production\nHOST=127.0.0.1\nPORT=3191\nDATA_DIR=/srv/mbusiness/shared/accounting/files\nDATABASE_URL=postgresql://mbusiness_app:{app}@127.0.0.1:55439/mbusiness_accounting\nMBUSINESS_BRIDGE_SECRET={bridge}\n')
else:
 api=(state/'api.env').read_text();bridge=next(line.split('=',1)[1] for line in api.splitlines() if line.startswith('MBUSINESS_BRIDGE_SECRET='))
text=main.read_text()
updates={'ACCOUNTING_URL':'http://127.0.0.1:3191','ACCOUNTING_BRIDGE_SECRET':bridge,'ACCOUNTING_WEB_ROOT':'/srv/mbusiness/current/modules/muchet/build/web'}
lines=[l for l in text.splitlines() if l.split('=',1)[0] not in updates]
main.write_text('\n'.join(lines+[k+'='+v for k,v in updates.items()])+'\n')
for name in ['database.env','api.env','init.sql']:
 p=state/name
 if p.exists():p.chmod(0o600)
PY
install -d -o mbusiness -g mbusiness -m 0700 "$state/files"
chown mbusiness:mbusiness "$state/api.env"
# Only the service can read its API environment, not the database admin environment.
chown mbusiness:mbusiness "$state"
if docker container inspect "$container" >/dev/null 2>&1;then
 [[ $(docker inspect -f '{{index .Config.Labels "com.mbusiness.owner"}}' "$container") == mbusiness-accounting-v1 ]] || exit 1
 [[ $(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}' "$container") == "$state/postgres" ]] || exit 1
 [[ $(docker inspect -f '{{(index (index .HostConfig.PortBindings "5432/tcp") 0).HostIp}}:{{(index (index .HostConfig.PortBindings "5432/tcp") 0).HostPort}}' "$container") == '127.0.0.1:55439' ]] || exit 1
 if [[ $(docker inspect -f '{{.State.Running}}' "$container") != true ]];then docker start "$container" >/dev/null;fi
else
 [[ -z $(ss -H -ltn 'sport = :55439') ]] || exit 1
 docker pull postgres:17-bookworm@sha256:839fbb5a4942a7758dd93e18b42ea5649807491a0545b5eeeb8f0b8bb11857a5 >/dev/null
 install -d -m 0700 "$state/postgres"
 docker run -d --name "$container" --label com.mbusiness.owner=mbusiness-accounting-v1 --restart unless-stopped --memory 512m --cpus .75 --log-opt max-size=10m --log-opt max-file=3 --env-file "$state/database.env" -p 127.0.0.1:55439:5432 --mount "type=bind,src=$state/postgres,dst=/var/lib/postgresql/data" postgres:17-bookworm@sha256:839fbb5a4942a7758dd93e18b42ea5649807491a0545b5eeeb8f0b8bb11857a5 >/dev/null
fi
ready=false
for attempt in {1..30};do if docker exec "$container" pg_isready -U mbusiness_db_admin -d mbusiness_accounting >/dev/null 2>&1;then ready=true;break;fi;sleep 1;done
[[ "$ready" == true ]] || { echo 'Accounting PostgreSQL not ready';exit 1; }
if [[ -f "$state/init.sql" ]];then
 docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U mbusiness_db_admin -d mbusiness_accounting < "$state/init.sql" >/dev/null
 rm "$state/init.sql"
fi
install -d -m 0700 "$root/backups"
docker exec "$container" pg_dump -U mbusiness_db_admin -d mbusiness_accounting -Fc > "$root/backups/accounting-$(date -u +%Y%m%d-%H%M%S).dump"
install -m 0644 "$release_dir/ops/mbusiness-accounting.service" /etc/systemd/system/mbusiness-accounting.service
systemctl daemon-reload
systemctl enable mbusiness-accounting.service >/dev/null
systemctl restart mbusiness-accounting.service
ready=false
for attempt in {1..30};do if curl --fail --silent http://127.0.0.1:3191/health >/dev/null;then ready=true;break;fi;sleep 1;done
[[ "$ready" == true ]] || { echo 'Accounting API health check failed';exit 1; }
echo 'Isolated MBusiness accounting database and API ready.'
