import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DuplicateService,
  MAX_RAPPROCHEMENT_GLOBAL,
  SEUIL_PROCHE,
  cleArticle,
  distance,
  grouper,
  resume,
} from '../src/services/duplicateService.js';
import { ARTICLE_FINGERPRINTS, DOSSIERS_EXCLUS, MOTS_MINIMUM } from '../src/services/duplicateScripts.js';
import { ServerLoad } from '../src/services/serverLoad.js';

/**
 * Les articles en doublon : ce que l'empreinte voit, ce que le rapprochement groupe, et
 * ce que le module refuse de faire.
 *
 * TROIS MESURES DU 05/10/2026 TIENNENT CE MODULE, et les essais ci-dessous les gardent :
 *
 *   1. l'empreinte de proximité se comporte comme annoncé — sur un texte de 588 mots, un
 *      mot changé donne 1 bit d'écart, cinq mots 4, un paragraphe ajouté 5, et un texte
 *      sans rapport 33. D'où le seuil à 6 ;
 *   2. rapprocher 17 539 articles réels coûte 8,6 s en comparant tout, 142 ms en
 *      comparant site par site, POUR EXACTEMENT LES MEMES GROUPES. Le travail se faisant
 *      dans le navigateur de l'agent, le mode par site s'enclenche au-delà d'un seuil —
 *      et l'écran doit le dire, pas le taire ;
 *   3. sur ce parc, les doublons sont tous des contenus IDENTIQUES republiés (33 groupes
 *      sur 17 539 articles) et il n'existe aucun article seulement ressemblant. Un module
 *      qui crierait au loup serait pire qu'inutile.
 *
 * Les articles sont lus COMME DU TEXTE, jamais exécutés : un essai ci-dessous le prouve
 * sur du vrai PHP, avec un article qui écrirait un fichier s'il était inclus.
 */
const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const GROUPEMENT = readFileSync(join(RACINE, 'public/js/duplicateGrouping.js'), 'utf8');
const ECRAN = readFileSync(join(RACINE, 'public/js/duplicates.js'), 'utf8');
const phpAbsent = spawnSync('php', ['-v'], { encoding: 'utf8' }).status !== 0;

// ─────────────────────────── de quoi fabriquer des empreintes ───────────────────────────

/** Une empreinte de 64 bits, en hexadécimal, comme celle que rend le serveur. */
const SIM = 'f0e1d2c3b4a59687';

/**
 * La même empreinte, avec les bits indiqués inversés.
 *
 * Les rangs sont choisis dans des octets différents dans la plupart des essais : c'est le
 * cas défavorable pour le découpage en tranches, celui où la garantie de complétude doit
 * jouer.
 */
function flip(hex, ...bits) {
  const octets = hex.match(/../g).map((h) => parseInt(h, 16));
  for (const b of bits) octets[b >> 3] ^= 1 << (b & 7);
  return octets.map((o) => o.toString(16).padStart(2, '0')).join('');
}

/** Un article tel que l'écran le reçoit. */
const art = (domain, path, md5, sim = null, extra = {}) => ({ domain, path, md5, sim, words: 400, ...extra });

const cles = (g) => g.members.map(cleArticle).sort();
const parSorte = (groupes, sorte) => groupes.filter((g) => g.kind === sorte);

/**
 * « Aucun doublon ». Le tableau rendu par `grouper` porte `nearScope` : le comparer à
 * `[]` échouerait sur une propriété qui n'est pas un groupe.
 */
const aucun = (groupes, message) => assert.equal(groupes.length, 0, message);

// ─────────────────────────── la distance ───────────────────────────

test('doublons : la distance compte les bits, et se méfie de ce qui n’en est pas une', () => {
  assert.equal(distance(SIM, SIM), 0);
  assert.equal(distance(SIM, flip(SIM, 0)), 1);
  assert.equal(distance(SIM, flip(SIM, 3, 11, 19, 27, 35, 43)), 6);
  assert.equal(distance('ffffffffffffffff', '0000000000000000'), 64);
  // Une empreinte manquante ou tronquée ne doit JAMAIS passer pour une ressemblance : un
  // article sans empreinte est à distance maximale de tout le monde.
  assert.equal(distance(null, SIM), 64);
  assert.equal(distance(SIM, undefined), 64);
  assert.equal(distance('f0e1', SIM), 64, 'une empreinte tronquée n’est pas une empreinte');
  assert.equal(distance('', ''), 64);
});

// ─────────────────────────── les contenus identiques ───────────────────────────

test('doublons : les contenus identiques se groupent par empreinte exacte', () => {
  const groupes = grouper([
    art('a.com', 'actu/x.php', 'M1'),
    art('a.com', 'actu/y.php', 'M1'),
    art('b.com', 'sante/z.php', 'M1'),
    art('a.com', 'actu/seul.php', 'M2'),
  ]);
  assert.equal(groupes.length, 1);
  assert.equal(groupes[0].kind, 'exact');
  assert.equal(groupes[0].distance, 0);
  assert.deepEqual(cles(groupes[0]), ['/a.com/actu/x.php', '/a.com/actu/y.php', '/b.com/sante/z.php']);
});

