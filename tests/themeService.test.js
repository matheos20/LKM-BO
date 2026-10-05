import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { diff, reconnaitre, signature, stampMaintenant } from '../src/services/themeService.js';

/**
 * Le service de changement de thématique : ce qu'il calcule, ce qu'il refuse, ce qu'il
 * laisse tranquille.
 *
 * L'aller-retour sauvegarde/restauration est éprouvé ailleurs, sur du vrai PHP et un vrai
 * disque (`tests/theme.test.js`). Ici on tient les règles qui se décident en JavaScript,
 * et les promesses que l'écran doit continuer de porter.
 */
const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE = readFileSync(join(RACINE, 'src/services/themeService.js'), 'utf8');
const ECRAN = readFileSync(join(RACINE, 'public/js/themes.js'), 'utf8');

// ─────────────────────────── reconnaître, comparer ───────────────────────────

test('thème : la reconnaissance est EXACTE, jamais approchée', () => {
  // Mesuré sur 250 sites de vps-004 : 167 portaient exactement le menu d'une thématique
  // connue. Un site dont le menu a été bricolé ne doit pas être étiqueté « SANTE » à
  // 80 % — l'agent préfère savoir qu'on ne le reconnaît pas.
  const connues = [
    { id: 1, label: 'SANTE', rubriques: [{ slug: 'actu' }, { slug: 'sante' }] },
    { id: 2, label: 'SPORT', rubriques: [{ slug: 'actu' }, { slug: 'foot' }] },
  ];
  assert.equal(reconnaitre(['sante', 'actu'], connues)?.label, 'SANTE', 'l’ordre n’importe pas');
  assert.equal(reconnaitre(['actu', 'foot'], connues)?.label, 'SPORT');
  assert.equal(reconnaitre(['actu', 'sante', 'extra'], connues), null, 'une rubrique de plus, et ce n’est plus la même');
  assert.equal(reconnaitre(['actu'], connues), null, 'une rubrique de moins non plus');
  assert.equal(reconnaitre([], connues), null);
  assert.equal(reconnaitre(['actu'], []), null);
});

test('thème : la signature ne dépend ni de l’ordre ni des doublons', () => {
  assert.equal(signature(['b', 'a']), signature(['a', 'b']));
  assert.equal(signature(['a', 'a', 'b']), 'a,b');
  assert.equal(signature([]), '');
  assert.equal(signature(undefined), '');
});

test('thème : le diff dit ce qui vient, ce qui part, et ce qu’on perd', () => {
  const actuelles = [
    { slug: 'actu', articles: 10 },
    { slug: 'bien-etre', articles: 3 },
    { slug: 'grossesse', articles: 0 },
  ];
  const d = diff(actuelles, [{ slug: 'actu' }, { slug: 'foot' }]);
  assert.deepEqual(d.created, ['foot']);
  assert.deepEqual(d.dropped, ['bien-etre', 'grossesse']);
  assert.deepEqual(d.kept, ['actu']);
  // Seuls les articles des rubriques qui PARTENT comptent, et seulement s'il y en a :
  // « grossesse » est vide, elle n'orpheline personne.
  assert.equal(d.orphans, 3);
  assert.deepEqual(d.orphansBySlug, { 'bien-etre': 3 });
});

test('thème : poser la même thématique ne change rien, et ne perd rien', () => {
  const d = diff([{ slug: 'actu', articles: 10 }, { slug: 'foot', articles: 5 }], [{ slug: 'foot' }, { slug: 'actu' }]);
  assert.deepEqual(d.created, []);
  assert.deepEqual(d.dropped, []);
  assert.deepEqual(d.kept, ['actu', 'foot']);
  assert.equal(d.orphans, 0);
});

test('thème : un diff sur rien ne jette pas', () => {
  assert.deepEqual(diff([], []), { created: [], dropped: [], kept: [], orphans: 0, orphansBySlug: {} });
  assert.deepEqual(diff(undefined, undefined).created, []);
});

