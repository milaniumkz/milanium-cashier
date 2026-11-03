import { request } from 'undici';
import { createHash } from 'node:crypto';
import { AppError } from './db.js';
export function registerTerminalAgentGateway(app, { config }) {
  for (const action of ['poll', 'result'])
    app.post(
      '/terminal-agent/' + action,
      {
        config: {
          rateLimit: {
            max: 90,
            timeWindow: '1 minute',
            keyGenerator: (r) =>
              createHash('sha256')
                .update(String(r.headers.authorization || r.ip))
                .digest('hex'),
          },
        },
      },
      async (r, reply) => {
        const token = r.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
        if (!token) throw new AppError('TERMINAL_AUTH_REQUIRED', 'Нужен ключ терминала.', 401);
        if (!config.accountingUrl || !config.accountingBridgeSecret)
          throw new AppError('ACCOUNTING_UNAVAILABLE', 'Учёт недоступен.', 503);
        const response = await request(
          new URL('/internal/retail/terminal/' + action, config.accountingUrl),
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-mbusiness-bridge-key': config.accountingBridgeSecret,
              'x-retail-terminal-token': token,
            },
            body: JSON.stringify(r.body),
            headersTimeout: 10000,
            bodyTimeout: 15000,
          },
        );
        return reply.code(response.statusCode).send(await response.body.json());
      },
    );
}
