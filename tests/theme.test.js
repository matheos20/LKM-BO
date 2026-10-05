import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MARQUE, THEME_APPLY, THEME_BACKUPS, THEME_RESTORE } from '../src/services/themeScripts.js';

/**
 * Le changement de thématique, éprouvé sur du VRAI PHP et un vrai disque.
 *
 * LA PROMESSE À TENIR EST CELLE DU CAHIER DES CHARGES : « garantir que le processus de
 * restauration soit 100 % fiable en cas d'erreur ». Une promesse pareille ne se tient pas
 * par une relecture de code ; elle se tient en posant une thématique sur un site, en
 * revenant en arrière, et en comparant OCTET PAR OCTET ce qu'on retrouve avec ce qu'on
 * avait. C'est ce que fait ce fichier.
 *
 * Le site d'essai reproduit ce qui a été mesuré sur le parc le 05/10/2026 : un
 * `config.php` qui déclare `$categories` avec nom, icône et description, un
 * `wp_summary.json` qui porte la même liste pour la synchronisation WordPress, un
 * `category.php` sans lequel une rubrique n'a rien pour s'afficher, et des dossiers de
 * rubrique contenant des articles.
 */
const phpAbsent = spawnSync('php', ['-v'], { encoding: 'utf8' }).status !== 0;

const CATEGORY_PHP = '<?php /* moteur de rubrique */\n';
/**
 * Le contenu d'un `index.php` de rubrique, RELEVÉ SUR LE PARC et non imaginé.
 *
 * Une première version de ce fichier portait « <?php require __DIR__ .
 * '/../category.php'; » — exactement ce que l'implémentation écrivait alors. Le test
 * passait, et les sept rubriques posées sur coc-europe.com rendaient 404 : sans
 * `$category`, le moteur ne sait pas quelle rubrique afficher. **Un témoin tiré de
 * l'imagination ne valide que l'imagination.** Celui-ci vient d'une sauvegarde réelle.
 */
const indexRubrique = (slug) => `<?php\n$category = '${slug}';\ninclude __DIR__ . '/../category.php';\n`;

/**
 * Un `config.php` de la forme exacte relevée sur le parc.
 *
 * LES APOSTROPHES SONT ÉCHAPPÉES, et c'est ainsi que les vrais fichiers du parc les
 * écrivent : « 'description' => 'L\'actualité santé et médecine' ». Une première version de
 * ce générateur les posait nues, ce qui produisait un PHP illégal — et le script,
 * erreurs en sourdine, mourait avec le code 255 sans un mot. Le défaut était dans
 * l'éprouvette, mais il a révélé le vrai : voir l'essai du config.php cassé.
 */
const php = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function configPhp(rubriques, { nom = 'Essai' } = {}) {
  const lignes = rubriques.map(
    (r) => `    '${php(r.slug)}' => ['name' => '${php(r.name)}', 'icon' => '${php(r.icon ?? '')}', 'description' => '${php(r.description ?? '')}'],`,
  );
  return [
    '<?php',
    `$site_name = '${php(nom)}';`,
    '$categories = [',
    ...lignes,
    '];',
    "$homepage_sections = ['hero_full', 'categories_banner'];",
    "$homepage = ['meta_description' => 'Le texte propre a CE site, qui ne doit jamais bouger'];",
    '',
  ].join('\n');
}

/** Le site d'essai : la thématique SANTÉ, avec des articles dans trois rubriques. */
const SANTE = [
  { slug: 'actu', name: 'Actu', icon: '📰', description: "L'actualite sante et medecine" },
  { slug: 'bien-etre', name: 'Bien-etre', icon: '🧘', description: 'Bien-etre et equilibre de vie' },
  { slug: 'grossesse', name: 'Grossesse', icon: '🤰', description: 'Grossesse, maternite et bebe' },
];

/** La thématique visée : SPORT. Elle ne partage que « actu » avec la précédente. */
const SPORT = [
  { slug: 'actu', name: 'Actu', icon: '📰', description: "L'actualite du sport" },
  { slug: 'foot', name: 'Foot', icon: '⚽', description: 'Football, clubs et competitions' },
  { slug: 'velo', name: 'Velo', icon: '🚴', description: 'Velo, cyclisme et equipement' },
];

