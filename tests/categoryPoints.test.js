import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { diffPoint, pageRubrique } from '../src/services/categoryRestore.js';

/**
 * LES POINTS DE RESTAURATION DES RUBRIQUES.
 *
 * CE QUI A MOTIVÉ CE MÉCANISME. L'écran savait créer et savait supprimer, mais n'offrait
 * aucun retour. Une première version proposait d'annuler « le dernier geste » : elle ne
 * servait qu'une fois, et seulement si l'agent n'avait pas rechargé sa page. Ce qu'il
 * fallait est plus simple à comprendre et sert toujours — une liste de dates, et
 * « remets le site comme il était à ce moment-là ». Le même geste couvre les trois cas :
 * une rubrique AJOUTÉE repart, une rubrique MODIFIÉE retrouve son nom, son icône et sa
 * description, une rubrique SUPPRIMÉE revient avec sa page.
 *
 * CE QUE LA MESURE A MONTRÉ, le 07/10/2026, sur une copie d'`oxygenesportsnature.org`.
 * En retirant « velo », qui porte 3 articles :
 *
 *                        avant   après
 *   avertissements PHP       0       2
 *   adresses au plan du site 2       0
 *   page de la rubrique    oui     non
 *   articles sur disque      3       3
 *
 * Les articles ne sont pas effacés : ils deviennent introuvables. Le retour les rend
 * visibles de nouveau, et c'est tout l'objet de ce qui suit.
 */
const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const ECRAN = readFileSync(join(RACINE, 'public/js/categories.js'), 'utf8');
const SERVICE = readFileSync(join(RACINE, 'src/services/categoryService.js'), 'utf8');
const RESTORE = readFileSync(join(RACINE, 'src/services/categoryRestore.js'), 'utf8');
const ROUTE = readFileSync(join(RACINE, 'src/routes/categories.js'), 'utf8');
const LANGUES = ['fr', 'en', 'es', 'it', 'pt', 'de'];
const locale = (l) => JSON.parse(readFileSync(join(RACINE, `locales/${l}.json`), 'utf8'));

/** Le corps d'une fonction du module, pour l'examiner de près. */
function corps(source, nom) {
  const debut = source.indexOf(`function ${nom}(`);
  assert.ok(debut >= 0, `« ${nom} » doit exister`);
  const suite = source.slice(debut);
  const fin = suite.indexOf('\n}\n');
  return suite.slice(0, fin > 0 ? fin : 2500);
}

const rub = (name, icon = '', description = '') => ({ name, icon, description });

// ─────────────────────── ce que le retour changerait ───────────────────────

test('points : le retour annonce ce qui revient, ce qui part et ce qui change de nom', () => {
  const d = diffPoint({
    then: { actu: rub('Actu', '📰'), velo: rub('Vélo', '🚴'), basket: rub('Basket', '🏀') },
    now: { actu: rub('Actu', '📰'), basket: rub('BASKET MODIFIE', '🏀🏀'), nouvelle: rub('Nouvelle') },
    articles: { nouvelle: 0 },
  });
  assert.deepEqual(d.revient, ['velo'], 'la rubrique supprimée revient');
  assert.deepEqual(d.part, ['nouvelle'], 'la rubrique ajoutée repart');
  assert.deepEqual(d.change, ['basket'], 'la rubrique renommée retrouve son nom');
  assert.equal(d.identique, false);
});

test('points : une rubrique dont SEULE l’icône a changé compte comme changée', () => {
  // Le nom suffit rarement : l'icône et la description sont ce que le visiteur voit dans
  // le menu, et les taire ferait croire que rien ne bougerait.
  for (const champ of ['name', 'icon', 'description']) {
    const alors = { foot: rub('Foot', '⚽', 'Football') };
    const maintenant = { foot: { ...alors.foot, [champ]: 'autre chose' } };
    assert.deepEqual(diffPoint({ then: alors, now: maintenant }).change, ['foot'], `« ${champ} » doit compter`);
  }
});

