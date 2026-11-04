import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, now } from './db.js';
import {registerBrowserPublisher} from './browser-publisher.js';

export {normalizeCommunityUrl} from './community-links.js';
import {normalizeCommunityUrl} from './community-links.js';

export function registerPublishingWeb(app, { store, member,config }) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS publishing_web_groups (
    id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id),
    network TEXT NOT NULL, url TEXT NOT NULL, name TEXT NOT NULL,
    actor_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(merchant_id, url)
  );`);
  registerBrowserPublisher(app,{store,config,member});
  const permission = name => async req => {
    await member(req);
    if (!req.member.is_owner && !req.member.permissions.includes(name)) throw new AppError('PERMISSION_DENIED', 'Недостаточно прав.', 403);
  };
  app.get('/account/publishing/web', { preHandler: permission('marketing.read') }, async req => ({
    mode: 'links', authenticated: false, automatic_publishing: false,
    items: db.prepare('SELECT id,network,url,name,created_at FROM publishing_web_groups WHERE merchant_id=? ORDER BY created_at DESC,id').all(req.company.id),
    sites: [{ network: 'vk', url: 'https://vk.com/' }, { network: 'ok', url: 'https://ok.ru/' }]
  }));
  app.post('/account/publishing/web/groups', { preHandler: permission('marketing.write') }, async req => {
    const body = z.object({ url: z.string().trim().max(500), name: z.string().trim().min(1).max(150), confirmed_rights: z.literal(true) }).strict().parse(req.body);
    const target = normalizeCommunityUrl(body.url);
    return store.transaction(() => {
      const prior = db.prepare('SELECT id,name FROM publishing_web_groups WHERE merchant_id=? AND url=?').get(req.company.id, target.url);
      if (prior) return { id: prior.id, ...target, replay: true, verified: false };
      if (db.prepare('SELECT COUNT(*) n FROM publishing_web_groups WHERE merchant_id=?').get(req.company.id).n >= 100) throw new AppError('COMMUNITY_LIMIT', 'Можно сохранить до 100 групп компании.', 409);
      const id = randomUUID();
      db.prepare('INSERT INTO publishing_web_groups VALUES(?,?,?,?,?,?,?)').run(id, req.company.id, target.network, target.url, body.name, req.member.id, now());
      store.audit(req.company.id, null, 'publishing.web_group_added', JSON.stringify({ actor: req.member.id, group: id, network: target.network }));
      return { id, ...target, replay: false, verified: false };
    });
  });
  app.delete('/account/publishing/web/groups/:id', { preHandler: permission('marketing.write') }, async req => {
    if(db.prepare("SELECT 1 FROM publishing_browser_jobs WHERE merchant_id=? AND group_id=? AND state IN ('scheduled','preparing','sending','unknown')").get(req.company.id,req.params.id))throw new AppError('COMMUNITY_IN_USE','Сначала завершите или отмените задания группы.',409);
    if(db.prepare('SELECT 1 FROM publishing_browser_jobs WHERE merchant_id=? AND group_id=?').get(req.company.id,req.params.id))throw new AppError('COMMUNITY_IN_USE','Группа используется в истории публикаций.',409);
    if (!db.prepare('DELETE FROM publishing_web_groups WHERE merchant_id=? AND id=?').run(req.company.id, req.params.id).changes) throw new AppError('NOT_FOUND', 'Группа не найдена.', 404);
    store.audit(req.company.id, null, 'publishing.web_group_removed', JSON.stringify({ actor: req.member.id, group: req.params.id }));
    return { ok: true };
  });
}
