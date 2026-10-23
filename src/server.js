import { openSync, closeSync, unlinkSync, readFileSync, writeSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { buildApp } from './app.js';

process.umask(0o077);
const config = loadConfig();
await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
// This SQLite edition supports one service process. Maintenance CLI requires it to stop.
const lock = path.join(config.dataDir, 'server.lock');
let fd;
try { fd = openSync(lock, 'wx', 0o600); }
catch {
  let pid;
  try { pid = Number(readFileSync(lock, 'utf8')); } catch {}
  let alive = true;
  try { if (!Number.isInteger(pid) || pid < 1) throw new Error('invalid'); process.kill(pid, 0); }
  catch (e) { alive = e.code !== 'ESRCH'; }
  if (alive) throw new Error('Another server may own this DATA_DIR. Do not run multiple replicas.');
  unlinkSync(lock); fd = openSync(lock, 'wx', 0o600);
}
writeSync(fd, String(process.pid));
const cleanup = () => { try { closeSync(fd); unlinkSync(lock); } catch {} };
process.once('exit', cleanup);
const app = await buildApp(config);
await app.listen({ host: config.host, port: config.port });
let stopping = false;
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => {
  if (stopping) return; stopping = true;
  const force = setTimeout(() => process.exit(1), 60_000).unref();
  await app.close(); clearTimeout(force); process.exit(0);
});