test('points : les ARTICLES des rubriques qui partent sont comptés', () => {
  // C'est le seul chiffre qui peut faire renoncer : ces articles restent sur le serveur
  // mais sortent du plan du site et du menu.
  const d = diffPoint({
    then: { actu: rub('Actu') },
    now: { actu: rub('Actu'), velo: rub('Vélo'), foot: rub('Foot') },
    articles: { velo: 3, foot: 5 },
  });
  assert.deepEqual(d.part.sort(), ['foot', 'velo']);
  assert.equal(d.orphelins, 8);
  assert.deepEqual(d.articlesParRubrique, { velo: 3, foot: 5 });
  // Les articles des rubriques qui RESTENT ne sont jamais comptés : rien ne leur arrive.
  assert.equal(diffPoint({ then: { a: rub('A') }, now: { a: rub('A') }, articles: { a: 99 } }).orphelins, 0);
});

test('points : l’ORDRE du menu compte autant que son contenu', () => {
  // Le visiteur voit la barre de navigation, pas le fichier. Deux menus aux mêmes
  // rubriques dans un ordre différent ne sont pas le même menu.
  const memes = { a: rub('A'), b: rub('B') };
  assert.equal(diffPoint({ then: memes, now: memes }).ordreChange, false);
  assert.equal(diffPoint({ then: { a: rub('A'), b: rub('B') }, now: { b: rub('B'), a: rub('A') } }).ordreChange, true);
  assert.equal(diffPoint({ then: { a: rub('A'), b: rub('B') }, now: { b: rub('B'), a: rub('A') } }).identique, false);
});

test('points : quand rien ne changerait, l’écran peut le dire', () => {
  const memes = { actu: rub('Actu', '📰', 'Les nouvelles') };
  const d = diffPoint({ then: memes, now: memes });
  assert.equal(d.identique, true);
  assert.deepEqual([d.revient, d.part, d.change], [[], [], []]);
  // Et une entrée absente ne doit pas faire tomber le calcul.
  assert.equal(diffPoint().identique, true);
  assert.equal(diffPoint({}).orphelins, 0);
});

// ─────────────────────── la page d'une rubrique ───────────────────────

test('points : la page d’une rubrique se REFABRIQUE, elle ne se sauvegarde pas', () => {
  // Elle ne contient aucune information propre : trois lignes qui se déduisent du nom.
  // C'est ce qui permet de n'avoir rien à sauvegarder de plus que `config.php`.
  assert.equal(pageRubrique('velo'), "<?php\n$category = 'velo';\ninclude __DIR__ . '/../category.php';\n");
  assert.match(RESTORE, /function pageDe\(\$slug\)/, 'le script en fabrique sa propre copie');
  assert.match(RESTORE, /var_export\(\$slug, true\)/, 'et il échappe le nom comme PHP le fait');
});

test('points : une page retouchée à la main n’est JAMAIS effacée', () => {
  // Mieux vaut une rubrique de trop qu'un travail effacé. Mesuré : sur
  // `oxygenesportsnature.org`, « contact » et « mentions-legales » sont des pages écrites
  // à la main — elles ont été reconnues et laissées en place.
  const reconcile = RESTORE.slice(RESTORE.indexOf('CATEGORY_RECONCILE'));
  assert.match(reconcile, /trim\(\(string\) \$contenu\) !== trim\(pageDe\(\$slug\)\)/, 'la page doit être EXACTEMENT la nôtre');
  assert.match(reconcile, /\$out\['custom'\]\[\] = \$slug;\n        continue;/, 'sinon on la garde, et on le dit');
});

test('points : un dossier qui contient encore des articles n’est pas supprimé', () => {
  const reconcile = RESTORE.slice(RESTORE.indexOf('CATEGORY_RECONCILE'));
  assert.match(reconcile, /if \(\$restes\) \$out\['kept'\]\[\] = \$slug;\n    else @rmdir\(\$dossier\);/);
  // Et les dossiers du moteur ne sont jamais candidats.
  assert.match(reconcile, /\$exclus = array\('parts', 'fonts', 'images', 'cache', 'wp-content'\)/);
});

