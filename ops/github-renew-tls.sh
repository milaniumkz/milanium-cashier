#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ ${RENEWED_LINEAGE:-} == /etc/mbusiness/acme/live/mbusiness ]] || exit 1
root=/srv/mbusiness
[[ -f "$root/.mbusiness-owned" && -d "$root/shared/proxy/tls" ]] || exit 1
for file in fullchain.pem privkey.pem;do
 [[ ! -L "$root/shared/proxy/tls/$file" ]] || exit 1
 install -o mbusiness -g mbusiness -m 0600 "$RENEWED_LINEAGE/$file" "$root/shared/proxy/tls/$file"
done
systemctl reload mbusiness-proxy.service