const DOMAINE = 'site-essai.fr';

/**
 * Monte un site jetable et rend de quoi agir dessus.
 *
 * Rien n'est simulé : c'est du PHP qui tourne, sur de vrais fichiers, et c'est le disque
 * relu qui fait foi — jamais ce que le script dit avoir fait.
 */
function parc({ rubriques = SANTE, articles = {}, avecMoteur = true, avecJson = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lkm-them-'));
  const doc = join(root, DOMAINE, 'public_html');
  mkdirSync(doc, { recursive: true });
  writeFileSync(join(doc, 'config.php'), configPhp(rubriques), 'utf8');
  if (avecMoteur) writeFileSync(join(doc, 'category.php'), CATEGORY_PHP, 'utf8');
  if (avecJson) {
    writeFileSync(
      join(doc, 'wp_summary.json'),
      JSON.stringify({
        articles_wp_published: 42,
        wp_categories: rubriques.length,
        wp_categories_list: rubriques.map((r) => ({ slug: r.slug, name: r.name })),
        wp_site_url: `https://${DOMAINE}`,
      }),
      'utf8',
    );
  }
  for (const r of rubriques) {
    mkdirSync(join(doc, r.slug), { recursive: true });
    writeFileSync(join(doc, r.slug, 'index.php'), indexRubrique(r.slug), 'utf8');
  }
  // Des articles, là où l'essai en demande.
  for (const [slug, noms] of Object.entries(articles)) {
    mkdirSync(join(doc, slug), { recursive: true });
    for (const nom of noms) writeFileSync(join(doc, slug, nom), `<?php /* ${nom} */\n`, 'utf8');
  }

  const php = (script, env) => {
    const res = spawnSync('php', [], { input: script, encoding: 'utf8', env: { ...process.env, LKM_ROOT: root, ...env } });
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  };

  return {
    root,
    doc,
    /** L'empreinte du site : chaque fichier et son contenu, pour comparer avant/après. */
    empreinte() {
      const out = new Map();
      const descendre = (rel) => {
        for (const nom of readdirSync(join(doc, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const r = rel ? `${rel}/${nom.name}` : nom.name;
          // Les sauvegardes ne font pas partie du site : elles s'ajoutent à chaque pose,
          // et les compter ferait échouer toute comparaison.
          if (r.startsWith('.lkm-backups')) continue;
          if (nom.isDirectory()) descendre(r);
          else out.set(r, readFileSync(join(doc, r), 'utf8'));
        }
      };
      descendre('');
      return out;
    },
    lire: (rel) => (existsSync(join(doc, rel)) ? readFileSync(join(doc, rel), 'utf8') : null),
    modeDe: (rel) => (existsSync(join(doc, rel)) ? (statSync(join(doc, rel)).mode & 0o777).toString(8) : null),
    sauvegardes: () => {
      const b = join(doc, '.lkm-backups', 'thematiques');
      return existsSync(b) ? readdirSync(b).sort() : [];
    },
    poser: (voulu, { mode = 'apply', stamp = '20261005-120000' } = {}) =>
      php(THEME_APPLY, {
        LKM_MODE: mode,
        LKM_STAMP: stamp,
        LKM_B64: Buffer.from(JSON.stringify({ [DOMAINE]: voulu }), 'utf8').toString('base64'),
      }).sites[0],
    listerSauvegardes: () =>
      php(THEME_BACKUPS, { LKM_B64: Buffer.from(JSON.stringify([DOMAINE]), 'utf8').toString('base64') }).sites[0],
    restaurer: (stamp = '20261005-120000') => php(THEME_RESTORE, { LKM_DOMAIN: DOMAINE, LKM_STAMP: stamp }),
    fermer: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ─────────────────────────── l'analyse préalable ───────────────────────────

test('thème : l’analyse dit ce qui change, SANS rien toucher', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  const p = parc({ articles: { 'bien-etre': ['a.php', 'b.php'], grossesse: ['c.php'] } });
  try {
    const avant = p.empreinte();
    const vu = p.poser(SPORT, { mode: 'scan' });
    assert.deepEqual(vu.created.sort(), ['foot', 'velo']);
    assert.deepEqual(vu.dropped.sort(), ['bien-etre', 'grossesse']);
    assert.deepEqual(vu.kept, ['actu']);
    // RIEN n'a bougé : une analyse est une lecture.
    assert.deepEqual([...p.empreinte()], [...avant]);
    assert.equal(p.sauvegardes().length, 0, 'et aucune sauvegarde n’est prise pour rien');
  } finally {
    p.fermer();
  }
});

test('thème : l’analyse COMPTE les articles qui perdront leur rubrique', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  // C'est la conséquence la plus lourde d'un changement de thématique, et elle doit être
  // chiffrée avant que l'agent décide. Mesuré sur le parc : un site tiré au hasard portait
  // 84 articles répartis dans huit rubriques.
  const p = parc({ articles: { 'bien-etre': ['a.php', 'b.php', 'c.php'], grossesse: ['d.php'], actu: ['garde.php'] } });
  try {
    const vu = p.poser(SPORT, { mode: 'scan' });
    assert.equal(vu.orphans, 4, 'trois de bien-etre et un de grossesse');
    assert.deepEqual(vu.orphansBySlug, { 'bien-etre': 3, grossesse: 1 });
    // « actu » reste au menu : son article n'est pas orphelin.
    assert.ok(!('actu' in vu.orphansBySlug));
  } finally {
    p.fermer();
  }
});

test('thème : un site sans moteur de rubrique est refusé, pas abîmé', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  // Sans `category.php`, les dossiers posés n'auraient rien pour s'afficher.
  const p = parc({ avecMoteur: false });
  try {
    const avant = p.empreinte();
    assert.equal(p.poser(SPORT).error, 'engine');
    assert.deepEqual([...p.empreinte()], [...avant]);
  } finally {
    p.fermer();
  }
});

test('thème : un config.php CASSÉ ne fait pas perdre tout le lot', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  // LE DÉFAUT LE PLUS SOURNOIS RENCONTRÉ SUR CE MODULE. Avec les erreurs en sourdine, un
  // « include » d'un config.php au PHP illégal provoque une erreur fatale : le processus
  // s'arrête avec le code 255, SANS AUCUNE SORTIE, et les vingt sites du lot sont perdus
  // pour un seul fichier abîmé. Vérifié le 05/10/2026 ; l'inclusion est donc sous garde.
  const p = parc();
  try {
    writeFileSync(join(p.doc, 'config.php'), '<?php $categories = [ ;;; invalide\n', 'utf8');
    const vu = p.poser(SPORT, { mode: 'scan' });
    assert.equal(vu.error, 'config', 'le site est signalé…');
    assert.equal(vu.domain, DOMAINE, '…et il est nommé');
  } finally {
    p.fermer();
  }
});

test('thème : une thématique vide est refusée', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  const p = parc();
  try {
    assert.equal(p.poser([]).error, 'empty');
    assert.equal(p.poser([{ slug: 'Majuscule', name: 'Non' }]).error, 'empty');
  } finally {
    p.fermer();
  }
});

