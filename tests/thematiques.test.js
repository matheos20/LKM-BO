import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  LANGUES,
  cleThematique,
  deleteThematique,
  enrichirRubriques,
  findThematique,
  getThematique,
  listThematiques,
  statsThematiques,
  upsertThematique,
} from '../src/db/thematiques.js';
import { parseCsv, splitCsvRecords } from '../src/services/csv.js';
import { lireCsvThematiques, nomRubrique } from '../src/services/thematiqueCsv.js';
import { creerBaseJetable } from './mysqlTestDb.js';

/**
 * Les thématiques : le sujet d'un site et le menu de rubriques qui va avec.
 *
 * TROIS MESURES DU 05/10/2026 ONT FAÇONNÉ CETTE COUCHE :
 *
 *   1. le fichier anglais commence par un champ entre guillemets QUI CONTIENT UN RETOUR
 *      À LA LIGNE. Le lecteur de CSV découpait d'abord sur les retours à la ligne : cet
 *      enregistrement était coupé en deux moitiés, déclarées mal formées, et la première
 *      thématique du fichier disparaissait sans un mot ;
 *   2. les sept fichiers NE NOMMENT PAS LEURS COLONNES PAREIL — « THEMATIQUE FR » ici,
 *      « THEMATIQUE » tout court en néerlandais et en portugais, un espace de trop en
 *      allemand. Se fier au nom vidait silencieusement deux langues sur sept ;
 *   3. relevé sur 60 sites de vps-004, l'icône d'une rubrique est la même d'un site à
 *      l'autre dans 100 % des cas pour la plupart, mais la DESCRIPTION dépend du sujet :
 *      « actu » en porte douze variantes, une par thématique. D'où la clé
 *      (thématique, langue, rubrique) et non la rubrique seule.
 */
const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = creerBaseJetable('thematiques');
before(() => base.ouvrir());
after(() => base.fermer());

const vider = () => base.vider('thematique_rubriques', 'thematiques');

// ─────────────────────────── la lecture des CSV ───────────────────────────

test('CSV : un champ entre guillemets peut contenir un retour à la ligne', () => {
  // C'est le cas réel du fichier anglais :
  //     "ANIMALS
  //     ",NEWS
  const records = splitCsvRecords('a,b\n"ANIMALS \n",NEWS\n,DOGS\n');
  // Trois enregistrements sur quatre lignes physiques : le deuxième en occupe deux.
  assert.equal(records.length, 3);
  assert.equal(records[1].raw, '"ANIMALS \n"' + ',NEWS');
  // Et le numéro de ligne reste celui que l'agent voit dans son tableur : le troisième
  // enregistrement commence à la ligne 4, pas à la ligne 3.
  assert.deepEqual(records.map((r) => r.line), [1, 2, 4]);
});

test('CSV : « \\r\\n » ne compte que pour une fin d’enregistrement', () => {
  const records = splitCsvRecords('a,b\r\nc,d\r\n');
  assert.deepEqual(records.map((r) => r.raw), ['a,b', 'c,d']);
});

test('CSV : deux guillemets de suite restent dans la valeur', () => {
  const records = splitCsvRecords('x\n"il a dit ""oui""",y\n');
  assert.equal(records.length, 2);
  // L'enregistrement n'a pas été coupé sur la virgule intérieure.
  assert.ok(records[1].raw.includes('""oui""'));
});

test('CSV : le fichier anglais rend bien TOUTES ses thématiques', () => {
  // Avant correction, la première se perdait. Un contrôle sur les vrais fichiers, parce
  // que c'est leur forme réelle qui a posé le problème, pas une forme imaginée.
  const texte = readFileSync(join(RACINE, 'thematiques/thematiques EN.csv'), 'utf8');
  assert.equal(parseCsv(texte).malformed.length, 0, 'aucun enregistrement ne doit être déclaré mal formé');
  const sujets = lireCsvThematiques(texte);
  assert.ok(sujets.length >= 12, `12 sujets attendus, ${sujets.length} lus`);
  assert.equal(sujets[0].label, 'ANIMALS', 'le premier sujet est celui qui se perdait');
  assert.deepEqual(sujets[0].rubriques, ['NEWS', 'DOGS', 'CATS', 'OTHER PETS']);
});

test('CSV : les sept fichiers se lisent, quel que soit le nom de leurs colonnes', () => {
  // « THEMATIQUE NL » n'existe pas : la colonne s'appelle « THEMATIQUE ». Les colonnes
  // sont donc prises par POSITION.
  for (const langue of LANGUES) {
    const texte = readFileSync(join(RACINE, `thematiques/thematiques ${langue}.csv`), 'utf8');
    const sujets = lireCsvThematiques(texte);
    assert.ok(sujets.length >= 12, `${langue} : ${sujets.length} sujet(s) lus, 12 attendus`);
    for (const s of sujets) {
      assert.ok(s.label.trim().length > 0, `${langue} : un sujet sans nom`);
      assert.ok(s.rubriques.length > 0, `${langue} : « ${s.label} » sans rubrique`);
    }
  }
});

