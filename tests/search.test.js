import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SearchService, parseQuery, pathVariants } from '../src/services/searchService.js';

test('recherche : ce que l’agent colle est ramené à un domaine et un chemin', () => {
  // Le cas courant : l'adresse entière, copiée depuis la barre du navigateur.
  assert.deepEqual(parseQuery('https://biozenz.fr/transformez-votre-bien-etre-grace-a-la-magie-de-la-pleine-conscience'), {
    domain: 'biozenz.fr',
    path: '/transformez-votre-bien-etre-grace-a-la-magie-de-la-pleine-conscience',
  });

  // Un nom seul reste un nom seul.
  assert.deepEqual(parseQuery('biozenz.fr'), { domain: 'biozenz.fr', path: '' });
  assert.deepEqual(parseQuery('  BIOZENZ.FR  '), { domain: 'biozenz.fr', path: '' });

  // Tout ce que le navigateur ajoute et qui ne fait pas partie du nom.
  assert.equal(parseQuery('http://www.biozenz.fr/').domain, 'biozenz.fr');
  assert.equal(parseQuery('www.biozenz.fr').domain, 'biozenz.fr');
  assert.equal(parseQuery('biozenz.fr:8080/page').domain, 'biozenz.fr');
  assert.equal(parseQuery('https://user:mdp@biozenz.fr/page').domain, 'biozenz.fr');

  // Paramètres, ancre et barre finale ne désignent pas un autre article.
  assert.equal(parseQuery('https://biozenz.fr/page.php?utm=1#haut').path, '/page.php');
  assert.equal(parseQuery('https://biozenz.fr/bien-etre/page/').path, '/bien-etre/page');

  // Rien à chercher.
  assert.deepEqual(parseQuery(''), { domain: '', path: '' });
  assert.deepEqual(parseQuery(null), { domain: '', path: '' });
});

test('recherche : un article se désigne de plusieurs façons', () => {
  // Avec ou sans « .php », avec ou sans « / » de tête : c'est le même article.
  const v = pathVariants('/bien-etre/mon-article.php');
  for (const attendu of ['bien-etre/mon-article.php', '/bien-etre/mon-article', 'bien-etre/mon-article', 'mon-article.php', 'mon-article']) {
    assert.ok(v.includes(attendu), attendu);
  }
  assert.deepEqual(pathVariants(''), []);
});

// ── Le service, sur un parc de démonstration ───────────────────────────────

const SERVEURS = [
  { id: 'vps-001', label: 'VPS 001' },
  { id: 'vps-002', label: 'VPS 002' },
];

const PARC = {
  'vps-001': [{ name: 'biozenz.fr', status: 'unlocked' }, { name: 'biozenz.fr.old', status: 'locked' }],
  'vps-002': [{ name: 'autre.com', status: 'unlocked' }],
};

const ARTICLES = {
  'biozenz.fr': [
    { file: 'bien-etre/transformez-votre-bien-etre.php', url: '/transformez-votre-bien-etre', category: 'bien-etre' },
    { file: 'actu/sans-permalien.php', url: '', category: 'actu' },
  ],
};

function service({ connectes = ['vps-001', 'vps-002'], articles = ARTICLES, erreurArticles = null } = {}) {
  const ssh = { isConnected: (id) => connectes.includes(id) };
  const domains = { list: async (id) => ({ items: PARC[id] ?? [] }) };
  const sites = {
    listArticles: async (_id, domain) => {
      if (erreurArticles) throw Object.assign(new Error('boum'), { key: erreurArticles });
      return articles[domain] ?? [];
    },
  };
  return new SearchService(ssh, domains, sites);
}

test('recherche : un domaine exact l’emporte sur ce qui lui ressemble', async () => {
  const r = await service().find('biozenz.fr', SERVEURS);
  assert.equal(r.kind, 'domain');
  assert.equal(r.site.domain, 'biozenz.fr');
  assert.equal(r.site.serverLabel, 'VPS 001');
  assert.equal(r.site.status, 'unlocked');
  // « biozenz.fr.old » contient la recherche, mais ne doit pas la supplanter.
  assert.ok(!r.candidates.some((c) => c.domain === 'biozenz.fr'));
  assert.deepEqual(r.candidates.map((c) => c.domain), ['biozenz.fr.old']);
});

test('recherche : une adresse d’article mène au fichier et au serveur', async () => {
  // Par l'adresse publique, celle que donne permalinks.php.
  const r = await service().find('https://biozenz.fr/transformez-votre-bien-etre', SERVEURS);
  assert.equal(r.kind, 'article');
  assert.equal(r.site.server, 'vps-001');
  assert.equal(r.article.file, 'bien-etre/transformez-votre-bien-etre.php');
  assert.equal(r.articleCount, 2);

  // Par le chemin du fichier, car une partie du parc n'a pas de permalinks.
  const parFichier = await service().find('biozenz.fr/actu/sans-permalien.php', SERVEURS);
  assert.equal(parFichier.kind, 'article');
  assert.equal(parFichier.article.file, 'actu/sans-permalien.php');

  // Le « .php » et la barre finale ne changent pas l'article désigné.
  for (const q of ['https://biozenz.fr/transformez-votre-bien-etre/', 'biozenz.fr/transformez-votre-bien-etre.php']) {
    assert.equal((await service().find(q, SERVEURS)).article?.file, 'bien-etre/transformez-votre-bien-etre.php', q);
  }
});

test('recherche : le domaine trouvé est dit même quand l’article ne l’est pas', async () => {
  const r = await service().find('https://biozenz.fr/page-qui-nexiste-pas', SERVEURS);
  assert.equal(r.kind, 'article_missing');
  assert.equal(r.site.domain, 'biozenz.fr');
  assert.equal(r.article, null);

  // Et même quand la lecture du site échoue : la moitié de la réponse vaut mieux
  // que rien du tout.
  const casse = await service({ erreurArticles: 'errors.design_read_failed' }).find('https://biozenz.fr/x', SERVEURS);
  assert.equal(casse.kind, 'domain');
  assert.equal(casse.site.domain, 'biozenz.fr');
  assert.equal(casse.articleError, 'errors.design_read_failed');
});

test('recherche : ce qui n’est pas trouvé se dit, avec sa raison', async () => {
  // Un nom proche : on propose, on n'invente pas.
  const proche = await service().find('biozenz', SERVEURS);
  assert.equal(proche.kind, 'near');
  assert.deepEqual(proche.candidates.map((c) => c.domain).sort(), ['biozenz.fr', 'biozenz.fr.old']);

  // Rien du tout.
  assert.equal((await service().find('introuvable-nulle-part.fr', SERVEURS)).kind, 'unknown');

  // Une saisie qui n'est pas un domaine.
  for (const q of ['', '   ', '???', 'un mot']) assert.equal((await service().find(q, SERVEURS)).kind, 'invalid', q);
});

test('recherche : un serveur non connecté est nommé, première raison d’un échec', async () => {
  const r = await service({ connectes: ['vps-002'] }).find('biozenz.fr', SERVEURS);
  // biozenz.fr vit sur vps-001, qui n'est pas connecté : on ne le trouve pas…
  assert.equal(r.kind, 'unknown');
  // …et l'écran peut dire pourquoi plutôt que de laisser croire qu'il n'existe pas.
  assert.deepEqual(r.offline, [{ id: 'vps-001', label: 'VPS 001' }]);
});