test('doublons : un article sans empreinte est écarté, pas groupé avec les autres', () => {
  // Mesuré : quatre articles de ZERO mot s'étaient retrouvés groupés comme « identiques »
  // au premier essai. Ils ne se ressemblent pas, ils sont vides.
  const groupes = grouper([
    art('a.com', 'actu/x.php', null),
    art('a.com', 'actu/y.php', null),
    art('a.com', 'actu/z.php', undefined),
  ]);
  aucun(groupes);
});

test('doublons : un article identique à un autre mais sans empreinte de proximité reste trouvé', () => {
  // `sim` est null en dessous de trois mots. La détection exacte, elle, ne dépend que du
  // md5 : elle doit continuer de fonctionner.
  const groupes = grouper([art('a.com', 'actu/x.php', 'M1', null), art('a.com', 'actu/y.php', 'M1', null)]);
  assert.equal(groupes.length, 1);
  assert.equal(groupes[0].kind, 'exact');
});

test('doublons : les groupes les plus gros passent devant', () => {
  const groupes = grouper([
    art('a.com', 'actu/1.php', 'M1'),
    art('a.com', 'actu/2.php', 'M1'),
    art('a.com', 'actu/3.php', 'M2'),
    art('a.com', 'actu/4.php', 'M2'),
    art('a.com', 'actu/5.php', 'M2'),
  ]);
  assert.deepEqual(
    groupes.map((g) => g.members.length),
    [3, 2],
  );
});

// ─────────────────────────── les contenus ressemblants ───────────────────────────

test('doublons : deux textes proches se rapprochent, deux textes étrangers non', () => {
  const proches = grouper([art('a.com', 'actu/x.php', 'M1', SIM), art('a.com', 'actu/y.php', 'M2', flip(SIM, 2, 10, 18))]);
  assert.equal(proches.length, 1);
  assert.equal(proches[0].kind, 'near');
  assert.equal(proches[0].distance, 3);

  const etrangers = grouper([art('a.com', 'actu/x.php', 'M1', SIM), art('a.com', 'actu/y.php', 'M2', '0f1e2d3c4b5a6978')]);
  aucun(etrangers);
});

test('doublons : juste au-dessus du seuil, rien n’est signalé', () => {
  const bits = [1, 9, 17, 25, 33, 41, 49];
  assert.equal(distance(SIM, flip(SIM, ...bits.slice(0, SEUIL_PROCHE))), SEUIL_PROCHE);
  assert.equal(grouper([art('a.com', 'a/1.php', 'M1', SIM), art('a.com', 'a/2.php', 'M2', flip(SIM, ...bits.slice(0, SEUIL_PROCHE)))]).length, 1);
  // Un bit de plus, et le couple n'est plus un doublon. Le seuil est mesuré, pas choisi :
  // un paragraphe ajouté à un texte de 588 mots donne 5, un texte sans rapport 33.
  aucun(grouper([art('a.com', 'a/1.php', 'M1', SIM), art('a.com', 'a/2.php', 'M2', flip(SIM, ...bits))]));
});

test('doublons : A ressemble à B, B à C — l’agent voit UNE famille, pas deux couples', () => {
  const a = SIM;
  const b = flip(SIM, 4, 12, 20);
  const c = flip(b, 5, 13, 21);
  assert.equal(distance(a, c), 6, 'A et C sont encore dans le seuil');
  const groupes = grouper([art('s.com', 'a/1.php', 'M1', a), art('s.com', 'a/2.php', 'M2', b), art('s.com', 'a/3.php', 'M3', c)]);
  assert.equal(groupes.length, 1);
  assert.equal(groupes[0].members.length, 3);
  // La distance annoncée est la PLUS GRANDE du groupe : c'est la plus prudente.
  assert.equal(groupes[0].distance, 6);
});

test('doublons : une famille se forme même quand ses extrêmes sont hors seuil', () => {
  // A—B à 4 bits, B—C à 4 bits, mais A—C à 8 : les trois vont ensemble par transitivité,
  // et la distance annoncée dit la vérité sur l'écart maximal.
  const a = SIM;
  const b = flip(SIM, 2, 10, 18, 26);
  const c = flip(b, 3, 11, 19, 27);
  assert.equal(distance(a, c), 8);
  const groupes = grouper([art('s.com', 'a/1.php', 'M1', a), art('s.com', 'a/2.php', 'M2', b), art('s.com', 'a/3.php', 'M3', c)]);
  assert.equal(groupes.length, 1);
  assert.equal(groupes[0].members.length, 3);
  assert.equal(groupes[0].distance, 8);
});

test('doublons : un contenu publié vingt fois ne produit pas un groupe de vingt-et-une lignes', () => {
  // Vingt copies d'un même texte, et un vingt-et-unième article qui leur ressemble. Le
  // groupe d'identiques dit « 20 » ; celui de ressemblance ne montre qu'UN représentant,
  // sans quoi il répéterait vingt fois la même information.
  const copies = Array.from({ length: 20 }, (_, i) => art('a.com', `actu/copie-${i}.php`, 'M1', SIM));
  const voisin = art('a.com', 'actu/voisin.php', 'M2', flip(SIM, 6, 14));
  const groupes = grouper([...copies, voisin]);
  assert.equal(parSorte(groupes, 'exact').length, 1);
  assert.equal(parSorte(groupes, 'exact')[0].members.length, 20);
  const proche = parSorte(groupes, 'near');
  assert.equal(proche.length, 1);
  assert.equal(proche[0].members.length, 2, 'un représentant du contenu répété, plus son voisin');
  assert.ok(
    proche[0].members.some((m) => m.md5 === 'M2'),
    'le voisin doit y être',
  );
});

