import { prepare } from './mysql.js';
import { AppError } from '../errors.js';
import { LANGS, normalizeLang } from '../services/langTools.js';

/**
 * Dictionnaire des agents : les expressions que le dictionnaire du parc ne connaît pas.
 *
 * L'action « gabarits » ne traduit que ce qu'elle sait traduire exactement. Quand elle
 * bute sur une phrase française — elle la signale plutôt que de deviner — l'agent
 * inscrit ici sa traduction, une fois pour toutes, et l'analyse suivante la corrige sur
 * tout le parc. C'est ce qui évite d'ouvrir un fichier à la main pour un mot oublié.
 *
 * Le dictionnaire vit dans la base du back-office, pas sur les serveurs : il profite à
 * tous les sites sans qu'aucun fichier ne soit déposé nulle part.
 */

const MAX = 400;

const row = (r) =>
  r && {
    id: r.id,
    source: r.source,
    lang: r.lang,
    target: r.target,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
  };

export async function listPhrases({ lang = null } = {}) {
  // La colonne est déjà rangée en utf8mb4_unicode_ci, qui ignore la casse : le
  // « COLLATE NOCASE » de SQLite n'a pas d'équivalent à écrire ici.
  const rows = lang
    ? await prepare('SELECT * FROM lang_phrases WHERE lang = ? ORDER BY source').all(lang)
    : await prepare('SELECT * FROM lang_phrases ORDER BY source, lang').all();
  return rows.map(row);
}

/** Les mots des agents, rangés par langue : { UK: { 'Plan du site': 'Sitemap' } }. */
export async function phrasesByLang() {
  const out = {};
  for (const p of await listPhrases()) (out[p.lang] ??= {})[p.source] = p.target;
  return out;
}

export async function savePhrase({ source, lang, target, userId = null }) {
  const fr = String(source ?? '').trim();
  const to = String(target ?? '').trim();
  const code = normalizeLang(lang);

  if (fr.length < 2 || fr.length > 160) throw new AppError('errors.phrase_source_invalid', { status: 400 });
  if (to.length < 1 || to.length > 160) throw new AppError('errors.phrase_target_invalid', { status: 400 });
  if (!code || code === 'FR') throw new AppError('errors.translate_lang_unknown', { status: 400, vars: { lang: String(lang).slice(0, 12) } });
  if (fr === to) throw new AppError('errors.phrase_same', { status: 400 });

  const { n } = await prepare('SELECT COUNT(*) AS n FROM lang_phrases').get();
  const existe = await prepare('SELECT id FROM lang_phrases WHERE source = ? AND lang = ?').get(fr, code);
  if (!existe && Number(n) >= MAX) throw new AppError('errors.phrase_too_many', { status: 400, vars: { max: MAX } });

  const now = Date.now();
  // « ON DUPLICATE KEY UPDATE » remplace le « ON CONFLICT » de SQLite, et « VALUES(col) »
  // y désigne la valeur qu'on tentait d'insérer.
  await prepare(
    `INSERT INTO lang_phrases (source, lang, target, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE target = VALUES(target), updated_at = VALUES(updated_at)`,
  ).run(fr, code, to, userId, now, now);

  return row(await prepare('SELECT * FROM lang_phrases WHERE source = ? AND lang = ?').get(fr, code));
}

export async function deletePhrase(id) {
  const r = await prepare('DELETE FROM lang_phrases WHERE id = ?').run(Number(id));
  return r.changes > 0;
}

export { LANGS };