test('CSV : l’en-tête n’est jamais pris pour un sujet', () => {
  const sujets = lireCsvThematiques('THEMATIQUE FR,MENU FR\nSANTE,ACTU\n,SANTE\n');
  assert.equal(sujets.length, 1);
  assert.equal(sujets[0].label, 'SANTE');
});

// ─────────────────────────── les noms et les clés ───────────────────────────

test('thématiques : la clé supporte les libellés à barre oblique', () => {
  // « MODE / FEMME » et « FINANCE / IMMOBILIER » sont de vrais libellés du fichier.
  assert.equal(cleThematique('MODE / FEMME'), 'mode-femme');
  assert.equal(cleThematique('FINANCE / IMMOBILIER'), 'finance-immobilier');
  assert.equal(cleThematique('SANTE'), 'sante');
  assert.equal(cleThematique('KÜCHE'), 'kuche');
  assert.equal(cleThematique(''), '');
});

test('thématiques : un nom de rubrique en capitales redevient lisible', () => {
  assert.equal(nomRubrique('AUTRES ANIMAUX'), 'Autres animaux');
  assert.equal(nomRubrique('ACTU'), 'Actu');
  assert.equal(nomRubrique(''), '');
});

// ─────────────────────────── la base ───────────────────────────

const SANTE = {
  key: 'sante',
  lang: 'FR',
  label: 'SANTE',
  position: 7,
  rubriques: [
    { slug: 'actu', name: 'Actu' },
    { slug: 'bien-etre', name: 'Bien-etre' },
    { slug: 'sante', name: 'Sante' },
  ],
};

test('thématiques : une thématique et son menu s’enregistrent ensemble', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await vider();
  const { id, rubriques } = await upsertThematique(SANTE);
  assert.equal(rubriques, 3);
  const lue = await getThematique(id);
  assert.equal(lue.label, 'SANTE');
  assert.equal(lue.lang, 'FR');
  assert.deepEqual(lue.rubriques.map((r) => r.slug), ['actu', 'bien-etre', 'sante'], 'l’ordre du menu est conservé');
  assert.equal(lue.rubriques[0].icon, '', 'les CSV n’en portent pas');
});

test('thématiques : le MÊME sujet dans deux langues sont deux entrées', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await vider();
  await upsertThematique(SANTE);
  await upsertThematique({ ...SANTE, lang: 'EN', label: 'HEALTH', rubriques: [{ slug: 'news', name: 'News' }] });
  const tout = await listThematiques();
  assert.equal(tout.length, 2);
  assert.equal((await findThematique('sante', 'FR')).label, 'SANTE');
  assert.equal((await findThematique('sante', 'EN')).label, 'HEALTH');
  assert.equal((await listThematiques({ lang: 'EN' })).length, 1);
  // La langue est reçue dans n'importe quelle casse.
  assert.equal((await findThematique('sante', 'en')).label, 'HEALTH');
});

test('thématiques : le menu est REMPLACÉ, jamais fusionné', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  // Une rubrique retirée du fichier d'origine doit disparaître de la base : sinon elle
  // continuerait de se poser sur les sites, sans que rien ne le dise.
  await vider();
  await upsertThematique(SANTE);
  await upsertThematique({ ...SANTE, rubriques: [{ slug: 'actu', name: 'Actu' }] });
  const lue = await findThematique('sante', 'FR');
  assert.deepEqual(lue.rubriques.map((r) => r.slug), ['actu']);
});

test('thématiques : une rubrique au slug impossible est écartée', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await vider();
  const { rubriques } = await upsertThematique({
    ...SANTE,
    rubriques: [
      { slug: 'actu', name: 'Actu' },
      { slug: 'Majuscule', name: 'Refusée' },
      { slug: 'avec espace', name: 'Refusée' },
      { slug: 'actu', name: 'Doublon' },
      { slug: 'vide', name: '   ' },
      { slug: '', name: 'Sans slug' },
    ],
  });
  assert.equal(rubriques, 1);
});

test('thématiques : une clé ou une langue absente est refusée', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await assert.rejects(() => upsertThematique({ key: '', lang: 'FR' }));
  await assert.rejects(() => upsertThematique({ key: 'sante', lang: '' }));
});

test('thématiques : la moisson complète ce qui est VIDE, et rien d’autre', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  // Ce qu'un agent a corrigé à la main doit survivre à une moisson : sans cette règle,
  // chaque passage effacerait son travail sans le dire.
  await vider();
  const { id } = await upsertThematique({
    ...SANTE,
    rubriques: [
      { slug: 'actu', name: 'Actu', icon: '🖐️', description: 'Écrite à la main' },
      { slug: 'sante', name: 'Sante', icon: '', description: '' },
    ],
  });
  await enrichirRubriques(id, {
    actu: { icon: '📰', description: 'Du parc' },
    sante: { icon: '❤️', description: 'Conseils santé et prévention' },
  });
  const lue = await getThematique(id);
  const par = Object.fromEntries(lue.rubriques.map((r) => [r.slug, r]));
  assert.equal(par.actu.icon, '🖐️', 'l’icône posée à la main reste');
  assert.equal(par.actu.description, 'Écrite à la main');
  assert.equal(par.sante.icon, '❤️', 'celle qui manquait est complétée');
  assert.equal(par.sante.description, 'Conseils santé et prévention');
});

