import { prepare, transaction } from './mysql.js';

/**
 * Les thématiques : le sujet d'un site et le menu de rubriques qui va avec.
 *
 * ELLES VIVENT EN BASE, et plus dans les sept CSV de `thematiques/`. Ceux-ci ne servent
 * qu'à l'import initial : une liste en fichiers se corrige en modifiant le code et se
 * relit à chaque écran, une liste en base se corrige seule et se lit d'une requête.
 *
 * LA CLÉ EST (thématique, langue, rubrique), et ce n'est pas un choix de confort. Mesuré
 * sur 60 sites de vps-004 le 05/10/2026 : l'icône d'une rubrique est la même partout
 * (100 % pour la plupart, 88 à 92 % pour deux d'entre elles), mais la DESCRIPTION dépend
 * du sujet — « actu » en porte douze variantes, une par thématique. Garder une
 * description par rubrique seule aurait mis « L'actualité santé et médecine » sur un site
 * de sport.
 */

/** Libellé de thématique → identifiant stable : « MODE / FEMME » donne « mode-femme ». */
export function cleThematique(label) {
  return String(label ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[’']/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Les langues des sept fichiers d'origine. */
export const LANGUES = ['FR', 'EN', 'ES', 'IT', 'DE', 'NL', 'PT'];

const lignesEnThematique = (lignes) => {
  if (!lignes.length) return null;
  const { id, key, lang, label, position, source, updated_at: maj } = lignes[0];
  return {
    id,
    key,
    lang,
    label,
    position,
    source,
    updatedAt: Number(maj) || 0,
    rubriques: lignes
      .filter((l) => l.slug)
      .map((l) => ({ slug: l.slug, name: l.name, icon: l.icon ?? '', description: l.description ?? '' })),
  };
};

/**
 * Une thématique et son menu, par identifiant.
 *
 * Une seule requête avec jointure : deux requêtes laisseraient la porte ouverte à un
 * menu lu après une modification, donc à un menu qui ne correspond plus à son sujet.
 */
export async function getThematique(id) {
  const lignes = await prepare(
    `SELECT t.id, t.\`key\`, t.lang, t.label, t.position, t.source, t.updated_at,
            r.slug, r.name, r.icon, r.description
       FROM thematiques t
       LEFT JOIN thematique_rubriques r ON r.thematique_id = t.id
      WHERE t.id = ?
      ORDER BY r.position, r.slug`,
  ).all(Number(id) || 0);
  return lignesEnThematique(lignes);
}

/** Une thématique par son identifiant et sa langue. */
export async function findThematique(key, lang) {
  const lignes = await prepare(
    `SELECT t.id, t.\`key\`, t.lang, t.label, t.position, t.source, t.updated_at,
            r.slug, r.name, r.icon, r.description
       FROM thematiques t
       LEFT JOIN thematique_rubriques r ON r.thematique_id = t.id
      WHERE t.\`key\` = ? AND t.lang = ?
      ORDER BY r.position, r.slug`,
  ).all(String(key ?? ''), String(lang ?? '').toUpperCase());
  return lignesEnThematique(lignes);
}

/**
 * Toutes les thématiques, menus compris.
 *
 * Le parc tient en une dizaine de sujets par langue, soit moins de cent lignes : tout
 * charger est plus simple et plus rapide que de paginer, et l'écran a de toute façon
 * besoin des rubriques pour montrer ce qu'une thématique poserait.
 */
export async function listThematiques({ lang = '' } = {}) {
  const conditions = [];
  const valeurs = [];
  if (lang) {
    conditions.push('t.lang = ?');
    valeurs.push(String(lang).toUpperCase());
  }
  const lignes = await prepare(
    `SELECT t.id, t.\`key\`, t.lang, t.label, t.position, t.source, t.updated_at,
            r.position AS rpos, r.slug, r.name, r.icon, r.description
       FROM thematiques t
       LEFT JOIN thematique_rubriques r ON r.thematique_id = t.id
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY t.lang, t.position, t.label, r.position, r.slug`,
  ).all(...valeurs);

  const par = new Map();
  for (const l of lignes) {
    if (!par.has(l.id)) {
      par.set(l.id, {
        id: l.id,
        key: l.key,
        lang: l.lang,
        label: l.label,
        position: l.position,
        source: l.source,
        updatedAt: Number(l.updated_at) || 0,
        rubriques: [],
      });
    }
    if (l.slug) par.get(l.id).rubriques.push({ slug: l.slug, name: l.name, icon: l.icon ?? '', description: l.description ?? '' });
  }
  return [...par.values()];
}

/**
 * Enregistre une thématique et SON MENU ENTIER, d'un seul coup.
 *
 * Le menu est remplacé, pas fusionné : une rubrique retirée du CSV doit disparaître de la
 * base, sinon elle se poserait encore sur les sites. Et tout se joue dans une transaction,
 * parce qu'une thématique sans menu — ou avec la moitié du menu — poserait un site
 * incomplet sans que rien ne le signale.
 */
export async function upsertThematique({ key, lang, label, position = 0, source = 'csv', rubriques = [] }) {
  const cle = String(key ?? '').slice(0, 60);
  const langue = String(lang ?? '').toUpperCase().slice(0, 5);
  if (!cle || !langue) throw new Error('thematique : clé et langue sont obligatoires');

  return transaction(async (tx) => {
    await tx.prepare(
      `INSERT INTO thematiques (\`key\`, lang, label, position, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE label = VALUES(label), position = VALUES(position),
                               source = VALUES(source), updated_at = VALUES(updated_at)`,
    ).run(cle, langue, String(label ?? cle).slice(0, 190), Number(position) || 0, String(source).slice(0, 20), Date.now());

    const { id } = await tx.prepare('SELECT id FROM thematiques WHERE `key` = ? AND lang = ?').get(cle, langue);
    await tx.prepare('DELETE FROM thematique_rubriques WHERE thematique_id = ?').run(id);

    let position_ = 0;
    const poses = [];
    for (const r of Array.isArray(rubriques) ? rubriques : []) {
      const slug = String(r?.slug ?? '').slice(0, 60);
      const nom = String(r?.name ?? '').trim().slice(0, 190);
      if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(slug) || !nom) continue;
      if (poses.includes(slug)) continue;
      await tx.prepare(
        'INSERT INTO thematique_rubriques (thematique_id, position, slug, name, icon, description) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, position_, slug, nom, String(r?.icon ?? '').slice(0, 32), String(r?.description ?? '').slice(0, 400));
      poses.push(slug);
      position_ += 1;
    }
    return { id, key: cle, lang: langue, rubriques: poses.length };
  });
}

/**
 * Complète les icônes et descriptions MANQUANTES d'une thématique.
 *
 * Les CSV n'en portent pas ; le parc, lui, en est rempli. Cette fonction ne remplace
 * jamais une valeur déjà présente : ce qui a été corrigé à la main le reste.
 */
export async function enrichirRubriques(thematiqueId, valeurs, { noms = false } = {}) {
  let touchees = 0;
  for (const [slug, v] of Object.entries(valeurs ?? {})) {
    const icon = String(v?.icon ?? '').slice(0, 32);
    const description = String(v?.description ?? '').slice(0, 400);
    const name = String(v?.name ?? '').trim().slice(0, 190);
    if (!icon && !description && !(noms && name)) continue;
    // LE NOM EST UN CAS À PART. Les CSV sont en capitales sans accents : « CROISIERE »
    // devient « Croisiere », alors que les sites du parc affichent « Croisière » avec son
    // accent. Le parc fait donc foi — mais SEULEMENT quand la thématique n'a jamais été
    // retouchée à la main, ce que dit sa colonne `source`. Sans cette réserve, une
    // moisson effacerait le travail d'un agent sans le dire.
    const res = await prepare(
      `UPDATE thematique_rubriques
          SET icon = CASE WHEN icon = '' THEN ? ELSE icon END,
              description = CASE WHEN description = '' THEN ? ELSE description END,
              name = CASE WHEN ? <> '' THEN ? ELSE name END
        WHERE thematique_id = ? AND slug = ?`,
    ).run(icon, description, noms ? name : '', name, Number(thematiqueId) || 0, String(slug).slice(0, 60));
    if (res?.changes) touchees += res.changes;
  }
  return touchees;
}

/** Supprime une thématique et son menu. */
export async function deleteThematique(id) {
  const res = await prepare('DELETE FROM thematiques WHERE id = ?').run(Number(id) || 0);
  return { deleted: Number(res?.changes ?? 0) };
}

/** De quoi savoir si l'import a déjà été fait, et ce qu'il a laissé. */
export async function statsThematiques() {
  const t = await prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT lang) AS langues FROM thematiques').get();
  const r = await prepare(
    `SELECT COUNT(*) AS n,
            SUM(icon = '') AS sans_icone,
            SUM(description = '') AS sans_description
       FROM thematique_rubriques`,
  ).get();
  return {
    thematiques: Number(t?.n ?? 0),
    langues: Number(t?.langues ?? 0),
    rubriques: Number(r?.n ?? 0),
    sansIcone: Number(r?.sans_icone ?? 0),
    sansDescription: Number(r?.sans_description ?? 0),
  };
}