test('doublons : deux contenus republiés chacun de leur côté, et qui se ressemblent, sont signalés', () => {
  // CE CAS A ETE PERDU PAR UNE VERSION PRECEDENTE. Elle jetait tout groupe de ressemblance
  // dont les membres figuraient déjà parmi les identiques — ici, les deux. L'agent voyait
  // alors deux groupes d'identiques sans jamais apprendre que les deux textes se
  // ressemblent, ce qui est précisément le renseignement utile.
  const groupes = grouper([
    art('a.com', 'actu/1.php', 'M1', SIM),
    art('a.com', 'actu/2.php', 'M1', SIM),
    art('b.com', 'actu/3.php', 'M2', flip(SIM, 7, 15)),
    art('b.com', 'actu/4.php', 'M2', flip(SIM, 7, 15)),
  ]);
  assert.equal(parSorte(groupes, 'exact').length, 2);
  const proche = parSorte(groupes, 'near');
  assert.equal(proche.length, 1, 'la ressemblance entre les deux contenus doit rester visible');
  assert.deepEqual(
    proche[0].members.map((m) => m.md5).sort(),
    ['M1', 'M2'],
  );
});

// ─────────────────────────── le découpage en tranches ───────────────────────────

test('doublons : le découpage en tranches ne rate aucun couple dans le seuil', () => {
  /**
   * LA GARANTIE QUI JUSTIFIE TOUT LE MODULE.
   *
   * Comparer dix mille articles deux à deux ferait cinquante millions de comparaisons dans
   * le navigateur de l'agent. On ne compare donc que les articles qui partagent au moins
   * une tranche de huit bits — et deux empreintes qui diffèrent de six bits au plus en
   * partagent forcément deux. Ici on le VERIFIE : le résultat du découpage est comparé à
   * celui de la force brute, sur deux mille empreintes tirées au sort.
   */
  // Un hachage plutôt qu’un générateur congruentiel : les bits bas de ces derniers
  // sont quasi périodiques, et produisent des empreintes groupées — donc des tranches
  // saturées, qui mesureraient le plafond au lieu de la garantie. Reproductible tout de même.
  let rang = 0;
  const empreinte = () => createHash('md5').update(`empreinte-${rang++}`).digest('hex').slice(0, 16);

  const articles = Array.from({ length: 2000 }, (_, i) => art('s.com', `a/${i}.php`, `M${i}`, empreinte()));
  // Et des couples plantés exprès à chaque distance du seuil, dans des octets différents.
  const rangs = [1, 9, 17, 25, 33, 41];
  for (let d = 1; d <= SEUIL_PROCHE; d++) {
    const base = empreinte();
    articles.push(art('s.com', `plante/${d}-a.php`, `P${d}a`, base));
    articles.push(art('s.com', `plante/${d}-b.php`, `P${d}b`, flip(base, ...rangs.slice(0, d))));
  }

  const attendus = new Set();
  for (let i = 0; i < articles.length; i++) {
    for (let j = i + 1; j < articles.length; j++) {
      if (distance(articles[i].sim, articles[j].sim) <= SEUIL_PROCHE) {
        attendus.add([cleArticle(articles[i]), cleArticle(articles[j])].sort().join('|'));
      }
    }
  }
  assert.ok(attendus.size >= SEUIL_PROCHE, 'la force brute doit au moins retrouver les couples plantés');

  // Chaque couple attendu doit se retrouver DANS UN MEME groupe.
  const groupes = grouper(articles);
  const ensemble = groupes.filter((g) => g.kind === 'near').map((g) => new Set(cles(g)));
  for (const couple of attendus) {
    const [x, y] = couple.split('|');
    assert.ok(
      ensemble.some((s) => s.has(x) && s.has(y)),
      `le couple ${couple} doit être trouvé par le découpage en tranches`,
    );
  }
});

test('doublons : une tranche partagée par trop d’articles est abandonnée, et c’est assumé', () => {
  // Une tranche que trois cents articles partagent ne distingue rien et coûte son carré.
  // Le cas limite : trois cent une empreintes IDENTIQUES à contenus différents. Toutes les
  // tranches sont saturées, aucun couple n'est formé. C'est le prix payé pour que l'écran
  // ne se figent pas, et il est connu — pas découvert en production.
  const articles = Array.from({ length: 301 }, (_, i) => art('s.com', `a/${i}.php`, `M${i}`, SIM));
  aucun(grouper(articles));
  // Trois cents, en revanche, passent : la limite est bien là où elle est annoncée.
  assert.equal(grouper(articles.slice(0, 300)).length, 1);
});

// ─────────────────────────── le mode « site par site » ───────────────────────────

