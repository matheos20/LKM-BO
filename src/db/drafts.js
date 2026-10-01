import { prepare } from './mysql.js';

/**
 * Brouillons de design et de contenu.
 *
 * Ils vivent dans la base du back-office, jamais sur le serveur du site : tant que
 * l'utilisateur n'a pas publié, le site en production n'est pas touché d'un octet.
 * `base_hash` mémorise l'empreinte du fichier au moment où le brouillon a commencé,
 * ce qui permet de détecter une modification concurrente avant d'écrire.
 *
 * Toutes les fonctions sont ASYNCHRONES depuis le passage à MySQL : le pilote ne rend
 * plus la valeur sur place. Le `await` remonte jusqu'à SiteService, qui était déjà
 * asynchrone partout sauf à un endroit.
 */

/**
 * Les quatre colonnes qui identifient un brouillon sont bornées en longueur.
 *
 * Elles sont taillées ICI, du même coup pour la lecture et pour l'écriture. C'est le
 * point à ne pas rater : tailler à l'enregistrement sans tailler à la recherche ferait
 * disparaître le brouillon dès que le chemin dépasse la borne — enregistré sous un nom,
 * cherché sous un autre. Le plus long chemin d'article du parc fait 65 caractères, loin
 * des 190 permis ; la borne protège d'un cas extrême, elle n'en crée pas.
 */
const cle = (server, domain, kind, target) => [
  String(server ?? '').slice(0, 60),
  String(domain ?? '').slice(0, 190),
  String(kind ?? 'site').slice(0, 20),
  String(target ?? '').slice(0, 190),
];

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
    previewAt: r.preview_at === null ? null : Number(r.preview_at),
    createdBy: r.created_by,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };

export async function getDraft(server, domain, kind = 'site', target = '') {
  return row(
    await prepare('SELECT * FROM site_drafts WHERE server_id = ? AND domain = ? AND kind = ? AND target = ?').get(...cle(server, domain, kind, target)),
  );
}

export async function listDrafts({ server, domain } = {}) {
  const rows = domain
    ? await prepare('SELECT * FROM site_drafts WHERE server_id = ? AND domain = ? ORDER BY updated_at DESC').all(
        String(server ?? '').slice(0, 60),
        String(domain).slice(0, 190),
      )
    : await prepare('SELECT * FROM site_drafts ORDER BY updated_at DESC LIMIT 200').all();
  return rows.map(row);
}

export async function saveDraft({ server, domain, kind = 'site', target = '', data, baseHash, userId }) {
  const now = Date.now();
  const ident = cle(server, domain, kind, target);
  // MySQL ne connaît pas « ON CONFLICT … excluded » : la forme équivalente nomme la
  // contrainte par ses colonnes et relit la valeur proposée avec VALUES(col).
  await prepare(
    `INSERT INTO site_drafts (server_id, domain, kind, target, data, base_hash, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE data = VALUES(data), base_hash = VALUES(base_hash), updated_at = VALUES(updated_at)`,
  ).run(...ident, JSON.stringify(data), String(baseHash ?? '').slice(0, 64), userId ?? null, now, now);
  return getDraft(server, domain, kind, target);
}

export async function setDraftPreview(id, token) {
  await prepare('UPDATE site_drafts SET preview_token = ?, preview_at = ? WHERE id = ?').run(String(token ?? '').slice(0, 64), Date.now(), id);
}

export async function deleteDraft(server, domain, kind = 'site', target = '') {
  const r = await prepare('DELETE FROM site_drafts WHERE server_id = ? AND domain = ? AND kind = ? AND target = ?').run(...cle(server, domain, kind, target));
  return r.changes;
}