test('thème : l’horodatage a la forme que le script serveur exige', () => {
  // Le script refuse toute autre forme : les deux doivent s'accorder, sinon la sauvegarde
  // part dans un dossier que la restauration ne retrouvera jamais.
  assert.equal(stampMaintenant(new Date(Date.UTC(2026, 9, 5, 14, 30, 7))), '20261005-143007');
  assert.match(stampMaintenant(), /^\d{8}-\d{6}$/);
  // Un chiffre seul reste sur deux positions : « 09 » et non « 9 ».
  assert.equal(stampMaintenant(new Date(Date.UTC(2026, 0, 9, 3, 4, 5))), '20260109-030405');
});

// ─────────────────────────── les promesses du module ───────────────────────────

test('thème : LES TEXTES DU SITE NE SONT PAS DANS LE PÉRIMÈTRE', () => {
  // Mesuré sur 80 sites de vps-004 : treize sites d'une même thématique avaient treize
  // `meta_description` différentes, treize accroches différentes. Ces textes sont
  // l'identité éditoriale de chaque site ; les réécrire d'après la thématique les
  // détruirait tous.
  const code = SERVICE.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const interdit of ['homepage', 'meta_description', 'site_tagline', 'hero', 'testimonials']) {
    assert.ok(!new RegExp(`\\b${interdit}\\b`).test(code), `le service ne doit pas toucher à « ${interdit} »`);
  }
  // Seules les rubriques le sont.
  assert.match(code, /setCategories/);
  // Et l'écran prévient l'agent qu'il restera la page d'accueil à reprendre.
  assert.match(ECRAN, /themes\.texts_note/);
});

test('thème : l’autorisation des articles orphelins est EXPLICITE', () => {
  // Même règle que la case « Remplacer » des redirections : personne ne doit rendre
  // 84 articles inaccessibles par inadvertance. Mesuré sur douze sites tirés au hasard,
  // passer à SPORT aurait touché 688 articles.
  assert.match(SERVICE, /allowOrphans = false/, 'refusée par défaut');
  assert.match(SERVICE, /s\.orphans > 0 && !allowOrphans/);
  assert.match(SERVICE, /state: 'orphans'/, 'et le site écarté le DIT');
  assert.match(ECRAN, /autoriseOrphelins: false/);
  assert.match(ECRAN, /themes\.allow_orphans/);
});

