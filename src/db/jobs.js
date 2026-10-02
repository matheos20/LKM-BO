import { prepare } from './mysql.js';

/**
 * Les tournées : un traitement de masse, écrit.
 *
 * Tout ce qui permet de reprendre tient dans la ligne : la liste des cibles est FIGÉE au
 * départ, et `done_count` dit combien ont été traitées. Reprendre, c'est repartir de
 * cette position — pas besoin de deviner ce qui restait à faire, ni de recommencer.
 *
 * Le nom de l'auteur est RECOPIÉ à côté de son identifiant. Une tournée dit qui l'a
 * lancée, même des mois plus tard, même si le compte a été supprimé depuis : c'est
 * exactement la règle du journal d'audit, et pour la même raison.
 */

/** Les états possibles, et ce qu'ils veulent dire. */
export const ETATS = {
  pending: 'en attente', // créée, pas encore prise par le serveur
  running: 'en cours',
  done: 'terminée',
  failed: 'échouée', // une erreur a interrompu la tournée elle-même
  cancelled: 'annulée', // un agent l'a arrêtée
};
/** Une tournée dans l'un de ces états ne bougera plus. */
export const TERMINES = ['done', 'failed', 'cancelled'];

const nombre = (v) => (v === null || v === undefined ? null : Number(v));

const ligne = (r) =>
  r && {
    id: r.id,
    kind: r.kind,
    label: r.label,
    params: JSON.parse(r.params || '{}'),
    total: Number(r.total),
    done: Number(r.done_count),
    ok: Number(r.ok_count),
    failed: Number(r.fail_count),
    status: r.status,
    error: r.error,
    by: { id: r.created_by, name: r.created_by_name },
    createdAt: Number(r.created_at),
    startedAt: nombre(r.started_at),
    finishedAt: nombre(r.finished_at),
    heartbeatAt: nombre(r.heartbeat_at),
  };

/** Les colonnes de l'état, sans la liste des cibles — elle pèse parfois un mégaoctet. */
const CHAMPS = `id, kind, label, params, total, done_count, ok_count, fail_count, status, error,
                created_by, created_by_name, created_at, started_at, finished_at, heartbeat_at`;