test('doublons : au-delà du seuil, les ressemblances ne sont cherchées que dans chaque site', () => {
  const memeSite = [art('a.com', 'a/1.php', 'M1', SIM), art('a.com', 'a/2.php', 'M2', flip(SIM, 8, 16))];
  const deuxSites = [art('a.com', 'a/1.php', 'M1', SIM), art('b.com', 'a/2.php', 'M2', flip(SIM, 8, 16))];

  const global = grouper(deuxSites);
  assert.equal(global.nearScope, 'all');
  assert.equal(global.length, 1, 'tant qu’on compare tout, la ressemblance entre sites est trouvée');

  // Le même jeu, mais le mode par site enclenché.
  const restreint = grouper(deuxSites, { maxGlobal: 1 });
  assert.equal(restreint.nearScope, 'site');
  aucun(restreint, 'deux sites différents ne sont plus comparés — et l’écran le dit');

  const interne = grouper(memeSite, { maxGlobal: 1 });
  assert.equal(interne.nearScope, 'site');
  assert.equal(interne.length, 1, 'à l’intérieur d’un site, la ressemblance est toujours trouvée');
});

test('doublons : les contenus identiques restent trouvés PARTOUT, même en mode par site', () => {
  // C'est ce qui rend le compromis acceptable : la détection exacte ne coûte qu'une table,
  // elle n'est donc jamais restreinte. Sur ce parc, tous les doublons réels sont exacts.
  const groupes = grouper([art('a.com', 'a/1.php', 'M1', SIM), art('b.com', 'b/2.php', 'M1', SIM)], { maxGlobal: 1 });
  assert.equal(groupes.length, 1);
  assert.equal(groupes[0].kind, 'exact');
  assert.equal(new Set(groupes[0].members.map((m) => m.domain)).size, 2);
});

test('doublons : le seuil de bascule reste celui qui a été mesuré', () => {
  // 17 539 articles réels : 8 576 ms en comparant tout, 142 ms site par site, mêmes
  // résultats. Quatre mille est le point où la page reste vive.
  assert.equal(MAX_RAPPROCHEMENT_GLOBAL, 4000);
  assert.equal(SEUIL_PROCHE, 6);
  const petit = grouper(Array.from({ length: 10 }, (_, i) => art('a.com', `a/${i}.php`, `M${i}`, flip(SIM, i, 32 + i))));
  assert.equal(petit.nearScope, 'all');
});

// ─────────────────────────── ce que l’écran affiche en haut ───────────────────────────

test('doublons : le résumé compte les groupes, les articles touchés et les sites', () => {
  const articles = [
    art('a.com', 'a/1.php', 'M1', SIM),
    art('a.com', 'a/2.php', 'M1', SIM),
    art('b.com', 'b/3.php', 'M1', SIM),
    art('b.com', 'b/4.php', 'M2', flip(SIM, 9, 17, 25)),
    art('c.com', 'c/5.php', 'M3', '0f1e2d3c4b5a6978'),
  ];
  const groupes = grouper(articles);
  const r = resume(groupes, articles);
  assert.equal(r.articles, 5);
  assert.equal(r.exact, 1);
  assert.equal(r.near, 1);
  assert.equal(r.groups, 2);
  // Un groupe à cheval sur plusieurs sites ne se traite pas comme un groupe interne : le
  // second est une erreur de publication, le premier une question de stratégie.
  assert.equal(r.crossSite, 2);
  assert.equal(r.affected, 4, 'les quatre articles des deux groupes, comptés une seule fois');
  assert.deepEqual([...new Set(['a.com', 'b.com'])].length, r.sites);
});

test('doublons : un résumé sans rien à dire ne dit rien', () => {
  const r = resume([], []);
  assert.deepEqual(r, { articles: 0, groups: 0, exact: 0, near: 0, crossSite: 0, affected: 0, sites: 0 });
  assert.equal(resume([], undefined).articles, 0);
});

test('doublons : la clé d’un article distingue deux serveurs, deux sites, deux chemins', () => {
  assert.notEqual(cleArticle({ server: 'vps-001', domain: 'a.com', path: 'x.php' }), cleArticle({ server: 'vps-002', domain: 'a.com', path: 'x.php' }));
  assert.notEqual(cleArticle({ domain: 'a.com', path: 'x.php' }), cleArticle({ domain: 'b.com', path: 'x.php' }));
  assert.equal(cleArticle({ domain: 'a.com', path: 'x.php' }), cleArticle({ server: undefined, domain: 'a.com', path: 'x.php' }));
});

// ─────────────────────────── l’empreinte, sur du vrai PHP ───────────────────────────

/**
 * Un texte de `n` mots, reproductible, et dont deux graines donnent des textes SANS
 * RAPPORT l'un avec l'autre.
 *
 * La première version prenait `mot${(i * 7 + decalage) % 211}` : deux graines y donnaient
 * le MEME vocabulaire décalé, donc presque les mêmes groupes de trois mots, donc des
 * empreintes à dix bits d'écart seulement. L'essai accusait l'empreinte alors que le
 * fautif était l'éprouvette. Un hachage par mot l'évite.
 */
function texte(n, graine = 0) {
  return Array.from({ length: n }, (_, i) => `m${createHash('md5').update(`${graine}-${i}`).digest('hex').slice(0, 7)}`).join(' ');
}

/**
 * Un article de la forme RELEVEE SUR LE PARC, et non imaginée.
 *
 *     <?php
 *     $article_meta = ['title' => '…', …];
 *     require_once __DIR__ . '/../parts/picture.php';
 *     $content .= <<<'HTML'
 *     <p>le corps…</p>
 *     HTML;
 */
