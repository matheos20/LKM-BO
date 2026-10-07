import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ECRITURE, FAMILLES, LECTURE, ETIQUETTES, estLecture, etiquetteDe, familleDe } from '../public/js/actionIdentity.js';

/**
 * L'écran Actions : ce que l'agent voit avant de lancer, et ce qu'on lui promet.
 *
 * CE QUI A MOTIVÉ CETTE REFONTE : les huit traitements se présentaient de la même façon,
 * et rien ne disait lequel se contente de LIRE et lequel ÉCRIT sur des sites en
 * production. Les essais ci-dessous tiennent cette promesse-là — elle est la seule du
 * lot dont le non-respect aurait des conséquences réelles.
 */
const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const ECRAN = readFileSync(join(RACINE, 'public/js/actions.js'), 'utf8');
const IDENTITE = readFileSync(join(RACINE, 'public/js/actionIdentity.js'), 'utf8');
const KINDS = readFileSync(join(RACINE, 'src/services/jobKinds.js'), 'utf8');
const LANGUES = ['fr', 'en', 'es', 'it', 'pt', 'de'];
const locale = (l) => JSON.parse(readFileSync(join(RACINE, `locales/${l}.json`), 'utf8'));

/**
 * Les actions du catalogue, et leur VRAIE clé.
 *
 * Le nom de la variable ne suffit pas : `urlAction` porte la clé « urls »,
 * `categoryAction` la clé « categories ». La clé est ce que l'écran et les libellés
 * emploient ; c'est donc elle qu'on va chercher, dans le module de chaque action.
 */
const CATALOGUE = (() => {
  const liste = /const ACTIONS = \[([^\]]+)\]/.exec(ECRAN);
  assert.ok(liste, 'le catalogue des actions doit être lisible dans l’écran');
  const variables = liste[1].split(',').map((s) => s.trim()).filter(Boolean);
  return variables.map((variable) => {
    const imp = new RegExp(`import \\{[^}]*\\b${variable}\\b[^}]*\\} from '\\./([a-zA-Z]+)\\.js'`).exec(ECRAN);
    assert.ok(imp, `« ${variable} » doit être importé d’un module`);
    const source = readFileSync(join(RACINE, `public/js/${imp[1]}.js`), 'utf8');
    const cle = /^\s{2}key: '([a-z]+)',$/m.exec(source);
    assert.ok(cle, `« ${imp[1]}.js » doit déclarer la clé de son action`);
    return cle[1];
  });
})();

// ─────────────────────────── les familles ───────────────────────────

test('actions : CHAQUE action du catalogue déclare sa famille', () => {
  // Une action oubliée serait présentée comme inoffensive par défaut si la table se
  // taisait — d'où cet essai, et d'où le choix de « écriture » pour l'inconnu.
  assert.equal(CATALOGUE.length, 8, `le catalogue a changé : ${CATALOGUE.join(', ')}`);
  for (const key of CATALOGUE) {
    assert.ok(key in FAMILLES, `« ${key} » n’a pas de famille déclarée dans actionIdentity.js`);
  }
  // Et pas l'inverse : une famille déclarée pour une action qui n'existe plus.
  for (const key of Object.keys(FAMILLES)) {
    assert.ok(CATALOGUE.includes(key), `« ${key} » est déclaré mais n’est plus au catalogue`);
  }
});

test('actions : une action inconnue est traitée comme ÉCRIVANTE', () => {
  // Le sens prudent. Annoncer à tort « lecture seule » sur un traitement qui modifie des
  // sites serait un mensonge aux conséquences réelles ; une mise en garde de trop ne
  // coûte qu'une seconde.
  assert.equal(familleDe('un-traitement-qui-nexiste-pas'), ECRITURE);
  assert.equal(familleDe(undefined), ECRITURE);
  assert.equal(familleDe(null), ECRITURE);
  assert.equal(estLecture('un-traitement-qui-nexiste-pas'), false);
});

test('actions : les trois analyses sont en lecture seule, les cinq autres écrivent', () => {
  assert.deepEqual(
    Object.keys(FAMILLES).filter((k) => FAMILLES[k] === LECTURE).sort(),
    ['duplicates', 'health', 'urls'],
  );
  assert.deepEqual(
    Object.keys(FAMILLES).filter((k) => FAMILLES[k] === ECRITURE).sort(),
    ['categories', 'redirects', 'templates', 'themes', 'translate'],
  );
});

