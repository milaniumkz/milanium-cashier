import path from 'node:path';
import { z } from 'zod';

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const key = Buffer.from(env.ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be base64 of 32 bytes. Run npm run init.');
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 24) throw new Error('ADMIN_PASSWORD must contain at least 24 characters.');
  const mode = z.enum(['sandbox', 'android']).parse(env.DRIVER_MODE || 'sandbox');
  const base = new URL(env.PUBLIC_BASE_URL || 'http://127.0.0.1:3080');
  if (base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new Error('PUBLIC_BASE_URL must be an origin.');
  if (production && base.protocol !== 'https:') throw new Error('Production requires HTTPS PUBLIC_BASE_URL.');
  if (production && mode !== 'android') throw new Error('Sandbox must not run with NODE_ENV=production.');
  const appium = new URL(env.APPIUM_URL || 'http://127.0.0.1:4723');
  if (!['http:','https:'].includes(appium.protocol) || appium.username || appium.password || appium.search || appium.hash) throw new Error('Invalid APPIUM_URL');
  return {
    production, mode, key, adminPassword: env.ADMIN_PASSWORD,
    baseUrl: base.origin, host: env.HOST || '127.0.0.1', port: Number(env.PORT || 3080),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    connectorPath: path.resolve(env.CONNECTOR_CONFIG || './config/android.live.json'),
    appiumUrl: appium.href.replace(/\/$/, ''),
    liveEnabled: env.LIVE_AUTOMATION_ENABLED === 'true',
    pollMs: Math.max(1000, Number(env.POLL_INTERVAL_MS || 15000)),
    webhookOrigins: (env.WEBHOOK_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  };
}

export const invoiceSchema = z.object({
  order_id: z.string().min(1).max(100).regex(/^[\p{L}\p{N}_.:-]+$/u),
  amount: z.number().int().min(1).max(99_999_999),
  currency: z.literal('KZT').default('KZT'),
  method: z.enum(['phone', 'qr']),
  customer_phone: z.string().regex(/^\+7\d{10}$/).optional(),
  description: z.string().max(200).default(''),
}).strict().refine(v => v.method !== 'phone' || !!v.customer_phone, { message: 'Для счёта по телефону нужен customer_phone в формате +7XXXXXXXXXX' });

export const merchantSchema = z.object({
  name: z.string().trim().min(2).max(100),
  account_label: z.string().trim().min(2).max(150),
  webhook_url: z.union([z.url().max(500), z.literal('')]).default(''),
}).strict();
