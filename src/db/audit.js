import { getDb } from './database.js';

/**
 * Le journal d'audit, en base.
 *
 * Il double le fichier `logs/audit.log` plutôt que de le remplacer : le fichier reste
 * une trace brute, ajoutée ligne à ligne, qui survit à une remise à zéro de la base ;
 * la base, elle, est la seule forme qu'on puisse filtrer, chercher et paginer. Sur 703
 * lignes le fichier se lit encore ; sur un an d'exploitation du parc, non.
 *
 * Deux choix à connaître avant de toucher à ce module :
 *
 *   - AUCUNE CLÉ ÉTRANGÈRE vers `users`. Un événement doit survivre à la suppression du
 *     compte qu'il nomme, sans quoi effacer un compte effacerait ses traces — ce qui
 *     viderait le journal de son intérêt. Le nom et le rôle sont donc RECOPIÉS au
 *     moment des faits, et non joints après coup : ils disent qui agissait alors, même
 *     si le compte a changé de rôle ou n'existe plus.
 *   - L'ÉCRITURE NE DOIT JAMAIS FAIRE ÉCHOUER L'ACTION. Journaliser est second ; si
 *     l'insertion échoue, on le signale dans la console et on laisse passer.
 */

/**
 * La famille d'une action, d'où vient sa couleur : créer en vert, modifier en orange,
 * supprimer en rouge. Elle se déduit du nom de l'action plutôt que d'être déclarée à
 * côté, pour qu'une action ajoutée demain soit rangée sans qu'on y pense.
 *
 * L'ordre compte : « supprimer » passe avant tout le reste, parce qu'une action qui
 * supprime ne doit jamais se retrouver en vert par accident.
 */
const FAMILLES = [
  ['delete', /(^|[._])(delete|remove|rm|destroy|revoke|purge)([._]|$)/],
  ['create', /(^|[._])(create|add|new|upload|mkdir|extract|compress|import)([._]|$)/],
  ['auth', /(^|[._])(login|logout|connect|disconnect)([._]|$)/],
  ['read', /(^|[._])(read|list|preview|download|download_zip|search|scan|export)([._]|$)/],
  ['update', /(^|[._])(update|save|edit|rename|move|draft|publish|apply|restore|password|lock|unlock|fix_perms|templates|image|patch)([._]|$)/],
];

/** @returns {'create'|'update'|'delete'|'auth'|'read'|'other'} */
export function familyOf(action) {
  const cle = String(action ?? '').toLowerCase();
  for (const [famille, motif] of FAMILLES) if (motif.test(cle)) return famille;
  return 'other';
}

const texte = (v, max = 400) => (v == null ? null : String(v).slice(0, max));