export async function createJob({ kind, label = '', params = {}, targets = [], userId = null, userName = '' }) {
  const now = Date.now();
  const r = await prepare(
    `INSERT INTO jobs (kind, label, params, targets, total, created_by, created_by_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    String(kind).slice(0, 40),
    String(label).slice(0, 190),
    JSON.stringify(params ?? {}),
    JSON.stringify(targets ?? []),
    targets.length,
    userId,
    String(userName).slice(0, 120),
    now,
  );
  return getJob(r.lastInsertRowid);
}

export async function getJob(id) {
  return ligne(await prepare(`SELECT ${CHAMPS} FROM jobs WHERE id = ?`).get(Number(id)));
}

/** Les cibles d'une tournée. Lues à part : elles ne servent qu'au moment de travailler. */
export async function jobTargets(id) {
  const r = await prepare('SELECT targets FROM jobs WHERE id = ?').get(Number(id));
  return r ? JSON.parse(r.targets || '[]') : [];
}

/**
 * L'historique, du plus récent au plus ancien.
 * `kind` et `status` filtrent ; `mine` ne rend que les tournées d'un compte.
 */
export async function listJobs({ kind = '', status = '', userId = null, limit = 30 } = {}) {
  const ou = [];
  const args = [];
  if (kind) { ou.push('kind = ?'); args.push(kind); }
  if (status) { ou.push('status = ?'); args.push(status); }
  if (userId) { ou.push('created_by = ?'); args.push(Number(userId)); }
  const where = ou.length ? `WHERE ${ou.join(' AND ')}` : '';
  // LIMIT ne peut pas être un paramètre lié : la valeur passe par Number().
  const n = Math.min(200, Math.max(1, Number(limit) || 30));
  const rows = await prepare(`SELECT ${CHAMPS} FROM jobs ${where} ORDER BY id DESC LIMIT ${n}`).all(...args);
  return rows.map(ligne);
}

/**
 * La tournée à faire tourner maintenant, s'il y en a une.
 *
 * Les tournées en cours passent AVANT celles en attente : après un redémarrage, on
 * termine ce qui était commencé plutôt que d'ouvrir un nouveau chantier. Une seule à la
 * fois — deux balayages du parc en parallèle doubleraient la charge SSH sur les mêmes
 * machines, et personne n'y gagnerait.
 */
export async function nextJob() {
  const r = await prepare(
    `SELECT ${CHAMPS} FROM jobs WHERE status IN ('running', 'pending')
     ORDER BY FIELD(status, 'running', 'pending'), id ASC LIMIT 1`,
  ).get();
  return ligne(r);
}

export async function markRunning(id) {
  const now = Date.now();
  await prepare(
    'UPDATE jobs SET status = \'running\', started_at = COALESCE(started_at, ?), heartbeat_at = ? WHERE id = ?',
  ).run(now, now, Number(id));
}

/**
 * Avance la position et donne signe de vie, après CHAQUE lot.
 *
 * `done` compte des CIBLES, pas des lots : c'est ce que l'agent lit en face de `total`,
 * et « 300 sur 7 733 » se comprend tout seul là où « 3 sur 78 » ne dit rien.
 */
export async function advanceJob(id, doneTargets) {
  await prepare('UPDATE jobs SET done_count = ?, heartbeat_at = ? WHERE id = ?').run(Number(doneTargets), Date.now(), Number(id));
}

/**
 * Le numéro du prochain lot à traiter — c'est-à-dire le POINT DE REPRISE.
 *
 * Il se déduit de ce qui est écrit, et non d'un compteur : les lots sont numérotés sans
 * trou depuis zéro, donc leur nombre est le rang du suivant. Un compteur séparé pourrait
 * mentir après un arrêt brutal ; la table, elle, ne contient que ce qui a vraiment abouti.
 */
export async function nextSeq(id) {
  const r = await prepare('SELECT COUNT(*) AS n FROM job_results WHERE job_id = ?').get(Number(id));
  return Number(r?.n ?? 0);
}

/**
 * Recalcule les totaux à partir de ce qui est ÉCRIT, et non d'un compteur en mémoire.
 *
 * C'est la seule façon d'avoir juste après une reprise : le processus qui termine une
 * tournée n'a pas vu les lots traités par celui qui l'avait commencée. Les additionner
 * depuis la table, c'est compter ce qui s'est réellement passé.
 */
export async function tallyJob(id) {
  const r = await prepare(
    `SELECT COALESCE(SUM(CASE WHEN ok = 1 THEN count ELSE 0 END), 0) AS reussi,
            COALESCE(SUM(CASE WHEN ok = 0 THEN count ELSE 0 END), 0) AS rate
     FROM job_results WHERE job_id = ?`,
  ).get(Number(id));
  await prepare('UPDATE jobs SET ok_count = ?, fail_count = ? WHERE id = ?').run(Number(r.reussi), Number(r.rate), Number(id));
  return { ok: Number(r.reussi), failed: Number(r.rate) };
}

export async function finishJob(id, status, error = null) {
  await prepare('UPDATE jobs SET status = ?, error = ?, finished_at = ?, heartbeat_at = ? WHERE id = ?').run(
    status,
    error === null ? null : String(error).slice(0, 400),
    Date.now(),
    Date.now(),
    Number(id),
  );
  return getJob(id);
}

/**
 * Demande l'arrêt d'une tournée.
 *
 * Une tournée EN ATTENTE s'annule tout de suite. Une tournée EN COURS est marquée, et le
 * serveur s'arrêtera entre deux lots : interrompre un lot en plein travail laisserait des
 * sites à moitié traités, et c'est précisément ce qu'on cherche à éviter.
 */
export async function cancelJob(id) {
  const job = await getJob(id);
  if (!job || TERMINES.includes(job.status)) return job;
  return finishJob(id, 'cancelled');
}

/** Enregistre ce qu'un lot a rendu. Rejoué après une reprise, il remplace sans doubler. */
export async function saveResult(id, seq, { server = null, count = 0, ok = true, payload = null } = {}) {
  await prepare(
    `INSERT INTO job_results (job_id, seq, server_id, count, ok, payload, at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE count = VALUES(count), ok = VALUES(ok), payload = VALUES(payload), at = VALUES(at)`,
  ).run(Number(id), Number(seq), String(server ?? '').slice(0, 60), Number(count), ok ? 1 : 0, JSON.stringify(payload ?? null), Date.now());
}

/**
 * Les lots d'une tournée, à partir d'un numéro.
 *
 * L'écran qui suit une tournée demande « ce qui est arrivé depuis le lot n » : il
 * absorbe la suite sans relire ce qu'il a déjà. Celui qui rouvre une tournée d'hier
 * repart de zéro et les reçoit tous.
 */
export async function jobResults(id, { afterSeq = -1, limit = 50 } = {}) {
  const n = Math.min(200, Math.max(1, Number(limit) || 50));
  const rows = await prepare(
    `SELECT seq, server_id, count, ok, payload, at FROM job_results WHERE job_id = ? AND seq > ? ORDER BY seq ASC LIMIT ${n}`,
  ).all(Number(id), Number(afterSeq));
  return rows.map((r) => ({
    seq: Number(r.seq),
    server: r.server_id || null,
    count: Number(r.count),
    ok: Number(r.ok) === 1,
    at: Number(r.at),
    payload: JSON.parse(r.payload || 'null'),
  }));
}

/**
 * Efface les tournées terminées plus vieilles que N jours.
 *
 * Leurs résultats partent avec elles — la clé étrangère est en cascade. Sans ce ménage,
 * une tournée sur le parc entier laisserait des dizaines de mégaoctets de résultats que
 * plus personne ne regardera.
 */
export async function purgeJobs(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const r = await prepare(
    `DELETE FROM jobs WHERE status IN ('done', 'failed', 'cancelled') AND finished_at < ?`,
  ).run(Date.now() - n * 86_400_000);
  return r.changes;
}