test('thématiques : la moisson ne corrige les NOMS que si on le lui demande', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  // Les CSV sont en capitales sans accents : « CROISIERE » devient « Croisiere », alors
  // que les sites affichent « Croisière ». Le parc fait foi — mais seulement sur une
  // thématique que personne n'a retouchée.
  await vider();
  const { id } = await upsertThematique({ ...SANTE, rubriques: [{ slug: 'bien-etre', name: 'Bien-etre' }] });
  await enrichirRubriques(id, { 'bien-etre': { name: 'Bien-être' } });
  assert.equal((await getThematique(id)).rubriques[0].name, 'Bien-etre', 'sans permission, le nom ne bouge pas');
  await enrichirRubriques(id, { 'bien-etre': { name: 'Bien-être' } }, { noms: true });
  assert.equal((await getThematique(id)).rubriques[0].name, 'Bien-être');
});

test('thématiques : un emoji composé survit au voyage en base', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  // « 👨‍⚕️ » est fait de quatre points de code reliés. En utf8 simple, MySQL l'aurait
  // refusé ou tronqué ; c'est pourquoi la table est en utf8mb4.
  await vider();
  const { id } = await upsertThematique({
    ...SANTE,
    rubriques: [{ slug: 'professionnels', name: 'Professionnels', icon: '👨‍⚕️', description: 'Professionnels de santé' }],
  });
  const lue = await getThematique(id);
  assert.equal(lue.rubriques[0].icon, '👨‍⚕️');
  assert.equal(lue.rubriques[0].description, 'Professionnels de santé');
});

test('thématiques : le bilan dit ce qui reste à compléter', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  // L'écran doit pouvoir prévenir avant qu'une thématique incomplète ne soit posée : une
  // rubrique sans icône ni description laisserait un trou visible sur le site.
  await vider();
  await upsertThematique({
    ...SANTE,
    rubriques: [
      { slug: 'actu', name: 'Actu', icon: '📰', description: 'Oui' },
      { slug: 'sante', name: 'Sante' },
    ],
  });
  const s = await statsThematiques();
  assert.equal(s.thematiques, 1);
  assert.equal(s.rubriques, 2);
  assert.equal(s.sansIcone, 1);
  assert.equal(s.sansDescription, 1);
});

test('thématiques : supprimer un sujet emporte son menu', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await vider();
  const { id } = await upsertThematique(SANTE);
  assert.equal((await deleteThematique(id)).deleted, 1);
  assert.equal(await getThematique(id), null);
  assert.equal((await statsThematiques()).rubriques, 0, 'la clé étrangère en cascade doit jouer');
});

// ─────────────────────────── ce que le code doit garder ───────────────────────────

test('thématiques : les sept langues du dossier sont déclarées', () => {
  assert.deepEqual(LANGUES, ['FR', 'EN', 'ES', 'IT', 'DE', 'NL', 'PT']);
  for (const langue of LANGUES) {
    const f = join(RACINE, `thematiques/thematiques ${langue}.csv`);
    assert.ok(readFileSync(f, 'utf8').length > 100, `${langue} : fichier vide ou absent`);
  }
});

test('thématiques : la table est en utf8mb4, sans quoi les emoji seraient perdus', () => {
  const schema = readFileSync(join(RACINE, 'src/db/mysqlSchema.js'), 'utf8');
  const v8 = schema.slice(schema.indexOf('CREATE TABLE thematiques'));
  assert.match(v8, /CREATE TABLE thematiques[\s\S]*?CHARSET=utf8mb4/);
  assert.match(v8, /CREATE TABLE thematique_rubriques[\s\S]*?CHARSET=utf8mb4/);
  // « key » est un mot réservé de MySQL : sans les accents graves, la migration échoue.
  // Ils sont échappés dans le source, puisque la migration vit dans un gabarit — d'où
  // `includes` plutôt qu'une expression régulière, où l'antislash se compte deux fois.
  assert.ok(v8.includes('\\`key\\` VARCHAR'), '« key » doit être protégé par des accents graves');
  // La clé d'unicité porte sur le couple (sujet, langue).
  assert.ok(v8.includes('UNIQUE KEY uq_thematique (\\`key\\`, lang)'));
  // Et le menu s'en va avec son sujet.
  assert.match(v8, /REFERENCES thematiques\(id\) ON DELETE CASCADE/);
});

test('thématiques : l’import lit les colonnes par POSITION', () => {
  // Deux fichiers sur sept nomment leur première colonne « THEMATIQUE » tout court. Se
  // fier au nom les vidait sans un mot.
  const src = readFileSync(join(RACINE, 'src/services/thematiqueCsv.js'), 'utf8');
  assert.match(src, /const \[sujet, rubrique\] = cells;/);
  assert.ok(!/THEMATIQUE \$\{/.test(src), 'aucun nom de colonne ne doit être reconstruit');
});