// ─────────────────────────── la pose ───────────────────────────

test('thème : poser une thématique sauvegarde D’ABORD', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  const p = parc();
  try {
    const vu = p.poser(SPORT);
    assert.ok(vu.done.includes('backup'), 'la sauvegarde doit précéder tout le reste');
    assert.equal(vu.done[0], 'backup');
    assert.deepEqual(p.sauvegardes(), ['20261005-120000']);

    // Ce qui est dans la sauvegarde : la configuration, le résumé, et chaque index d'avant.
    const bk = '.lkm-backups/thematiques/20261005-120000';
    assert.ok(p.lire(`${bk}/manifest.json`));
    assert.ok(p.lire(`${bk}/config.php`).includes('grossesse'));
    assert.ok(p.lire(`${bk}/wp_summary.json`));
    for (const r of SANTE) assert.ok(p.lire(`${bk}/index--${r.slug}.php`), `${r.slug} doit être sauvegardé`);

    const m = JSON.parse(p.lire(`${bk}/manifest.json`));
    assert.equal(m.marker, MARQUE);
    assert.equal(m.domain, DOMAINE);
    assert.deepEqual(m.before.sort(), ['actu', 'bien-etre', 'grossesse']);
    assert.deepEqual(m.after.sort(), ['actu', 'foot', 'velo']);
  } finally {
    p.fermer();
  }
});