function article({ titre = 'Un titre', corps = '', avant = '' } = {}) {
  return [
    '<?php',
    `$article_meta = ['title' => '${titre.replace(/'/g, "\\'")}', 'date' => '2026-01-01'];`,
    "require_once __DIR__ . '/../parts/picture.php';",
    avant,
    "$content .= <<<'HTML'",
    corps,
    'HTML;',
    '',
  ].join('\n');
}

/** Un petit parc sur disque, et l'empreinte relevée dessus par du vrai PHP. */
function parc(fichiers, { domain = 'essai.test' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lkm-dup-'));
  const doc = join(root, domain, 'public_html');
  for (const [chemin, contenu] of Object.entries(fichiers)) {
    const complet = join(doc, chemin);
    mkdirSync(dirname(complet), { recursive: true });
    writeFileSync(complet, contenu, 'utf8');
  }
  const lire = (domaines = [domain]) => {
    const res = spawnSync('php', [], {
      input: ARTICLE_FINGERPRINTS,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        LKM_ROOT: root,
        LKM_B64: Buffer.from(JSON.stringify(domaines), 'utf8').toString('base64'),
        LKM_SKIP: Buffer.from(JSON.stringify(DOSSIERS_EXCLUS), 'utf8').toString('base64'),
        LKM_MIN_WORDS: String(MOTS_MINIMUM),
      },
    });
    assert.equal(res.status, 0, `php a échoué : ${res.stderr}`);
    const site = JSON.parse(res.stdout).sites[0];
    return { ...site, parChemin: new Map((site.articles ?? []).map((a) => [a.path, a])) };
  };
  return { root, doc, lire, nettoyer: () => rmSync(root, { recursive: true, force: true }) };
}

test('empreinte : un article du parc est reconnu, compté et daté', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  const p = parc({ 'actu/premier.php': article({ titre: 'Premier', corps: `<p>${texte(120)}</p>` }) });
  try {
    const site = p.lire();
    assert.equal(site.error, undefined);
    assert.equal(site.total, 1);
    assert.equal(site.articles.length, 1);
    const a = site.articles[0];
    assert.equal(a.path, 'actu/premier.php');
    assert.equal(a.title, 'Premier', 'le titre est relevé pour que l’agent sache de quoi on parle');
    assert.equal(a.words, 120);
    assert.equal(a.md5.length, 32);
    assert.equal(a.sim.length, 16, 'l’empreinte de proximité voyage en hexadécimal');
    assert.ok(a.mtime > 1700000000, 'la date de modification doit être relevée');
    assert.ok(a.bytes > 0);
  } finally {
    p.nettoyer();
  }
});

test('empreinte : LES ARTICLES NE SONT JAMAIS EXECUTES', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  // Exécuter un article du parc reviendrait à lancer, sur une machine de production, du
  // code qu'on n'a pas écrit. Cet article écrirait un fichier témoin s'il était inclus.
  const p = parc({ 'actu/piege.php': 'placeholder' });
  const temoin = join(p.root, 'temoin.txt');
  writeFileSync(
    join(p.doc, 'actu/piege.php'),
    article({
      titre: 'Piège',
      avant: `@file_put_contents('${temoin.replace(/\\/g, '/')}', 'execute'); exit(9);`,
      corps: `<p>${texte(80)}</p>`,
    }),
    'utf8',
  );
  try {
    const site = p.lire();
    assert.equal(existsSync(temoin), false, 'le fichier témoin ne doit PAS exister');
    assert.equal(site.articles.length, 1, 'et l’article doit tout de même avoir été relevé');
  } finally {
    p.nettoyer();
  }
});

test('empreinte : deux articles au même contenu ont la même empreinte, mise en forme comprise', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  const mots = texte(600);
  const p = parc({
    // Même texte, balises et blancs différents, titres différents : c'est le CONTENU qui
    // fait le doublon, pas l'habillage ni le titre.
    'actu/un.php': article({ titre: 'Un', corps: `<p>${mots}</p>` }),
    'actu/deux.php': article({ titre: 'Deux', corps: `<div class="x">\n  <p>  ${mots.toUpperCase()}  </p>\n</div>` }),
    'actu/trois.php': article({ titre: 'Trois', corps: `<p>${mots} et un mot de plus</p>` }),
  });
  try {
    const site = p.lire();
    const un = site.parChemin.get('actu/un.php');
    const deux = site.parChemin.get('actu/deux.php');
    const trois = site.parChemin.get('actu/trois.php');
    assert.equal(un.md5, deux.md5, 'la casse, les balises et les blancs ne font pas un contenu différent');
    assert.equal(un.sim, deux.sim);
    assert.notEqual(un.md5, trois.md5);
    // Cinq mots ajoutés à six cents : l'écart doit être petit, pas nul.
    const d = distance(un.sim, trois.sim);
    assert.ok(d > 0 && d <= SEUIL_PROCHE, `un ajout court doit rester dans le seuil (vu : ${d})`);
  } finally {
    p.nettoyer();
  }
});

