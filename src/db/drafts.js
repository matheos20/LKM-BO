import { getDb } from './database.js';

/**
 * Brouillons de design et de contenu.
 *
 * Ils vivent dans la base du back-office, jamais sur le serveur du site : tant que
 * l'utilisateur n'a pas publié, le site en production n'est pas touché d'un octet.
 * `base_hash` mémorise l'empreinte du fichier au moment où le brouillon a commencé,
 * ce qui permet de détecter une modification concurrente avant d'écrire.
 */

const row = (r) =>
  r && {
    id: r.id,
    server: r.server_id,
    domain: r.domain,
    kind: r.kind,
    target: r.target,
    data: JSON.parse(r.data),
    baseHash: r.base_hash,
    previewToken: r.preview_token,
    previewAt: r.preview_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

export function getDraft(server, domain, kind = 'site', target = '') {
  return row(getDb().prepare('SELECT * FROM site_drafts WHERE server_id = ? AND domain = ? AND kind = ? AND target = ?').get(server, domain, kind, target));
}

export function listDrafts({ server, domain } = {}) {
  const db = getDb();
  const rows = domain
    ? db.prepare('SELECT * FROM site_drafts WHERE server_id = ? AND domain = ? ORDER BY updated_at DESC').all(server, domain)
    : db.prepare('SELECT * FROM site_drafts ORDER BY updated_at DESC LIMIT 200').all();
  return rows.map(row);
}

export function saveDraft({ server, domain, kind = 'site', target = '', data, baseHash, userId }) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO site_drafts (server_id, domain, kind, target, data, base_hash, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id, domain, kind, target)
     DO UPDATE SET data = excluded.data, base_hash = excluded.base_hash, updated_at = excluded.updated_at`,
  ).run(server, domain, kind, target, JSON.stringify(data), baseHash ?? '', userId ?? null, now, now);
  return getDraft(server, domain, kind, target);
}

export function setDraftPreview(id, token) {
  getDb().prepare('UPDATE site_drafts SET preview_token = ?, preview_at = ? WHERE id = ?').run(token, Date.now(), id);
}

export function deleteDraft(server, domain, kind = 'site', target = '') {
  return getDb().prepare('DELETE FROM site_drafts WHERE server_id = ? AND domain = ? AND kind = ? AND target = ?').run(server, domain, kind, target).changes;
}