test('thème : les nouvelles rubriques reçoivent leur dossier et leur index', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  const p = parc();
  try {
    p.poser(SPORT);
    for (const slug of ['foot', 'velo']) {
      assert.equal(p.lire(`${slug}/index.php`), indexRubrique(slug), `${slug} doit être servi`);
      // Le compte du site tourne sous son propre utilisateur : en 0640, PHP ne pourrait
      // pas lire le fichier, et la rubrique ne s'afficherait jamais.
      //
      // Le contrôle ne vaut que sur un système POSIX : sous Windows, où ces essais
      // tournent souvent, les droits n'existent pas et `chmod(0644)` rend 0666. Que le
      // script appelle bien `chmod` est vérifié à part, sur son texte.
      if (process.platform !== 'win32') assert.equal(p.modeDe(`${slug}/index.php`), '644');
    }
    assert.equal(p.lire('actu/index.php'), indexRubrique('actu'), 'une rubrique gardée n’est pas touchée');
  } finally {
    p.fermer();
  }
});

test('thème : l’index posé DECLARE la rubrique, sans quoi la page rend 404', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  // C'est le défaut trouvé en direct sur coc-europe.com : les sept rubriques
  // posées rendaient 404 quand l'accueil rendait 200, parce que le fichier n'écrivait
  // que l'inclusion du moteur. Sans « $category », celui-ci ne sait rien afficher.
  const p = parc();
  try {
    p.poser(SPORT);
    for (const slug of ['foot', 'velo']) {
      const lu = p.lire(`${slug}/index.php`);
      // `includes` et non une expression régulière : le « $ » y serait une ancre de fin
      // de chaîne, et l'assertion ne vérifierait rien du tout.
      assert.ok(lu.includes(`$category = '${slug}';`), `« ${slug} » doit se nommer : ${JSON.stringify(lu)}`);
      assert.ok(lu.includes("include __DIR__ . '/../category.php';"));
      // Et c'est exactement la forme des fichiers du parc.
      assert.equal(lu, indexRubrique(slug));
    }
    // Et une rubrique gardée n'est pas réécrite : son fichier d'origine reste.
    assert.equal(p.lire('actu/index.php'), indexRubrique('actu'));
  } finally {
    p.fermer();
  }
});

test('thème : UN DOSSIER QUI CONTIENT DES ARTICLES N’EST JAMAIS SUPPRIMÉ', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  // C'est le garde-fou le plus important de tout le module. Les articles d'une rubrique
  // qui quitte le menu restent sur le disque : seul leur index s'en va.
  const p = parc({ articles: { 'bien-etre': ['article-precieux.php', 'autre.php'] } });
  try {
    p.poser(SPORT);
    assert.equal(p.lire('bien-etre/index.php'), null, 'la rubrique quitte le menu');
    assert.ok(p.lire('bien-etre/article-precieux.php'), 'mais l’article reste');
    assert.ok(p.lire('bien-etre/autre.php'));
    // « grossesse » était vide : son dossier, lui, peut disparaître.
    assert.equal(p.lire('grossesse/index.php'), null);
    assert.ok(!existsSync(join(p.doc, 'grossesse')), 'un dossier vide s’en va');
  } finally {
    p.fermer();
  }
});