test('actions : une action « lecture seule » n’a AUCUNE tournée qui écrit', () => {
  /**
   * L'ESSAI QUI RELIE L'ÉTIQUETTE À LA RÉALITÉ. L'étiquette est déclarée à la main ;
   * sans ce contrôle, elle resterait verte le jour où l'un de ces trois traitements
   * gagnerait une tournée d'écriture. Les permissions, elles, sont la vérité : une
   * tournée en `bulk.apply` écrit, une tournée en `bulk.read` ne peut pas.
   */
  const kinds = [...KINDS.matchAll(/parServeur\('([a-z.]+)',\s*\{\s*\n\s*(?:\/\/[^\n]*\n\s*)*permission: '([a-z.]+)'/g)].map((m) => ({
    kind: m[1],
    permission: m[2],
  }));
  assert.ok(kinds.length >= 8, `les tournées doivent être lisibles (vu : ${kinds.length})`);

  for (const key of Object.keys(FAMILLES).filter((k) => FAMILLES[k] === LECTURE)) {
    // Le nom de la tournée commence par celui de l'action, au pluriel près : health →
    // health.scan, urls → urls.scan, duplicates → duplicates.scan.
    const siennes = kinds.filter((k) => k.kind.startsWith(`${key}.`));
    assert.ok(siennes.length > 0, `« ${key} » doit avoir au moins une tournée`);
    for (const k of siennes) {
      assert.equal(k.permission, 'bulk.read', `« ${k.kind} » écrit : « ${key} » ne peut pas être dit en lecture seule`);
    }
  }
});

test('actions : chaque étiquette a sa couleur et ses deux phrases', () => {
  for (const famille of [LECTURE, ECRITURE]) {
    const e = ETIQUETTES[famille];
    assert.ok(e.labelKey && e.hintKey, `la famille ${famille} doit nommer ses libellés`);
    assert.match(e.classes, /^bg-[a-z]+-\d+ text-[a-z]+-\d+$/, 'les classes sont écrites en entier pour que Tailwind les voie');
  }
  // Le vert de la charte pour ce qui ne risque rien, l'ambre pour ce qui demande
  // attention. Le rouge reste réservé à ce qui va mal.
  assert.match(ETIQUETTES[LECTURE].classes, /accent/);
  assert.match(ETIQUETTES[ECRITURE].classes, /amber/);
  assert.equal(etiquetteDe('health'), ETIQUETTES[LECTURE]);
  assert.equal(etiquetteDe('themes'), ETIQUETTES[ECRITURE]);
});

// ─────────────────────────── l'écran ───────────────────────────

test('actions : le périmètre par défaut est la LISTE DE DOMAINES', () => {
  // Les deux autres périmètres désignent des milliers de sites d'un seul clic. Qu'ils
  // soient choisis sciemment, et non trouvés déjà cochés.
  assert.match(ECRAN, /scope: 'list', \/\/ server \| parc \| list/, 'l’état de départ');
  // Et à l'ouverture de l'écran, quel que soit le chemin emprunté.
  const ouverture = ECRAN.slice(ECRAN.indexOf('export async function openActions'), ECRAN.indexOf('export async function openActions') + 1800);
  assert.match(ouverture, /scope: 'list'/, 'openActions doit lui aussi repartir sur la liste');
  assert.ok(!/scope: serverId/.test(ECRAN), 'le périmètre ne dépend plus du serveur d’où l’on vient');
});

test('actions : l’en-tête porte le nom, la famille et la ligne d’état', () => {
  assert.ok(ECRAN.includes('function enTete()'), 'l’en-tête existe');
  assert.ok(ECRAN.includes('etiquetteFamille('), 'et il porte l’étiquette de famille');
  assert.ok(ECRAN.includes('function ligneEtat()'), 'et la ligne d’état');
  assert.ok(!/\bchooser\(\)/.test(ECRAN), 'l’ancien sélecteur nu a bien disparu');
  // La ligne d'état dit le périmètre ET le nombre : c'est la question qu'on se pose
  // juste avant de cliquer.
  const ligne = ECRAN.slice(ECRAN.indexOf('function ligneEtat()'), ECRAN.indexOf('function ligneEtat()') + 1200);
  assert.match(ligne, /actions\.scope_list/);
  assert.match(ligne, /actions\.selected/);
  assert.match(ligne, /font-mono/, 'en chasse fixe : une ligne de statut se parcourt, elle ne se lit pas');
});

test('actions : la fin d’une tournée est DITE, pas devinée', () => {
  assert.ok(ECRAN.includes('function banniereFin()'), 'le bandeau de fin existe');
  const banniere = ECRAN.slice(ECRAN.indexOf('function banniereFin()'), ECRAN.indexOf('function banniereFin()') + 1800);
  assert.match(banniere, /actions\.done_title/);
  assert.match(banniere, /actions\.done_partial/, 'une tournée interrompue ne se dit pas « terminée »');
  assert.match(banniere, /actions\.done_count/);
  // La contrepartie de l'étiquette affichée AVANT le lancement, tenue jusqu'au bout.
  assert.match(banniere, /actions\.done_read_only/);
  assert.match(banniere, /estLecture|lecture/, 'et seulement là où c’est vrai');
});

test('actions : une durée en dessous de la seconde n’est pas affichée', () => {
  // « 0 s » a l'air d'une mesure manquante et fait douter du reste du bandeau.
  const banniere = ECRAN.slice(ECRAN.indexOf('function banniereFin()'), ECRAN.indexOf('function banniereFin()') + 1200);
  assert.match(banniere, /ecoule >= 1000/, 'le seuil doit être explicite');
});

test('actions : l’étape de résultat ne parle d’écriture que là où il y en a une', () => {
  // Elle annonçait « Rien n'est encore écrit. Relisez, puis lancez la création » même
  // sur une analyse en lecture seule, où il n'y a rien à relire et rien à créer.
  assert.ok(ECRAN.includes("t('actions.step_read')"), 'une analyse rend un RÉSULTAT');
  assert.ok(ECRAN.includes("t('actions.step_result')"), 'une écriture propose une VÉRIFICATION');
  const bloc = ECRAN.slice(ECRAN.indexOf('LE TITRE DE CETTE ÉTAPE'), ECRAN.indexOf('LE TITRE DE CETTE ÉTAPE') + 900);
  assert.match(bloc, /lecture\s*\n?\s*\?\s*stepTitle\(etape\.results, t\('actions\.step_read'\)/s, 'le choix se fait sur la famille');
});

test('actions : le bloc de chiffres est un seul cadre, en chasse fixe', () => {
  const stats = ECRAN.slice(ECRAN.indexOf('function statsRow()'), ECRAN.indexOf('function statsRow()') + 1600);
  assert.match(stats, /actions\.stats_title/, 'le bloc se nomme');
  assert.match(stats, /font-mono text-2xl/, 'les nombres sont alignés en chasse fixe');
  assert.match(stats, /divide-ink-100/, 'et séparés d’un filet plutôt qu’éparpillés en tuiles');
  // Il reste commandé par l'action : chaque traitement déclare ses propres chiffres.
  assert.match(stats, /state\.action\.stats\(\)/);
});

// ─────────────────────────── les libellés ───────────────────────────

test('actions : les nouveaux libellés existent dans les six langues', () => {
  const attendus = [
    'family_read',
    'family_read_hint',
    'family_write',
    'family_write_hint',
    'stats_title',
    'done_title',
    'done_partial',
    'done_count',
    'done_read_only',
    'dur_s',
    'dur_min',
    'dur_h',
    'step_read',
    'step_read_hint',
  ];
  for (const l of LANGUES) {
    const a = locale(l).actions;
    for (const cle of attendus) {
      assert.equal(typeof a[cle], 'string', `${l} : actions.${cle} manque`);
      assert.ok(a[cle].trim().length > 0, `${l} : actions.${cle} est vide`);
    }
  }
});

test('actions : les messages qui portent un nombre nomment leur variable', () => {
  // Un libellé traduit qui perd son `{done}` affiche une phrase incomplète, et c'est le
  // genre d'oubli qu'une relecture humaine ne voit pas.
  const gabarits = { done_count: ['{done}', '{total}'], dur_s: ['{n}'], dur_min: ['{n}'], dur_h: ['{h}', '{m}'] };
  for (const l of LANGUES) {
    const a = locale(l).actions;
    for (const [cle, vars] of Object.entries(gabarits)) {
      for (const v of vars) assert.ok(a[cle].includes(v), `${l} : actions.${cle} doit contenir ${v}`);
    }
  }
});

test('actions : les deux familles se distinguent dans toutes les langues', () => {
  // Deux étiquettes qui se traduiraient par le même mot ne distingueraient plus rien.
  for (const l of LANGUES) {
    const a = locale(l).actions;
    assert.notEqual(a.family_read.toLowerCase(), a.family_write.toLowerCase(), `${l} : les deux familles doivent se lire différemment`);
    assert.notEqual(a.step_read.toLowerCase(), a.step_result.toLowerCase(), `${l} : les deux étapes aussi`);
  }
});

test('actions : la table d’identité ne contient aucune couleur hors charte', () => {
  // La charte du projet tient en trois couleurs ; le rouge et l'ambre y sont admis comme
  // SIGNAUX, jamais comme décoration. Une teinte par action aurait été décorative.
  const teintes = [...IDENTITE.matchAll(/bg-([a-z]+)-\d+/g)].map((m) => m[1]);
  for (const teinte of new Set(teintes)) {
    assert.ok(['accent', 'amber', 'ink'].includes(teinte), `« ${teinte} » n’a rien à faire dans la charte`);
  }
});