/** Enregistre un événement. Ne lève jamais : journaliser ne doit rien casser. */
export function recordEvent(entry) {
  try {
    getDb()
      .prepare(
        `INSERT INTO audit_events (at, user_id, username, display_name, role, action, family, server_id, domain, target, ok, error, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.at ?? Date.now(),
        entry.userId ?? null,
        texte(entry.username, 80) ?? '',
        texte(entry.displayName, 120) ?? '',
        texte(entry.role, 60) ?? '',
        texte(entry.action, 80) ?? '',
        familyOf(entry.action),
        texte(entry.server, 60),
        texte(entry.domain, 253),
        texte(entry.target),
        entry.ok === false ? 0 : 1,
        texte(entry.error, 300),
        texte(entry.ip, 60),
      );
  } catch (err) {
    console.error(`[audit] enregistrement impossible : ${err.message}`);
  }
}

const LIGNE = (row) => ({
  id: row.id,
  at: row.at,
  user: row.username ? { id: row.user_id, username: row.username, displayName: row.display_name, role: row.role } : null,
  action: row.action,
  family: row.family,
  server: row.server_id,
  domain: row.domain,
  target: row.target,
  ok: Boolean(row.ok),
  error: row.error,
  ip: row.ip,
});

const MAX_PAGE = 200;

/**
 * Interroge le journal. Tous les critères se combinent, et chacun est facultatif.
 *
 * La recherche libre balaie l'auteur, l'action, le domaine et la cible : l'agent tape
 * un nom de domaine ou un bout de nom d'utilisateur sans avoir à choisir la colonne.
 */
export function queryEvents({ user, action, family, server, domain, ok, from, to, search, page = 1, perPage = 50 } = {}) {
  const ou = [];
  const args = [];

  if (user) {
    ou.push('(user_id = ? OR username = ?)');
    args.push(Number(user) || 0, String(user));
  }
  if (action) {
    ou.push('action = ?');
    args.push(String(action));
  }
  if (family) {
    ou.push('family = ?');
    args.push(String(family));
  }
  if (server) {
    ou.push('server_id = ?');
    args.push(String(server));
  }
  if (domain) {
    ou.push('domain = ?');
    args.push(String(domain));
  }
  if (ok === true || ok === false) {
    ou.push('ok = ?');
    args.push(ok ? 1 : 0);
  }
  if (Number.isFinite(from)) {
    ou.push('at >= ?');
    args.push(from);
  }
  if (Number.isFinite(to)) {
    ou.push('at <= ?');
    args.push(to);
  }
  const q = String(search ?? '').trim();
  if (q) {
    ou.push('(username LIKE ? OR display_name LIKE ? OR action LIKE ? OR domain LIKE ? OR target LIKE ?)');
    // Les jokers de LIKE sont neutralisés : un agent qui cherche « 100 % » ne doit pas
    // obtenir tout le journal.
    const motif = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    args.push(motif, motif, motif, motif, motif);
  }

  const filtre = ou.length ? `WHERE ${ou.join(' AND ')}` : '';
  const echappe = q ? " ESCAPE '\\'" : '';
  const where = filtre.replace(/LIKE \?/g, `LIKE ?${echappe}`);

  const db = getDb();
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM audit_events ${where}`).get(...args);

  const taille = Math.min(Math.max(1, Number(perPage) || 50), MAX_PAGE);
  const pages = Math.max(1, Math.ceil(total / taille));
  const courante = Math.min(Math.max(1, Number(page) || 1), pages);

  const rows = db
    .prepare(`SELECT * FROM audit_events ${where} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, taille, (courante - 1) * taille);

  return { events: rows.map(LIGNE), total, page: courante, pages, perPage: taille };
}

/** De quoi remplir les listes déroulantes : seulement ce qui figure vraiment au journal. */
export function eventFacets() {
  const db = getDb();
  return {
    users: db
      .prepare(
        `SELECT user_id AS id, username, MAX(display_name) AS displayName, COUNT(*) AS count
         FROM audit_events WHERE username <> '' GROUP BY username ORDER BY count DESC`,
      )
      .all()
      .map((r) => ({ id: r.id, username: r.username, displayName: r.displayName, count: r.count })),
    actions: db.prepare('SELECT action, family, COUNT(*) AS count FROM audit_events GROUP BY action ORDER BY count DESC').all(),
    span: db.prepare('SELECT MIN(at) AS first, MAX(at) AS last FROM audit_events').get(),
  };
}

/**
 * Efface les événements trop anciens.
 *
 * Un journal qui grossit sans fin finit par ne plus être consulté. La durée est réglée
 * par `AUDIT_RETENTION_DAYS` ; à 0, rien n'est effacé. Le fichier `audit.log`, lui,
 * n'est jamais touché : il reste la trace longue.
 */
export function purgeOlderThan(days) {
  const jours = Number(days);
  if (!Number.isFinite(jours) || jours <= 0) return 0;
  const limite = Date.now() - jours * 86400000;
  const { changes } = getDb().prepare('DELETE FROM audit_events WHERE at < ?').run(limite);
  return Number(changes) || 0;
}

export const countEvents = () => getDb().prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
