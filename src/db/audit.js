import { prepare } from './mysql.js';

/**
 * Le journal d'audit, en base.
 *
 * Il double le fichier `logs/audit.log` plutôt que de le remplacer : le fichier reste
 * la trace longue, la base sert à chercher et à filtrer.
 *
 * L'écriture est asynchrone et NE LÈVE JAMAIS — comme auparavant. Journaliser ne doit
 * ni ralentir une requête, ni la faire échouer : un agent ne doit pas voir sa
 * publication refusée parce que le journal était indisponible. `recordEvent` rend
 * quand même sa promesse, pour qui veut attendre l'écriture — un test, par exemple.
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
export async function recordEvent(entry) {
  try {
    await prepare(
      `INSERT INTO audit_events (at, user_id, username, display_name, role, action, family, server_id, domain, target, ok, error, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.at ?? Date.now(),
      entry.userId ?? null,
      texte(entry.username, 80) ?? '',
      texte(entry.displayName, 120) ?? '',
      texte(entry.role, 60) ?? '',
      texte(entry.action, 80) ?? '',
      familyOf(entry.action),
      texte(entry.server, 60),
      texte(entry.domain, 190),
      texte(entry.target, 400),
      entry.ok === false ? 0 : 1,
      texte(entry.error, 300),
      texte(entry.ip, 45),
    );
  } catch (err) {
    console.error(`[audit] enregistrement impossible : ${err.message}`);
  }
}

const LIGNE = (row) => ({
  id: row.id,
  at: Number(row.at),
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
 * Le caractère qui neutralise les jokers d'une recherche libre.
 *
 * Un point d'exclamation plutôt que l'antislash : en MySQL, l'antislash est DÉJÀ un
 * échappement à l'intérieur d'une chaîne, et « ESCAPE '\' » ne s'écrit pas tel quel.
 * Ce choix vaut dans les deux dialectes et se relit sans se demander combien
 * d'antislashs il faut.
 */
const ECHAP = '!';
const neutraliser = (q) => q.replace(/[!%_]/g, (c) => `${ECHAP}${c}`);

/**
 * Interroge le journal. Tous les critères se combinent, et chacun est facultatif.
 *
 * La recherche libre balaie l'auteur, l'action, le domaine et la cible : l'agent tape
 * un nom de domaine ou un bout de nom d'utilisateur sans avoir à choisir la colonne.
 */
export async function queryEvents({ user, action, family, server, domain, ok, from, to, search, page = 1, perPage = 50 } = {}) {
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
    const champs = ['username', 'display_name', 'action', 'domain', 'target'];
    ou.push(`(${champs.map((c) => `${c} LIKE ? ESCAPE '${ECHAP}'`).join(' OR ')})`);
    // Les jokers sont neutralisés : un agent qui cherche « 100 % » ne doit pas obtenir
    // tout le journal.
    const motif = `%${neutraliser(q)}%`;
    for (let i = 0; i < champs.length; i += 1) args.push(motif);
  }

  const where = ou.length ? `WHERE ${ou.join(' AND ')}` : '';
  const { total: brut } = await prepare(`SELECT COUNT(*) AS total FROM audit_events ${where}`).get(...args);
  const total = Number(brut);

  const taille = Math.min(Math.max(1, Number(perPage) || 50), MAX_PAGE);
  const pages = Math.max(1, Math.ceil(total / taille));
  const courante = Math.min(Math.max(1, Number(page) || 1), pages);

  // LIMIT et OFFSET sont interpolés après avoir été ramenés à des entiers : MySQL
  // refuse de les recevoir comme paramètres liés dans une requête préparée.
  const limite = Number(taille);
  const saut = Number((courante - 1) * taille);
  const rows = await prepare(
    `SELECT * FROM audit_events ${where} ORDER BY at DESC, id DESC LIMIT ${limite} OFFSET ${saut}`,
  ).all(...args);

  return { events: rows.map(LIGNE), total, page: courante, pages, perPage: taille };
}

/** De quoi remplir les listes déroulantes : seulement ce qui figure vraiment au journal. */
export async function eventFacets() {
  // Chaque colonne non groupée est agrégée : une installation réglée en
  // ONLY_FULL_GROUP_BY — c'est le défaut de MySQL 5.7 et suivants — refuserait la
  // requête autrement, et l'écran d'audit tomberait là où il marchait en local.
  const [users, actions, span] = await Promise.all([
    prepare(
      `SELECT MAX(user_id) AS id, username, MAX(display_name) AS displayName, COUNT(*) AS count
       FROM audit_events WHERE username <> '' GROUP BY username ORDER BY count DESC`,
    ).all(),
    prepare('SELECT action, MAX(family) AS family, COUNT(*) AS count FROM audit_events GROUP BY action ORDER BY count DESC').all(),
    prepare('SELECT MIN(at) AS first, MAX(at) AS last FROM audit_events').get(),
  ]);

  return {
    users: users.map((r) => ({ id: r.id, username: r.username, displayName: r.displayName, count: Number(r.count) })),
    actions: actions.map((r) => ({ action: r.action, family: r.family, count: Number(r.count) })),
    span: { first: span?.first == null ? null : Number(span.first), last: span?.last == null ? null : Number(span.last) },
  };
}

/**
 * Efface les événements trop anciens.
 *
 * Un journal qui grossit sans fin finit par ne plus être consulté. La durée est réglée
 * par `AUDIT_RETENTION_DAYS` ; à 0, rien n'est effacé. Le fichier `audit.log`, lui,
 * n'est jamais touché : il reste la trace longue.
 */
export async function purgeOlderThan(days) {
  const jours = Number(days);
  if (!Number.isFinite(jours) || jours <= 0) return 0;
  const limite = Date.now() - jours * 86400000;
  const { changes } = await prepare('DELETE FROM audit_events WHERE at < ?').run(limite);
  return Number(changes) || 0;
}

export const countEvents = async () => Number((await prepare('SELECT COUNT(*) AS n FROM audit_events').get()).n);