test('points : un config.php illisible n’entraîne AUCUNE réconciliation', () => {
  // Sans la liste des rubriques, toute mise en accord serait une destruction à l'aveugle.
  const reconcile = RESTORE.slice(RESTORE.indexOf('CATEGORY_RECONCILE'));
  assert.match(reconcile, /if \(\$declarees === null\) \{ \$out\['error'\] = 'unreadable'; echo json_encode\(\$out\); exit; \}/);
  // Et la lecture est sous garde : un fichier cassé ne doit pas emporter le lot sans un mot.
  assert.match(reconcile, /catch \(\\Throwable \$e\) \{\n        return null;/);
});

// ─────────────────────── le service et la route ───────────────────────

test('points : le retour ne remet QUE le menu, pas tout config.php', () => {
  // `config.php` porte aussi le nom du site et ses réglages d'affichage. Un écran qui
  // s'appelle « Gérer les rubriques » n'a rien à faire du nom du site.
  const restore = SERVICE.slice(SERVICE.indexOf('async restore('), SERVICE.indexOf('async restore(') + 1800);
  assert.match(restore, /ON NE REMET QUE LE MENU, PAS TOUT LE FICHIER/);
  assert.match(restore, /this\.sites\.setCategories\(serverId, domain, rubriques, userId\)/);
  assert.ok(!/restoreBackup/.test(restore), 'le fichier entier n’est pas restauré');
  // Un point vide remettrait un site sans aucune rubrique : on refuse.
  assert.match(restore, /if \(!rubriques\.length\) throw new AppError\('errors\.category_point_empty'/);
});

test('points : seules les sauvegardes du MENU sont proposées', () => {
  // Celles de `style.css` ou d'un article appartiennent à l'éditeur. Les mêler ferait
  // choisir l'agent dans une liste où la plupart des lignes ne changent rien aux rubriques.
  const points = SERVICE.slice(SERVICE.indexOf('async points('), SERVICE.indexOf('async points(') + 600);
  assert.match(points, /filter\(\(b\) => b\.kind === 'config'\)/);
});

test('points : l’aperçu compare les DEUX états, pas un état à lui-même', () => {
  // Le premier essai regardait le `config.php` en place au lieu de celui du point visé,
  // et annonçait donc toujours « rien ne changerait ».
  const apercu = SERVICE.slice(SERVICE.indexOf('async preview('), SERVICE.indexOf('async preview(') + 1200);
  assert.match(apercu, /CATEGORY_POINT_DIFF/);
  assert.match(apercu, /LKM_POINT/);
  assert.match(apercu, /diffPoint\(brut\)/);
  // Et le nom du point est vérifié côté serveur : le navigateur ne désigne pas un fichier.
  const diff = RESTORE.slice(RESTORE.indexOf('CATEGORY_POINT_DIFF'));
  assert.match(diff, /basename\(\(string\) getenv\('LKM_POINT'\)\)/);
  assert.match(diff, /preg_match\('\/\^config-\[0-9\]\{8\}-\[0-9\]\{6\}\\\.php\$\/', \$point\)/);
});

test('points : lire est un droit d’analyse, revenir un droit d’écriture', () => {
  assert.match(ROUTE, /r\.post\('\/points', requirePermission\('bulk\.read'\), requirePermission\('design\.read'\)/);
  assert.match(ROUTE, /r\.post\('\/preview', requirePermission\('bulk\.read'\), requirePermission\('design\.read'\)/);
  assert.match(ROUTE, /r\.post\('\/restore', requirePermission\('bulk\.apply'\), requirePermission\('design\.publish'\)/);
  // Et le retour laisse une trace qui dit ce qu'il a fait, pas seulement la date visée.
  assert.match(ROUTE, /action: 'categories\.restore_point'/);
  assert.match(ROUTE, /reposée\(s\), \$\{out\.removed\?\.length \?\? 0\} retirée\(s\)/);
});

// ─────────────────────── ce que l'agent voit ───────────────────────

test('points : la liste n’est demandée qu’au moment où l’agent l’ouvre', () => {
  // Elle se lit sur le serveur. La charger pour chacun des sites d'un lot de 1 838 aurait
  // fait mille huit cent trente-huit lectures que personne n'aurait regardées.
  const panneau = corps(ECRAN, 'panneauPoints');
  assert.match(panneau, /ontoggle: \(e\) => e\.target\.open && chargerPoints\(site\)/);
  const charger = corps(ECRAN, 'chargerPoints');
  assert.match(charger, /if \(connu\?\.chargement \|\| connu\?\.liste\) return/, 'et une seule fois');
});

test('points : l’écran demande TOUJOURS l’aperçu avant de proposer le retour', () => {
  const apercu = corps(ECRAN, 'apercuPoint');
  assert.match(apercu, /categories\/preview/);
  assert.match(apercu, /if \(vu\.identique\) return toast/, 'et il ne propose rien quand rien ne changerait');
  assert.match(apercu, /confirmerPoint\(site, point, vu\)/);
});

test('points : la confirmation NOMME les rubriques et compte les articles en jeu', () => {
  const conf = corps(ECRAN, 'confirmerPoint');
  for (const cle of ['categories.points_back', 'categories.points_gone', 'categories.points_renamed']) {
    assert.ok(conf.includes(cle), `« ${cle} » doit être annoncé`);
  }
  assert.match(conf, /slugs\.join\(', '\)/, 'les noms exacts, pas seulement un nombre');
  assert.match(conf, /vu\.orphelins/, 'et les articles qui deviendraient introuvables');
});

test('points : après un retour, ce qui n’a pas été touché est DIT', () => {
  // Sans cela l'agent croirait le retour incomplet sans comprendre pourquoi.
  const retour = corps(ECRAN, 'revenirAuPoint');
  assert.match(retour, /out\.custom\?\.length/, 'les pages retouchées à la main');
  assert.match(retour, /out\.kept\?\.length/, 'les dossiers gardés pour leurs articles');
  assert.match(retour, /state\.points\.delete\(keyOf\(site\)\)/, 'et la liste des points est relue');
});

test('points : l’ancienne annulation en session n’a laissé aucune trace', () => {
  // Deux mécanismes nommés « Restaurer » auraient été deux fois plus durs à comprendre
  // qu'un seul, pour une interface qui doit se prendre en main sans formation.
  for (const mot of ['annulables', 'boutonRestaurer', 'confirmerAnnulation', 'restorable']) {
    assert.ok(!ECRAN.includes(mot), `« ${mot} » devrait avoir disparu de l’écran`);
  }
  assert.ok(!SERVICE.includes('restorable'), 'ni du service');
  for (const l of LANGUES) {
    const c = locale(l).categories;
    for (const cle of ['undo_site', 'undo_title', 'restore_title', 'restored']) {
      assert.equal(c[cle], undefined, `${l} : categories.${cle} n’a plus de point d’appel`);
    }
  }
});

test('points : l’agent est averti du sort des articles AVANT de supprimer', () => {
  // Mesuré : en retirant « velo », l'article passe de 0 à 2 avertissements PHP et le plan
  // du site de 2 adresses à 0. C'est le seul moment où l'agent peut encore changer d'avis.
  const conf = corps(ECRAN, 'confirmer');
  assert.match(conf, /suppr && articles/, 'seulement quand il y a des articles en jeu');
  assert.match(conf, /categories\.lost_warning/);
});

test('rubriques : la phrase d’en-tête SUIT le verbe', () => {
  assert.match(ECRAN, /get hintKey\(\) \{[\s\S]{0,200}categories\.explain_remove/);
  for (const l of LANGUES) {
    const c = locale(l).categories;
    assert.notEqual(c.explain_remove, c.explain, `${l} : les deux verbes ne se décrivent pas de la même façon`);
    assert.ok(c.explain_remove.length > 80, `${l} : la phrase doit expliquer, pas seulement nommer`);
  }
});

// ─────────────────────── les libellés ───────────────────────

test('points : tout se dit dans les six langues', () => {
  const attendus = [
    'points_title', 'points_hint', 'points_none', 'points_last', 'points_go', 'points_identical',
    'points_confirm_title', 'points_confirm_body', 'points_back', 'points_gone', 'points_renamed',
    'points_orphans', 'points_note', 'points_done', 'points_custom', 'points_kept', 'lost_warning',
  ];
  const gabarits = {
    points_confirm_body: ['{date}'],
    points_back: ['{count}'],
    points_gone: ['{count}'],
    points_renamed: ['{count}'],
    points_orphans: ['{count}'],
    points_done: ['{back}', '{gone}'],
    points_custom: ['{list}'],
    points_kept: ['{list}'],
  };
  for (const l of LANGUES) {
    const c = locale(l).categories;
    for (const cle of attendus) {
      assert.equal(typeof c[cle], 'string', `${l} : categories.${cle} manque`);
      assert.ok(c[cle].trim().length > 0, `${l} : categories.${cle} est vide`);
    }
    for (const [cle, vars] of Object.entries(gabarits)) {
      for (const v of vars) assert.ok(c[cle].includes(v), `${l} : categories.${cle} doit contenir ${v}`);
    }
    // La phrase qui explique le mécanisme doit nommer les trois cas, sinon elle
    // n'explique rien à quelqu'un qui découvre l'écran.
    assert.ok(c.points_hint.length > 150, `${l} : points_hint doit expliquer les trois cas`);
  }
});