test('thème : SI config.php RÉSISTE, LA POSE EST ANNULÉE', () => {
  // Un site dont les dossiers ont changé mais pas la configuration est dans un état que
  // personne n'a voulu. La restauration part seule, sans attendre qu'un agent s'en
  // aperçoive — et si elle échoue à son tour, l'écran le dit en clair.
  assert.match(SERVICE, /await this\.restore\(serverId, s\.domain, fait\.stamp/);
  assert.match(SERVICE, /state: 'rolled_back'/);
  assert.match(SERVICE, /rollback: retour\?\.error/);
  assert.match(ECRAN, /themes\.rollback_failed/);
});

test('thème : config.php est écrit EN DERNIER, par le circuit de publication', () => {
  // Les dossiers d'abord, la configuration ensuite : un dossier sans entrée de
  // configuration ne dérange personne, l'inverse afficherait au menu une rubrique qui
  // mène à une page inexistante.
  const posePHP = SERVICE.indexOf('THEME_APPLY');
  const poseConfig = SERVICE.indexOf('setCategories');
  assert.ok(posePHP > 0 && poseConfig > posePHP, 'THEME_APPLY doit venir avant setCategories');
});

test('thème : un site qu’on n’a pas pu lire n’est pas un site sans rubrique', () => {
  // Le supposer vide aurait fait poser la thématique entière et retirer un menu qu'on
  // n'a pas vu.
  assert.match(SERVICE, /error: 'no_answer'/);
  assert.match(SERVICE, /if \(lu\.error\) return/);
});

test('thème : le bouton « Revenir » n’apparaît QUE s’il y a où revenir', () => {
  // Proposer un retour sans sauvegarde serait la pire des promesses.
  assert.match(ECRAN, /const stamp = pose\?\.stamp;/);
  assert.match(ECRAN, /if \(!stamp\) return h\('span'/);
});

test('thème : la liste des thématiques vient de la BASE, pas du code', () => {
  assert.match(ECRAN, /api\('\/api\/thematiques'\)/);
  assert.ok(!/SANTE|TOURISME|MODE \/ FEMME/.test(ECRAN), 'aucune thématique écrite en dur dans l’écran');
  assert.match(SERVICE, /from '\.\.\/db\/thematiques\.js'/);
});

test('thème : le service ne tronque qu’aux bornes de config.php', () => {
  // `validateConfig` accepte 16 caractères d'icône et 300 de description ; la base en
  // garde davantage. C'est le fichier qui commande, et tronquer en silence vaut mieux
  // qu'un refus : la description est un ornement, la rubrique doit exister.
  assert.match(SERVICE, /MAX_ICON = 16/);
  assert.match(SERVICE, /MAX_DESCRIPTION = 300/);
  const catalogue = readFileSync(join(RACINE, 'src/services/siteCatalog.js'), 'utf8');
  assert.match(catalogue, /categories\.\$\{slug\}\.icon` \}\) \?\? ''/);
  assert.ok(catalogue.includes('max: 16, field: `categories.${slug}.icon`'), 'les deux bornes doivent rester d’accord');
  assert.ok(catalogue.includes('max: 300, field: `categories.${slug}.description`'));
});

// ─────────────────────────── droits, routes, écran ───────────────────────────

test('thème : UN SITE VERROUILLÉ EST ÉCARTÉ AVANT qu’on tente la pose', () => {
  // Mesuré le 05/10/2026 : 217 sites sur 400 de vps-004 portent l'attribut immuable, et
  // 54 % du parc refuse toute écriture au compte SSH. Vérifié en direct sur
  // coc-europe.com : la pose rend « error: backup » et le site reste intact octet pour
  // octet — mais l'agent ne savait pas pourquoi. Un échec annoncé vaut mieux qu'un
  // échec constaté.
  assert.match(SERVICE, /writable: Boolean\(lu\.writable\)/);
  assert.match(SERVICE, /if \(!s\.writable\) \{ sites\.push\(\{ \.\.\.s, state: 'error', error: 'locked' \}\)/);
  const details = readFileSync(join(RACINE, 'src/services/phpScripts.js'), 'utf8');
  // `is_writable` répond pour le compte qui écrira vraiment, quelle que soit la cause —
  // verrou, ACL, ou autre chose qu'on n'a pas encore rencontrée.
  assert.match(details, /\$site\['writable'\] = is_writable\(\$doc\);/);
  // Et l'écran ne compte pas un site verrouillé parmi ceux qu'il va poser.
  assert.match(ECRAN, /s\.engine && s\.writable &&/);
  assert.match(ECRAN, /themes\.locked_count/);
  assert.match(ECRAN, /themes\.err_locked/);
});

test('thème : la pose exige le droit d’APPLIQUER, l’analyse celui de lire', async () => {
  const { buildJobKinds } = await import('../src/services/jobKinds.js');
  const kinds = buildJobKinds({ translation: {}, categories: {}, redirects: {}, cloudflare: {}, health: {}, urls: {}, themes: {} });
  assert.equal(kinds['theme.analyze'].permission, 'bulk.read');
  assert.equal(kinds['theme.apply'].permission, 'bulk.apply');
  assert.ok(kinds['theme.apply'].batch <= 20, 'une pose touche plusieurs fichiers par site');

  const route = readFileSync(join(RACINE, 'src/routes/thematiques.js'), 'utf8');
  assert.match(route, /r\.get\('\/', canRead,/);
  assert.match(route, /r\.post\('\/apply', canApply,/);
  // Remettre un ancien état est une écriture : le droit de lire n'y suffit pas.
  assert.match(route, /r\.post\('\/restore', canApply,/);
  assert.match(route, /r\.post\('\/backups', canRead,/);
  // Et toute route qui touche un serveur vérifie la portée ET la session.
  for (const m of route.matchAll(/r\.post\('\/(apply|restore|backups)',[^)]*\)/g)) {
    assert.match(m[0], /access, conn/, `« ${m[1] ?? ''} » doit passer par la portée et la session`);
  }
});

test('thème : les deux portes de la pose appellent LA MÊME mécanique', () => {
  // Une route pour l'écran, une tournée pour les grandes séries — mais une seule
  // implémentation, sinon elles divergeront.
  const route = readFileSync(join(RACINE, 'src/routes/thematiques.js'), 'utf8');
  const kinds = readFileSync(join(RACINE, 'src/services/jobKinds.js'), 'utf8');
  assert.match(route, /themes\.apply\(/);
  assert.match(kinds, /themes\.apply\(/);
});

test('thème : l’écran est branché dans la liste des traitements', () => {
  const actions = readFileSync(join(RACINE, 'public/js/actions.js'), 'utf8');
  assert.match(actions, /import \{ themeAction \} from '\.\/themes\.js';/);
  assert.match(actions, /const ACTIONS = \[[^\]]*themeAction/);
});

test('thème : tous les états et messages existent dans les six langues', () => {
  const etats = ['done', 'already', 'orphans', 'error', 'rolled_back', 'restored', 'locked'];
  const cles = [
    'explain', 'step_what', 'step_what_hint', 'loading', 'lang', 'all_langs', 'choose',
    'analyze', 'apply', 'applying', 'nothing', 'no_description',
    'incomplete_form', 'incomplete_warn', 'texts_note',
    'allow_orphans', 'allow_orphans_hint', 'ready', 'blocked', 'applied',
    'restore', 'restore_hint', 'restored', 'rollback_failed',
    'col_now', 'col_change', 'col_orphans', 'no_change', 'unknown_theme',
    'stat_sites', 'stat_tochange', 'stat_already', 'stat_orphans',
    'err_missing', 'err_engine', 'err_config', 'err_empty', 'err_no_answer', 'err_backup',
    'err_locked', 'locked_count', 'after_note', 'load_failed', 'none_in_db', 'retry',
  ];
  const erreurs = [
    'theme_no_target', 'theme_unknown', 'theme_empty', 'theme_backup_unknown',
    'theme_restore_no_backup', 'theme_restore_incomplete', 'theme_restore_syntax',
    'theme_restore_invalid', 'theme_restore_copy', 'theme_restore_write',
  ];
  for (const langue of ['fr', 'en', 'es', 'it', 'pt', 'de']) {
    const tout = JSON.parse(readFileSync(join(RACINE, 'locales', `${langue}.json`), 'utf8'));
    assert.equal(typeof tout.actions?.themes, 'string', `${langue} : « actions.themes » manque`);
    for (const e of etats) assert.equal(typeof tout.themes?.[`state_${e}`], 'string', `${langue} : « themes.state_${e} » manque`);
    for (const c of cles) {
      assert.equal(typeof tout.themes?.[c], 'string', `${langue} : « themes.${c} » manque`);
      assert.ok(tout.themes[c].trim().length > 1, `${langue} : « themes.${c} » est vide`);
    }
    for (const e of erreurs) assert.equal(typeof tout.errors?.[e], 'string', `${langue} : « errors.${e} » manque`);
  }
});

test('thème : LA LISTE SE CHARGE EN OUVRANT L’ÉCRAN, pas au moment de lancer', () => {
  // Elle ne se chargeait qu'avant une analyse, c'est-a-dire JAMAIS : le bouton reste gris
  // tant qu'aucune thematique n'est choisie, et aucune ne pouvait l'etre tant que la liste
  // n'etait pas la. L'ecran affichait « Lecture des thématiques… » sans fin — constate par
  // l'agent le 05/10/2026.
  assert.match(ECRAN, /form\(\{ step = 1 \} = \{\}\) \{[\s\S]{0,400}?chargerListe\(\);/);
  assert.match(ECRAN, /function chargerListe/);
});

test('thème : une liste déjà lue n’est pas redemandée à chaque redessin', () => {
  // `form()` est rappelé a chaque rendu, et l'ecran se redessine souvent. Sans garde,
  // l'erreur etait remise a zero avant d'avoir pu s'afficher, et une base vide faisait
  // solliciter le serveur en boucle.
  assert.match(ECRAN, /if \(state\.liste\.length \|\| state\.chargement\) return/);
  assert.match(ECRAN, /if \(state\.lue && !force\) return/);
  // Et l'agent garde un moyen de relire quand il a corrige la cause.
  assert.match(ECRAN, /chargerListe\(\{ force: true \}\)/);
  assert.match(ECRAN, /themes\.retry/);
});

test('thème : une base VIDE le dit, et dit quoi faire', () => {
  // Ce n'est pas une panne : l'import n'a simplement pas ete lance. Le message doit nommer
  // la commande, sinon l'agent reste devant un ecran muet.
  assert.match(ECRAN, /themes\.none_in_db/);
  assert.match(ECRAN, /themes\.load_failed/);
  const { themes } = JSON.parse(readFileSync(join(RACINE, 'locales/fr.json'), 'utf8'));
  assert.match(themes.none_in_db, /thematiques import/);
  assert.match(themes.load_failed, /redémarr/i);
});

test('thème : l’écran prévient de ce qui N’EST PAS une panne après une pose', () => {
  // Mesuré en direct sur coc-europe.com le 05/10/2026 : les sept rubriques posées ont
  // semblé rendre 404 pendant quelques minutes — OPcache relit config.php toutes les deux
  // secondes, et nginx garde la réponse FastCGI trois cents secondes. Et les anciennes
  // rubriques rendent 403, non 404 : leur dossier existe encore, sans index à servir.
  // Sans cette phrase, l'agent croit son changement raté et recommence.
  assert.match(ECRAN, /function noteApres\(/);
  assert.match(ECRAN, /themes\.after_note/);
  // Elle ne s'affiche QU'APRES une pose reussie : un avertissement permanent ne se lit plus.
  assert.match(ECRAN, /state\.poses\.values\(\)\]\.some\(\(p\) => p\.state === 'done'\)/);
  const { themes } = JSON.parse(readFileSync(join(RACINE, 'locales/fr.json'), 'utf8'));
  // Elle doit nommer les deux faits, sinon elle ne sert a rien.
  assert.match(themes.after_note, /minute/i);
  assert.match(themes.after_note, /refus/i);
  assert.match(themes.after_note, /disque/i);
});

test('thème : les messages nomment leurs variables, et disent le geste qui suit', () => {
  const { themes, errors } = JSON.parse(readFileSync(join(RACINE, 'locales/fr.json'), 'utf8'));
  assert.match(themes.allow_orphans_hint, /\{count\}/);
  assert.match(themes.ready, /\{count\}.*\{total\}/);
  assert.match(themes.applied, /\{count\}.*\{total\}/);
  assert.match(themes.restored, /\{domain\}.*\{count\}/);
  assert.match(themes.incomplete_warn, /\{count\}.*\{slugs\}/);
  assert.match(errors.theme_restore_syntax, /\{domain\}/);
  // L'avertissement doit parler d'ARTICLES, pas de « cibles » : c'est ce que l'agent perd.
  assert.match(themes.allow_orphans_hint, /article/i);
  // Et la note sur les textes doit renvoyer à l'éditeur, sans quoi l'agent reste sans geste.
  assert.match(themes.texts_note, /diteur/);
  // Un échec de retour arrière doit dire quoi faire, pas seulement qu'il a échoué.
  assert.match(themes.rollback_failed, /main|sauvegarde/i);
});
