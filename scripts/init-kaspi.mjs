import { writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (existsSync('.env.kaspi')) {
  console.log('.env.kaspi already exists; preserved without changes.');
} else {
  writeFileSync('.env.kaspi', `NODE_ENV=development
HOST=127.0.0.1
PORT=3081
PUBLIC_BASE_URL=http://127.0.0.1:3081
DATA_DIR=./data-kaspi
ADMIN_PASSWORD=${randomBytes(24).toString('base64url')}
ENCRYPTION_KEY=${randomBytes(32).toString('base64')}
DRIVER_MODE=kaspi
LIVE_AUTOMATION_ENABLED=false
POLL_INTERVAL_MS=5000
WEBHOOK_ALLOWED_ORIGINS=
`, { mode: 0o600, flag: 'wx' });
  console.log('Created .env.kaspi (0600), separate data directory and independent local credentials. Credentials were not printed. Real operations remain disabled.');
}
