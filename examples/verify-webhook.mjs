import { createHmac, timingSafeEqual } from 'node:crypto';

/** Pass the original raw request bytes BEFORE JSON parsing. */
export function verifyCashierWebhook(rawBody, headers, secret, nowSeconds = Math.floor(Date.now()/1000)) {
  const timestamp = headers['x-cashier-timestamp'];
  const signature = headers['x-cashier-signature'];
  if (!/^\d{10}$/.test(timestamp || '') || Math.abs(nowSeconds-Number(timestamp))>300) throw new Error('Timestamp outside 5 minute window');
  if (!/^v1=[a-f0-9]{64}$/.test(signature || '')) throw new Error('Invalid signature format');
  const expected = createHmac('sha256',secret).update(timestamp+'.').update(rawBody).digest();
  if (!timingSafeEqual(expected,Buffer.from(signature.slice(3),'hex'))) throw new Error('Invalid signature');
  const event = JSON.parse(rawBody.toString('utf8'));
  if (event.event_id !== headers['x-cashier-event']) throw new Error('Event ID mismatch');
  return event;
}
// Your handler must use a DB transaction: insert event_id with UNIQUE constraint,
// verify merchant/order/amount/currency, read authoritative GET /v1/invoices/:id,
// then mark the order fulfilled once. Acknowledge duplicates with HTTP 2xx.
// Out-of-order pending/unknown events MUST NOT downgrade an already paid order.
