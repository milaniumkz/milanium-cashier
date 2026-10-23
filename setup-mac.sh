#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [ "$(uname -s)" != "Darwin" ]; then
  echo 'Этот установщик предназначен для macOS.' >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo 'Нужен Node.js 24 или новее: https://nodejs.org/en/download'
  echo 'После установки откройте новое окно Terminal и повторите команду.'
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo 'npm не найден. Установите Node.js вместе с npm.' >&2
  exit 1
fi
npm ci --no-audit --no-fund
node scripts/mac.mjs prepare
node scripts/mac.mjs doctor
echo ''
echo 'Далее: npm run mac -- capture'
echo 'Откройте Kaspi Pay на Android и следуйте подсказкам. Счета не отправляются.'