test('empreinte : le seuil se juge en PROPORTION du texte, et c’est mesuré', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  /**
   * CE QUE LE SEUIL DE SIX BITS ATTRAPE VRAIMENT, mesuré le 05/10/2026 sur du vrai PHP :
   *
   *     mots   1 mot changé   +5 mots   +30 mots   moitié réécrite   texte étranger
   *      100         1            8        12            21                33
   *      300         1            4         8            18                30
   *      600         2            3         5            13                36
   *     1200         0            0         2            17                28
   *
   * DEUX LECONS, et l'écran ne promet rien de plus :
   *
   *   1. un article dont la MOITIE a été réécrite n'est jamais signalé, quelle que soit sa
   *      longueur. C'est un autre article, et c'en est un même pour un lecteur ;
   *   2. la sensibilité suit la PROPORTION du texte modifié, pas le nombre de mots. Cinq
   *      mots ajoutés à cent donnent 8 — hors seuil ; les mêmes cinq mots ajoutés à six
   *      cents donnent 3. Les articles courts sont donc comparés plus sévèrement, et c'est
   *      le bon sens : sur cent mots, cinq de différence, c'est cinq pour cent du texte.
   */
  const base = texte(400);
  const p = parc({
    'actu/base.php': article({ corps: `<p>${base}</p>` }),
    'actu/retouche.php': article({ corps: `<p>${base} et un mot de plus</p>` }),
    'actu/moitie.php': article({ corps: `<p>${base.split(' ').slice(0, 200).join(' ')} ${texte(200, 777)}</p>` }),
    'actu/etranger.php': article({ corps: `<p>${texte(400, 42)}</p>` }),
  });
  try {
    const s = p.lire();
    const d = (nom) => distance(s.parChemin.get('actu/base.php').sim, s.parChemin.get(`actu/${nom}.php`).sim);
    assert.ok(d('retouche') <= SEUIL_PROCHE, `une retouche doit être signalée (vu : ${d('retouche')})`);
    assert.ok(d('moitie') > SEUIL_PROCHE, `un article à moitié réécrit n’est PAS un doublon (vu : ${d('moitie')})`);
    assert.ok(d('etranger') > 20, `et un texte étranger reste très loin (vu : ${d('etranger')})`);
    const groupes = grouper(s.articles.map((a) => ({ ...a, domain: 'essai.test' })));
    assert.equal(groupes.length, 1, 'un seul groupe : la base et sa retouche');
    assert.deepEqual(
      groupes[0].members.map((m) => m.path).sort(),
      ['actu/base.php', 'actu/retouche.php'],
    );
  } finally {
    p.nettoyer();
  }
});

test('empreinte : deux textes sans rapport sont loin l’un de l’autre', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  const p = parc({
    'actu/a.php': article({ corps: `<p>${texte(300)}</p>` }),
    'actu/b.php': article({ corps: `<p>${texte(300, 97) /* une autre graine : un vocabulaire sans rapport */}</p>` }),
  });
  try {
    const site = p.lire();
    const d = distance(site.parChemin.get('actu/a.php').sim, site.parChemin.get('actu/b.php').sim);
    // Mesuré sur le parc : deux textes étrangers donnent une trentaine de bits d'écart.
    // La séparation avec le seuil de 6 doit rester franche.
    assert.ok(d > 20, `deux textes sans rapport doivent être loin (vu : ${d})`);
    aucun(grouper(site.articles.map((a) => ({ ...a, domain: 'essai.test' }))));
  } finally {
    p.nettoyer();
  }
});

test('empreinte : ce qui n’est pas comparable est compté à part, sous son vrai nom', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  const p = parc({
    'actu/bon.php': article({ corps: `<p>${texte(80)}</p>` }),
    // Pas de marque de corps : ce n'est pas un article, et on ne le devine pas.
    'actu/sans-corps.php': "<?php\n$article_meta = ['title' => 'Rien'];\n",
    // Trop court pour dire quoi que ce soit de sa ressemblance.
    'actu/court.php': article({ corps: '<p>trois petits mots</p>' }),
    // Un corps vide : le cas qui avait produit de faux doublons au premier essai.
    'actu/vide.php': article({ corps: '' }),
  });
  try {
    const site = p.lire();
    assert.equal(site.total, 4, 'les quatre fichiers ont bien été vus');
    assert.equal(site.articles.length, 1, 'un seul est comparable');
    assert.equal(site.noBody, 1);
    assert.equal(site.tooShort, 2, 'le trop court ET le vide');
    assert.equal(site.unreadable, 0);
  } finally {
    p.nettoyer();
  }
});

test('empreinte : les dossiers de gabarit et les index de rubrique sont ignorés', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  const corps = `<p>${texte(100)}</p>`;
  const p = parc({
    'actu/vrai.php': article({ corps }),
    'actu/index.php': article({ corps }),
    'parts/picture.php': article({ corps }),
    'images/galerie.php': article({ corps }),
    'wp-content/vieux.php': article({ corps }),
    '.lkm-backups/sauvegarde.php': article({ corps }),
  });
  try {
    const site = p.lire();
    // Sans cela, chaque site aurait produit un faux groupe « identiques » entre son
    // article et la copie de sauvegarde ou le gabarit partagé.
    assert.deepEqual(
      site.articles.map((a) => a.path),
      ['actu/vrai.php'],
    );
    assert.equal(site.total, 1, 'les fichiers écartés par leur dossier ne sont même pas comptés');
  } finally {
    p.nettoyer();
  }
});

