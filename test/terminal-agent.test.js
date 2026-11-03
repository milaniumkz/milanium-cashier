import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { runAgent } from '../public/terminal-agent.mjs';

test('Terminal agent journals a completed bank result before callback and replays only that result after network loss', async (t) => {
  const dir = await mkdtemp('/tmp/mbusiness-agent-test-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const adapter = dir + '/adapter.mjs',
    calls = dir + '/calls.jsonl';
  await writeFile(
    adapter,
    `import {appendFileSync} from 'node:fs';let raw='';for await(const s of process.stdin)raw+=s;const r=JSON.parse(raw);appendFileSync(${JSON.stringify(calls)},JSON.stringify(r)+'\\n');console.log(JSON.stringify(r.operation==='describe'?{protocol:1,ready:true,driver:'synthetic-adapter',currency:'KZT',operations:['pay','status'],testMode:true}:{id:r.id,amount:r.amount,currency:r.currency,status:'approved',paymentKind:'card',bankReference:'synthetic-bank-id',cardNumber:'this-field-must-not-be-stored'}));`,
  );
  let poll = 0,
    results = 0;
  const fetcher = async (url, options) => {
    if (url.pathname.endsWith('/poll')) {
      poll++;
      return {
        ok: true,
        json: async () => ({
          command: {
            id: 'synthetic-command',
            terminalId: 'synthetic-terminal',
            operation: poll === 1 ? 'pay' : 'status',
            amount: 10000,
            currency: 'KZT',
          },
        }),
      };
    }
    results++;
    if (results === 1) throw new Error('Synthetic lost callback');
    const b = JSON.parse(options.body);
    assert.equal(b.cardNumber, undefined);
    return { ok: true, json: async () => ({ state: 'COMPLETED' }) };
  };
  const config = {
    server: 'http://127.0.0.1',
    terminalId: 'synthetic-terminal',
    token: randomBytes(32).toString('base64url'),
    database: dir + '/journal.sqlite',
    adapter: { command: process.execPath, args: [adapter] },
  };
  await assert.rejects(runAgent(config, { once: true, fetcher }), /Synthetic lost callback/);
  await runAgent(config, { once: true, fetcher });
  const callsList = (await readFile(calls, 'utf8'))
    .trim()
    .split('\n')
    .map((v) => JSON.parse(v));
  assert.equal(callsList.filter((v) => v.operation === 'pay').length, 1);
  assert.equal(callsList.filter((v) => v.operation === 'status').length, 0);
  assert.equal(results, 2);
  assert.equal(
    (await readFile(config.database)).includes(Buffer.from('this-field-must-not-be-stored')),
    false,
  );
});
test('Terminal agent refuses unencrypted external origins and missing bank drivers', async () => {
  const token = randomBytes(32).toString('base64url');
  await assert.rejects(
    runAgent({ server: 'http://example.com', terminalId: 'fixture', token }),
    /HTTPS/,
  );
  await assert.rejects(
    runAgent({
      server: 'https://example.com',
      terminalId: 'fixture',
      token,
      adapter: { command: '', args: [] },
    }),
    /bank adapter/,
  );
});