test('thème : wp_summary.json suit le nouveau menu', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  const p = parc();
  try {
    p.poser(SPORT);
    const j = JSON.parse(p.lire('wp_summary.json'));
    assert.equal(j.wp_categories, 3);
    assert.deepEqual(j.wp_categories_list.map((c) => c.slug).sort(), ['actu', 'foot', 'velo']);
    // Ce qui ne concerne pas les rubriques est conservé tel quel.
    assert.equal(j.articles_wp_published, 42);
    assert.equal(j.wp_site_url, `https://${DOMAINE}`);
  } finally {
    p.fermer();
  }
});

test('thème : le script NE TOUCHE PAS à config.php', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  // Le fichier le plus fragile du site emprunte le circuit de publication du back-office :
  // reconstruit, validé, sauvegardé, contrôlé par « php -l », relu après écriture et
  // restauré tout seul en cas d'écart. Le script, lui, n'y écrit rien.
  const p = parc();
  try {
    const avant = p.lire('config.php');
    p.poser(SPORT);
    assert.equal(p.lire('config.php'), avant);
  } finally {
    p.fermer();
  }
});

test('thème : les textes propres au site ne sont pas dans le périmètre', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  // Mesuré sur 80 sites de vps-004 : les textes de la page d'accueil sont UNIQUES à chaque
  // site — treize sites d'une même thématique avaient treize `meta_description`
  // différentes. Les réécrire détruirait l'identité éditoriale de chaque site.
  const p = parc();
  try {
    p.poser(SPORT);
    assert.ok(p.lire('config.php').includes('Le texte propre a CE site, qui ne doit jamais bouger'));
  } finally {
    p.fermer();
  }
});

// ─────────────────────────── la restauration ───────────────────────────

test('thème : L’ALLER-RETOUR REND LE SITE OCTET POUR OCTET', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  // C'est la promesse du cahier des charges, et elle se vérifie ainsi : on relève tout le
  // site, on pose une thématique, on revient, et on compare fichier par fichier.
  const p = parc({ articles: { 'bien-etre': ['a.php', 'b.php'], grossesse: ['c.php'], actu: ['d.php'] } });
  try {
    const avant = p.empreinte();

    const pose = p.poser(SPORT);
    assert.ok(pose.done.includes('backup'));
    assert.notDeepEqual([...p.empreinte()], [...avant], 'la pose doit bien avoir changé quelque chose');

    const retour = p.restaurer();
    assert.ok(!retour.error, `restauration en échec : ${retour.error ?? ''} ${retour.detail ?? ''}`);
    assert.deepEqual(retour.failed, []);

    const apres = p.empreinte();
    assert.deepEqual([...apres.keys()].sort(), [...avant.keys()].sort(), 'les mêmes fichiers, ni plus ni moins');
    for (const [chemin, contenu] of avant) {
      assert.equal(apres.get(chemin), contenu, `« ${chemin} » doit être identique`);
    }
  } finally {
    p.fermer();
  }
});

test('thème : la restauration remet les rubriques d’avant et retire celles d’après', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  const p = parc();
  try {
    p.poser(SPORT);
    const retour = p.restaurer();
    assert.ok(retour.restored.includes('config.php'));
    assert.ok(retour.restored.includes('wp_summary.json'));
    for (const slug of ['actu', 'bien-etre', 'grossesse']) {
      assert.ok(retour.restored.includes(`${slug}/index.php`), `${slug} doit revenir`);
      assert.equal(p.lire(`${slug}/index.php`), indexRubrique(slug));
    }
    assert.deepEqual(retour.removed.sort(), ['foot', 'velo']);
    assert.ok(!existsSync(join(p.doc, 'foot')));
    assert.ok(!existsSync(join(p.doc, 'velo')));
  } finally {
    p.fermer();
  }
});

test('thème : un article écrit APRÈS le changement survit à la restauration', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  // Revenir en arrière ne doit pas effacer un travail fait entre-temps. Le dossier d'une
  // rubrique créée par la pose n'est retiré que s'il est vide.
  const p = parc();
  try {
    p.poser(SPORT);
    writeFileSync(join(p.doc, 'foot', 'match-du-weekend.php'), '<?php /* ecrit apres */\n', 'utf8');

    const retour = p.restaurer();
    assert.deepEqual(retour.kept, ['foot'], '« foot » contient un article : son dossier reste');
    assert.ok(p.lire('foot/match-du-weekend.php'), 'et l’article avec lui');
    assert.deepEqual(retour.removed, ['velo'], '« velo » était vide : il s’en va');
    // Son index, en revanche, n'a plus de raison d'être : la rubrique n'est plus au menu.
    assert.equal(p.lire('foot/index.php'), null);
  } finally {
    p.fermer();
  }
});