test('empreinte : un site absent le dit, et n’interrompt pas le lot', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  const p = parc({ 'actu/bon.php': article({ corps: `<p>${texte(80)}</p>` }) });
  try {
    const res = spawnSync('php', [], {
      input: ARTICLE_FINGERPRINTS,
      encoding: 'utf8',
      env: {
        ...process.env,
        LKM_ROOT: p.root,
        LKM_B64: Buffer.from(JSON.stringify(['absent.test', 'essai.test', 'pas;un;domaine']), 'utf8').toString('base64'),
        LKM_SKIP: Buffer.from(JSON.stringify(DOSSIERS_EXCLUS), 'utf8').toString('base64'),
        LKM_MIN_WORDS: String(MOTS_MINIMUM),
      },
    });
    assert.equal(res.status, 0);
    const sites = JSON.parse(res.stdout).sites;
    assert.equal(sites.length, 2, 'le domaine mal formé est écarté sans bruit');
    assert.equal(sites[0].domain, 'absent.test');
    assert.equal(sites[0].error, 'missing');
    assert.equal(sites[1].articles.length, 1, 'le site suivant est tout de même lu');
  } finally {
    p.nettoyer();
  }
});

test('empreinte : un doublon réel du parc se retrouve de bout en bout', async (t) => {
  if (phpAbsent) return t.skip('PHP absent');
  // Le motif observé sur le parc : le même article republié sous « -2 ».
  const corps = `<p>${texte(150)}</p>`;
  const p = parc({
    'sante/bien-dormir.php': article({ titre: 'Bien dormir', corps }),
    'sante/bien-dormir-2.php': article({ titre: 'Bien dormir', corps }),
    'sante/autre.php': article({ titre: 'Autre', corps: `<p>${texte(150, 53)}</p>` }),
  });
  try {
    const site = p.lire();
    const groupes = grouper(site.articles.map((a) => ({ ...a, domain: 'essai.test', server: 'vps-004' })));
    assert.equal(groupes.length, 1);
    assert.equal(groupes[0].kind, 'exact');
    assert.deepEqual(cles(groupes[0]), ['vps-004/essai.test/sante/bien-dormir-2.php', 'vps-004/essai.test/sante/bien-dormir.php']);
    const r = resume(groupes, site.articles);
    assert.equal(r.affected, 2);
    assert.equal(r.crossSite, 0, 'les deux copies vivent dans le même site');
  } finally {
    p.nettoyer();
  }
});

// ─────────────────────────── le service ───────────────────────────

/** Un faux parc : aucune connexion, et un journal de ce qui a été demandé. */
function fauxService({ charge = '1.0\n8\n0', reponse = { sites: [] } } = {}) {
  const vues = [];
  const ssh = {
    server: () => ({ id: 'vps-004', label: 'VPS 004', wwwRoot: '/srv/www' }),
    exec: async (id, cmd) => {
      vues.push({ type: 'exec', cmd });
      return { stdout: charge };
    },
  };
  const sites = {
    runPhp: async (serverId, root, script, env) => {
      vues.push({ type: 'php', serverId, root, env });
      return typeof reponse === 'function' ? reponse(env) : reponse;
    },
  };
  return { vues, service: new DuplicateService(ssh, sites, new ServerLoad(ssh)) };
}

test('service : sans site à analyser, on refuse clairement', async () => {
  const { service } = fauxService();
  for (const liste of [[], null, undefined, ['', '   ']]) {
    await assert.rejects(() => service.scan('vps-004', liste), (e) => e.key === 'errors.dup_no_target');
  }
});

test('service : un domaine mal formé n’atteint jamais le serveur', async () => {
  // La règle du projet : sanitizer scrupuleusement tout ce qui part vers une machine.
  const { service, vues } = fauxService();
  await assert.rejects(
    () => service.scan('vps-004', ['a.com; rm -rf /', '../../etc', 'pas un domaine', '$(whoami).com']),
    (e) => e.key === 'errors.dup_no_target',
  );
  assert.equal(vues.filter((v) => v.type === 'php').length, 0, 'aucune lecture n’a été lancée');
});

test('service : un lot trop gros est refusé avant la première lecture', async () => {
  const { service, vues } = fauxService();
  const trop = Array.from({ length: 151 }, (_, i) => `site-${i}.com`);
  await assert.rejects(() => service.scan('vps-004', trop), (e) => e.key === 'errors.translate_batch_too_big');
  assert.equal(vues.length, 0);
});

test('service : la machine est auscultée AVANT qu’on lui demande quarante mégaoctets', async () => {
  const { service, vues } = fauxService({ reponse: { sites: [{ domain: 'a.com', total: 0, articles: [] }] } });
  const out = await service.scan('vps-004', ['a.com']);
  assert.equal(vues[0].type, 'exec', 'la charge se lit d’abord');
  assert.ok(vues[0].cmd.includes('/proc/pressure/io'), 'et la pression disque avec elle');
  assert.equal(vues[1].type, 'php');
  assert.deepEqual(out.load, { load: 1, cores: 8, parCoeur: 0.125, io: 0 });
});

test('service : une machine qui attend son disque fait renoncer l’analyse', async () => {
  // Mesuré le 05/10/2026 : vps-003 à 99,6 % de pression disque, 234 processus bloqués.
  // Lire quarante mégaoctets dessus n'aurait fait qu'ajouter à la peine.
  const { service } = fauxService({ charge: '0.5\n8\n99.6' });
  await assert.rejects(
    () => service.scan('vps-004', ['a.com'], { maxWait: 0 }),
    (e) => e.key === 'errors.health_server_io' && e.vars.io === '100',
  );
});

