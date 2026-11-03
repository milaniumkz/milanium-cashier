// MBusiness terminal bridge. Node.js 24+. The bank/terminal adapter is supplied separately.
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { readFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function runAgent(config, { once = false, fetcher = fetch, signal } = {}) {
  const url = new URL(config.server);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  )
    throw new Error('Use HTTPS for the MBusiness server');
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !/^[A-Za-z0-9_-]{43}$/.test(config.token || '') ||
    !config.terminalId
  )
    throw new Error('Invalid terminal configuration');
  if (
    !config.adapter?.command ||
    !Array.isArray(config.adapter.args) ||
    !config.adapter.args.every((v) => typeof v === 'string')
  )
    throw new Error('Install and configure the bank adapter first');
  const db = new DatabaseSync(resolve(config.database || 'terminal-agent.sqlite'));
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,server TEXT NOT NULL,terminal_id TEXT NOT NULL,amount INTEGER NOT NULL,currency TEXT NOT NULL,state TEXT NOT NULL,result TEXT)',
  );
  try {
    chmodSync(resolve(config.database || 'terminal-agent.sqlite'), 0o600);
  } catch {} // Windows may use filesystem ACLs instead.
  const rpc = async (action, body) => {
    const r = await fetcher(new URL('/terminal-agent/' + action, url), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]),
    });
    if (!r.ok) throw new Error('Agent server request failed: ' + r.status);
    return r.json();
  };
  const adapter = (input) =>
    new Promise((done, reject) => {
      let output = '',
        settled = false;
      const child = spawn(config.adapter.command, config.adapter.args, {
        shell: false,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else done(result);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error('Adapter timed out; query bank status before another payment'));
      }, 90000);
      child.on('error', () => finish(new Error('Bank adapter could not start')));
      child.stdin.on('error', () => {});
      child.stdout.on('data', (bytes) => {
        output += bytes.toString();
        if (output.length > 65536) {
          child.kill();
          finish(new Error('Invalid adapter response'));
        }
      });
      child.on('close', (code) => {
        if (code !== 0) return finish(new Error('Bank adapter failed'));
        try {
          finish(null, JSON.parse(output));
        } catch {
          finish(new Error('Adapter must return JSON'));
        }
      });
      child.stdin.end(JSON.stringify(input));
    });
  try {
    const info = await adapter({ operation: 'describe', protocol: 1, device: config.device || {} });
    if (
      info.protocol !== 1 ||
      info.ready !== true ||
      typeof info.driver !== 'string' ||
      !Array.isArray(info.operations) ||
      !['pay', 'status'].every((v) => info.operations.includes(v)) ||
      info.currency !== 'KZT'
    )
      throw new Error('Bank adapter is not ready');
    if (info.testMode === true && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      throw new Error('A test adapter cannot be used against a live server');
    do {
      try {
        const { command: c } = await rpc('poll', { protocol: 1, ready: true, driver: info.driver });
        if (c) {
          if (
            c.terminalId !== config.terminalId ||
            !Number.isSafeInteger(c.amount) ||
            c.amount <= 0 ||
            c.currency !== 'KZT' ||
            !['pay', 'status'].includes(c.operation)
          )
            throw new Error('Invalid server command');
          let row = db.prepare('SELECT * FROM operations WHERE id=?').get(c.id);
          if (
            row &&
            (row.server !== url.origin ||
              row.terminal_id !== c.terminalId ||
              row.amount !== c.amount ||
              row.currency !== c.currency)
          )
            throw new Error('Command identity changed');
          let result = row?.result ? JSON.parse(row.result) : null;
          if (!result || result.status === 'unknown') {
            const operation = row ? 'status' : c.operation;
            if (!row) {
              db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,'INFLIGHT',NULL)").run(
                c.id,
                url.origin,
                c.terminalId,
                c.amount,
                c.currency,
              );
              row = { state: 'INFLIGHT' };
            }
            try {
              const r = await adapter({
                ...c,
                operation,
                protocol: 1,
                device: config.device || {},
              });
              if (
                !['approved', 'declined', 'unknown'].includes(r.status) ||
                r.id !== c.id ||
                r.amount !== c.amount ||
                r.currency !== c.currency ||
                (r.status === 'approved' && !['card', 'mobile'].includes(r.paymentKind)) ||
                (r.status !== 'unknown' &&
                  (typeof r.bankReference !== 'string' ||
                    !r.bankReference.trim() ||
                    r.bankReference.length > 150))
              )
                throw new Error('Bank result does not match payment');
              result = {
                id: c.id,
                status: r.status,
                amount: c.amount,
                currency: c.currency,
                ...(r.status !== 'unknown' ? { bankReference: r.bankReference } : {}),
                ...(r.status === 'approved' ? { paymentKind: r.paymentKind } : {}),
              };
            } catch {
              result = { id: c.id, status: 'unknown', amount: c.amount, currency: c.currency };
            }
            db.prepare('UPDATE operations SET state=?,result=? WHERE id=?').run(
              result.status,
              JSON.stringify(result),
              c.id,
            );
          }
          await rpc('result', result);
        }
      } catch (error) {
        if (once || signal?.aborted) throw error;
        console.error(
          'Connection/result unavailable. Payment journal retained; only status checks will be repeated.',
        );
      }
      if (!once && !signal?.aborted) await new Promise((done) => setTimeout(done, 3000));
    } while (!once && !signal?.aborted);
  } finally {
    db.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const path = process.argv[2];
    if (!path) throw new Error('Usage: node terminal-agent.mjs configuration.json');
    let config;
    try {
      config = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new Error('Configuration file is missing or is not valid JSON');
    }
    try {
      chmodSync(path, 0o600);
    } catch {}
    await runAgent(config, { once: process.argv.includes('--once') });
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
