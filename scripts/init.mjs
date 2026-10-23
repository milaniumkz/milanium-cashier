import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (existsSync('.env')) { console.error('.env already exists; no changes made.'); process.exit(1); }
mkdirSync('data', { recursive: true, mode: 0o700 });
const password = randomBytes(24).toString('base64url');
writeFileSync('.env', `NODE_ENV=development\nHOST=127.0.0.1\nPORT=3080\nPUBLIC_BASE_URL=http://127.0.0.1:3080\nDATA_DIR=./data\nADMIN_PASSWORD=${password}\nENCRYPTION_KEY=${randomBytes(32).toString('base64')}\nDRIVER_MODE=sandbox\nCONNECTOR_CONFIG=./config/android.live.json\nLIVE_AUTOMATION_ENABLED=false\nPOLL_INTERVAL_MS=5000\nWEBHOOK_ALLOWED_ORIGINS=\n`, { mode: 0o600, flag: 'wx' });
console.log('Created .env. Admin password (save securely):', password);
console.log('Run npm start, then open http://127.0.0.1:3080. Sandbox never contacts Kaspi.');