test('thème : l’état courant est sauvegardé AVANT d’être remplacé', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  // Une restauration malheureuse resterait sinon sans retour.
  const p = parc();
  try {
    p.poser(SPORT);
    const apresPose = p.lire('config.php');
    p.restaurer();
    const garde = p.lire('.lkm-backups/thematiques/20261005-120000-avant-restauration/config.php');
    assert.equal(garde, apresPose, 'ce qui était en place doit avoir été mis de côté');
  } finally {
    p.fermer();
  }
});

test('thème : on peut restaurer DEUX FOIS — la sauvegarde n’est pas consommée', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  const p = parc();
  try {
    const avant = p.empreinte();
    p.poser(SPORT);
    p.restaurer();
    p.poser(SPORT, { stamp: '20261005-130000' });
    const retour = p.restaurer('20261005-120000');
    assert.ok(!retour.error);
    for (const [chemin, contenu] of avant) assert.equal(p.empreinte().get(chemin), contenu, chemin);
  } finally {
    p.fermer();
  }
});

test('thème : un config.php sauvegardé invalide est REFUSÉ, pas mis en place', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  // Un fichier sauvegardé est en principe valide — mais « en principe » n'est pas une
  // garantie, et un config.php cassé rend tout le site blanc. Il passe donc par « php -l ».
  const p = parc();
  try {
    p.poser(SPORT);
    const bk = join(p.doc, '.lkm-backups', 'thematiques', '20261005-120000');
    writeFileSync(join(bk, 'config.php'), '<?php $categories = [ ;;; invalide\n', 'utf8');
    const apresPose = p.lire('config.php');

    const retour = p.restaurer();
    assert.equal(retour.error, 'syntax');
    assert.equal(p.lire('config.php'), apresPose, 'le fichier en place ne doit pas avoir bougé');
    assert.ok(!existsSync(join(p.doc, '.lkm-config-restore.php')), 'et rien ne doit traîner');
  } finally {
    p.fermer();
  }
});

test('thème : une sauvegarde incomplète est refusée AVANT qu’on touche à quoi que ce soit', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  const p = parc();
  try {
    p.poser(SPORT);
    rmSync(join(p.doc, '.lkm-backups', 'thematiques', '20261005-120000', 'index--bien-etre.php'));
    const apres = p.empreinte();

    const retour = p.restaurer();
    assert.equal(retour.error, 'incomplete');
    assert.deepEqual([...p.empreinte()], [...apres], 'le site doit être intact');
  } finally {
    p.fermer();
  }
});

test('thème : une sauvegarde inconnue, ou d’un autre site, est refusée', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  const p = parc();
  try {
    p.poser(SPORT);
    assert.equal(p.restaurer('20200101-000000').error, 'no_backup');
    assert.equal(p.restaurer('pas-un-horodatage').error, 'invalid');

    // Un manifeste qui nomme un autre domaine ne doit pas servir à restaurer celui-ci.
    const f = join(p.doc, '.lkm-backups', 'thematiques', '20261005-120000', 'manifest.json');
    const m = JSON.parse(readFileSync(f, 'utf8'));
    writeFileSync(f, JSON.stringify({ ...m, domain: 'un-autre.fr' }), 'utf8');
    assert.equal(p.restaurer().error, 'no_backup');
  } finally {
    p.fermer();
  }
});

// ─────────────────────────── la liste des sauvegardes ───────────────────────────

