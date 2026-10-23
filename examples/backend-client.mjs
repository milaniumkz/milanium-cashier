// Server-side only. Do not bundle CASHIER_API_KEY into a mobile application.
const origin = process.env.CASHIER_URL || 'http://127.0.0.1:3080';
const apiKey = process.env.CASHIER_API_KEY;
if (!apiKey) throw new Error('Set CASHIER_API_KEY');
// In your app, calculate the amount from your own trusted order database.
const r = await fetch(`${origin}/v1/invoices`, {
  method:'POST',
  headers:{'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`,'Idempotency-Key':'order-example-1001'},
  body:JSON.stringify({order_id:'example-1001',amount:15000,currency:'KZT',method:'qr',description:'Пример оплаты'}),
});
const invoice = await r.json();
if (!r.ok) throw new Error(JSON.stringify(invoice));
console.log(invoice);