test('service : les doublons de la demande sont réduits, et la casse ne compte pas', async () => {
  const { service, vues } = fauxService({ reponse: { sites: [] } });
  await service.scan('vps-004', ['A.com', 'a.com', ' a.COM ', 'b.com']);
  const env = vues.find((v) => v.type === 'php').env;
  assert.deepEqual(JSON.parse(Buffer.from(env.LKM_B64, 'base64').toString('utf8')), ['a.com', 'b.com']);
  assert.deepEqual(JSON.parse(Buffer.from(env.LKM_SKIP, 'base64').toString('utf8')), DOSSIERS_EXCLUS);
  assert.equal(env.LKM_MIN_WORDS, String(MOTS_MINIMUM));
  assert.equal(env.LKM_ROOT, '/srv/www');
});

test('service : un site qui n’a pas répondu est dit tel quel, pas oublié', async () => {
  // Un site muet et un site vide ne se valent pas : l'agent doit savoir lequel est lequel.
  const { service } = fauxService({
    reponse: {
      sites: [
        { domain: 'vu.com', total: 3, bytes: 1000, noBody: 1, tooShort: 1, unreadable: 0, articles: [{ path: 'a/1.php', md5: 'M1', sim: SIM, words: 90 }] },
        { domain: 'casse.com', error: 'missing' },
      ],
    },
  });
  const out = await service.scan('vps-004', ['vu.com', 'casse.com', 'muet.com']);
  assert.deepEqual(
    out.sites.map((s) => [s.domain, s.error]),
    [
      ['vu.com', null],
      ['casse.com', 'missing'],
      ['muet.com', 'no_answer'],
    ],
  );
  const vu = out.sites[0];
  assert.equal(vu.noBody, 1);
  assert.equal(vu.tooShort, 1);
  assert.equal(vu.articles[0].domain, 'vu.com', 'chaque article porte son site : l’écran en a besoin pour grouper');
});

test('service : le minimum de mots est réglable, mais jamais nul', async () => {
  const { service, vues } = fauxService();
  await service.scan('vps-004', ['a.com'], { minWords: 120 });
  assert.equal(vues.at(-1).env.LKM_MIN_WORDS, '120');
  await service.scan('vps-004', ['a.com'], { minWords: 0 });
  assert.equal(vues.at(-1).env.LKM_MIN_WORDS, String(MOTS_MINIMUM), 'zéro mot rouvrirait la porte aux faux doublons');
});

// ─────────────────────────── les promesses de l’écran ───────────────────────────

test('doublons : l’algorithme n’existe qu’en un seul endroit', () => {
  // Deux copies d'un algorithme finissent toujours par diverger, et celle qui se tait est
  // celle qui se trompe. Le service Node l'IMPORTE de `public/js/`, parce que c'est le
  // navigateur qui l'exécute.
  const SERVICE = readFileSync(join(RACINE, 'src/services/duplicateService.js'), 'utf8');
  assert.ok(SERVICE.includes("from '../../public/js/duplicateGrouping.js'"), 'le service réexporte le rapprochement partagé');
  assert.ok(!/function grouper/.test(SERVICE), 'et n’en garde aucune copie');
  assert.ok(ECRAN.includes("from './duplicateGrouping.js'"), 'l’écran l’importe aussi');
  assert.ok(!/function distance/.test(ECRAN), 'et ne recopie pas la distance');
});

test('doublons : l’écran ne pose aucune question à l’agent', () => {
  // Les agents ne sont pas techniques : un seuil de distance de Hamming ne se demande pas.
  // Les réglages sont mesurés et vivent dans le code, avec les mesures qui les justifient.
  assert.ok(!/\bform\s*\(/.test(ECRAN), 'pas de formulaire de réglages');
  assert.ok(ECRAN.includes("startLabelKey: 'duplicates.scan'"), 'un seul bouton : chercher');
});

test('doublons : l’écran dit quand la recherche a été restreinte', () => {
  // Taire le mode « site par site » laisserait croire à une recherche complète.
  assert.ok(ECRAN.includes("duplicates.near_per_site"), 'le message existe dans l’écran');
  assert.ok(ECRAN.includes("state.portee === 'site'"), 'et il n’est affiché que dans ce cas');
  assert.ok(ECRAN.includes("state.groupes.nearScope"), 'la portée vient du rapprochement, pas d’une devinette');
  assert.ok(ECRAN.includes('duplicates.skipped'), 'ce qui n’a pas été comparé est dit aussi');
});

test('doublons : rien n’écrit sur le parc', () => {
  // Lecture seule, et cela doit rester vérifiable d'un coup d'œil.
  for (const [nom, source] of [
    ['le relevé', readFileSync(join(RACINE, 'src/services/duplicateScripts.js'), 'utf8')],
    ['le service', readFileSync(join(RACINE, 'src/services/duplicateService.js'), 'utf8')],
  ]) {
    for (const interdit of ['file_put_contents', 'fwrite', 'unlink', 'rename', 'mkdir', 'writeFile', 'include ', 'require ']) {
      assert.ok(!source.includes(interdit), `${nom} ne doit pas contenir « ${interdit} »`);
    }
  }
  assert.ok(GROUPEMENT.includes('export function grouper'), 'et le rapprochement est pur JavaScript');
});