test('thème : les sauvegardes se listent, de la plus récente à la plus ancienne', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  const p = parc();
  try {
    p.poser(SPORT, { stamp: '20261005-100000' });
    p.poser(SANTE, { stamp: '20261005-110000' });
    const vu = p.listerSauvegardes();
    assert.deepEqual(vu.backups.map((b) => b.stamp), ['20261005-110000', '20261005-100000']);
    assert.ok(vu.backups.every((b) => b.complete), 'toutes doivent être complètes');
    assert.deepEqual(vu.backups[1].before.sort(), ['actu', 'bien-etre', 'grossesse']);
    assert.deepEqual(vu.backups[1].after.sort(), ['actu', 'foot', 'velo']);
  } finally {
    p.fermer();
  }
});

test('thème : une sauvegarde amputée est listée comme INCOMPLÈTE, pas cachée', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  // La cacher laisserait croire qu'il n'y a rien à restaurer ; la proposer comme bonne
  // ferait échouer la restauration au pire moment. On la montre, et on la dit telle.
  const p = parc();
  try {
    p.poser(SPORT);
    rmSync(join(p.doc, '.lkm-backups', 'thematiques', '20261005-120000', 'index--actu.php'));
    const vu = p.listerSauvegardes();
    assert.equal(vu.backups.length, 1);
    assert.equal(vu.backups[0].complete, false);
  } finally {
    p.fermer();
  }
});

test('thème : un dossier sans notre marque n’est pas pris pour une sauvegarde', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  const p = parc();
  try {
    const faux = join(p.doc, '.lkm-backups', 'thematiques', '20991231-235959');
    mkdirSync(faux, { recursive: true });
    writeFileSync(join(faux, 'manifest.json'), JSON.stringify({ domain: DOMAINE, files: [] }), 'utf8');
    assert.deepEqual(p.listerSauvegardes().backups, []);
  } finally {
    p.fermer();
  }
});

test('thème : un site sans sauvegarde le dit, il ne jette pas', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  const p = parc();
  try {
    assert.deepEqual(p.listerSauvegardes(), { domain: DOMAINE, backups: [] });
  } finally {
    p.fermer();
  }
});

// ─────────────────────────── ce que les scripts doivent garder ───────────────────────────

test('thème : les sauvegardes vivent hors d’atteinte du web', async (t) => {
  // nginx refuse tout chemin commençant par un point — vérifié en direct : 403. Un
  // « config.php.20261005 » posé dans public_html, lui, serait servi en clair et
  // exposerait toute la configuration du site.
  assert.match(THEME_APPLY, /\.lkm-backups\/thematiques/);
  assert.match(THEME_RESTORE, /\.lkm-backups\/thematiques/);
  // Et les fichiers posés sont lisibles par le compte DU SITE : en 0640, PHP ne les
  // verrait pas.
  assert.match(THEME_APPLY, /chmod\(\$bk \. '\/' \. \$nom, 0644\)/);
});

test('thème : la restauration ne devine rien, elle lit le manifeste', async () => {
  assert.match(THEME_RESTORE, /manifest\.json/);
  assert.match(THEME_RESTORE, /\$j\['before'\]/);
  assert.match(THEME_RESTORE, /\$j\['created'\]/);
  // Elle refuse un manifeste qui n'est pas le nôtre, ou qui nomme un autre site.
  assert.match(THEME_RESTORE, /\$MARQUE/);
  assert.match(THEME_RESTORE, /\$j\['domain'\].*!== \$domain/);
});

test('thème : aucun des scripts ne supprime en masse', async () => {
  // Un « rm -rf » ou un unlink sur un dossier entier n'a rien à faire ici : tout ce qui
  // s'en va s'en va fichier par fichier, et nommé.
  for (const script of [THEME_APPLY, THEME_BACKUPS, THEME_RESTORE]) {
    assert.ok(!/rm\s+-rf/.test(script));
    assert.ok(!/shell_exec\(\s*['"]rm/.test(script));
    assert.ok(!/unlink\(\$d\)/.test(script), 'un dossier ne se supprime pas par unlink');
  }
  // La seule commande externe est le contrôle de syntaxe.
  assert.match(THEME_RESTORE, /-l /);
  assert.ok(!/shell_exec/.test(THEME_APPLY), 'la pose n’a besoin d’aucune commande externe');
});
