import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dictionaryLookup, machineTranslate, normalizeLang } from '../src/services/langTools.js';
import { readPath, writePath } from '../src/services/siteService.js';
import { TranslationService } from '../src/services/translationService.js';
import { SCAN_LANG } from '../src/services/phpScripts.js';

const key = (fn) => fn().then(() => null).catch((err) => err.key ?? err.message);

test('langues : les codes du parc et leurs équivalents', () => {
  assert.equal(normalizeLang('en'), 'UK');
  assert.equal(normalizeLang('BR'), 'PT');
  assert.equal(normalizeLang(' uk '), 'UK');
  assert.equal(normalizeLang('FR'), 'FR');
  assert.equal(normalizeLang('ZZ'), null);
  assert.equal(normalizeLang(''), null);
});

test('dictionnaire : expressions courantes du parc', () => {
  assert.equal(dictionaryLookup('Nos articles', 'UK'), 'Our articles');
  assert.equal(dictionaryLookup('Our articles', 'ES'), 'Nuestros artículos');
  // Casse, accents et ponctuation finale ne doivent pas séparer deux variantes.
  assert.equal(dictionaryLookup('questions frequentes', 'UK'), 'Frequently asked questions');
  assert.equal(dictionaryLookup('En savoir plus !', 'DE'), 'Mehr erfahren');
  assert.equal(dictionaryLookup('NOS ARTICLES', 'UK'), 'OUR ARTICLES');
  // Déjà dans la bonne langue, ou inconnue : aucune proposition.
  assert.equal(dictionaryLookup('Our articles', 'UK'), null);
  assert.equal(dictionaryLookup('Un texte éditorial qui ne figure nulle part', 'UK'), null);
  assert.equal(dictionaryLookup('Nos articles', 'ZZ'), null);
});

test('traduction automatique : requête formée, et silence sans clé', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, body: new URLSearchParams(init.body) };
    return { ok: true, json: async () => ({ translations: [{ text: 'Our coffee guide' }] }) };
  };
  const out = await machineTranslate(['Notre guide du café'], { from: 'FR', to: 'UK', key: 'abc:fx', fetchImpl });
  assert.deepEqual(out, ['Our coffee guide']);
  assert.match(seen.url, /api-free\.deepl\.com/);
  assert.equal(seen.body.get('target_lang'), 'EN-GB'); // la cible accepte la variante régionale…
  assert.equal(seen.body.get('source_lang'), 'FR');
  assert.equal(seen.body.get('tag_handling'), 'html');

  // …mais la source non : PT-PT serait refusé.
  await machineTranslate(['Olá'], { from: 'PT', to: 'FR', key: 'abc:fx', fetchImpl });
  assert.equal(seen.body.get('source_lang'), 'PT');

  assert.equal(await machineTranslate(['x'], { from: 'FR', to: 'UK', key: '', fetchImpl }), null);
});

test('chemins de configuration : seule la prose est accessible', () => {
  const config = {
    site_name: 'Caswells',
    site_tagline: 'Découvrez nos conseils',
    homepage: {
      hero: { title: 'The best coffee', image: 'hero-1', count: 4 },
      faq: { items: [{ q: 'Comment ?', a: 'Ainsi.' }] },
    },
    categories: [{ slug: 'business', label: 'Affaires' }],
  };

  assert.equal(readPath(config, 'site_tagline'), 'Découvrez nos conseils');
  assert.equal(readPath(config, 'homepage.hero.title'), 'The best coffee');
  assert.equal(readPath(config, 'homepage.faq.items.0.q'), 'Comment ?');
  // Hors des racines autorisées : invisible, même si la clé existe.
  assert.equal(readPath(config, 'site_name'), undefined);
  assert.equal(readPath(config, 'categories.0.label'), undefined);
  // Chemin inexistant, index hors bornes, prototype : rien.
  assert.equal(readPath(config, 'homepage.hero.absent'), undefined);
  assert.equal(readPath(config, 'homepage.faq.items.7.q'), undefined);
  assert.equal(readPath(config, 'homepage.__proto__.polluted'), undefined);

  assert.equal(writePath(config, 'homepage.hero.title', 'Le meilleur café'), true);
  assert.equal(config.homepage.hero.title, 'Le meilleur café');
  assert.equal(writePath(config, 'homepage.faq.items.0.q', 'Comment faire ?'), true);
  assert.equal(config.homepage.faq.items[0].q, 'Comment faire ?');
  // Ni création de clé, ni remplacement d'autre chose qu'un texte.
  assert.equal(writePath(config, 'homepage.hero.nouvelle', 'x'), false);
  assert.equal(writePath(config, 'homepage.hero.count', 'x'), false);
  assert.equal(writePath(config, 'site_name', 'x'), false);
  assert.equal(writePath(config, 'homepage.__proto__.polluted', 'x'), false);
  assert.equal({}.polluted, undefined);
  assert.equal(config.site_name, 'Caswells');
});

/** Faux SiteService : rend le JSON qu'aurait produit le script PHP sur le serveur. */
const fakeSites = (payload) => ({
  runPhp: async () => payload,
  applyTextChanges: async (serverId, domain, changes) => ({ domain, stamp: '20260923-101500', applied: changes, skipped: [] }),
});
const fakeSsh = { server: () => ({ id: 'vps-003', label: 'VPS 003', wwwRoot: '/var/www' }) };

test('analyse : propositions ajoutées, libellés courts rattrapés par le dictionnaire', async () => {
  const service = new TranslationService(
    fakeSsh,
    fakeSites({
      sites: [
        {
          domain: 'caswellscoffee.com',
          lang: 'UK',
          source: 'config',
          hint: 'UK',
          texts: 12,
          items: [{ path: 'site_tagline', lang: 'FR', score: 4, text: 'Découvrez nos conseils pour bien choisir votre café' }],
          labels: [
            { path: 'homepage.hero.badge', text: 'Nos articles' },
            { path: 'homepage.cta.title', text: 'Get started' },
          ],
        },
        { domain: 'absent.com', error: 'missing' },
      ],
    }),
    {},
  );

  const { sites } = await service.scan('vps-003', ['caswellscoffee.com', 'absent.com']);
  const site = sites[0];
  assert.equal(site.lang, 'UK');
  assert.equal(site.langSource, 'config');
  assert.equal(site.items.length, 2);

  const [detected, label] = site.items;
  assert.equal(detected.path, 'site_tagline');
  assert.equal(detected.suggestion, null); // phrase éditoriale : le dictionnaire ne la connaît pas
  assert.equal(detected.source, 'detected');
  // « Nos articles » : deux mots, invisible pour l'analyse statistique, évident pour le dictionnaire.
  assert.equal(label.path, 'homepage.hero.badge');
  assert.equal(label.suggestion, 'Our articles');
  assert.equal(label.source, 'dictionary');
  // « Get started » est déjà en anglais : aucun texte ajouté pour lui.
  assert.equal(site.items.filter((i) => i.path === 'homepage.cta.title').length, 0);

  assert.equal(sites[1].error, 'missing');
  assert.deepEqual(sites[1].items, []);
});

test('analyse : lot vide ou surdimensionné refusé', async () => {
  const service = new TranslationService(fakeSsh, fakeSites({ sites: [] }), {});
  assert.equal(await key(() => service.scan('vps-003', [])), 'errors.translate_no_domain');
  assert.equal(await key(() => service.scan('vps-003', new Array(200).fill('a.com'))), 'errors.translate_batch_too_big');
});

test('traduction automatique : refusée tant qu aucune clé n est configurée', async () => {
  const sans = new TranslationService(fakeSsh, fakeSites({ sites: [] }), {});
  assert.equal(sans.machineAvailable, false);
  assert.equal(await key(() => sans.translate(['x'], { from: 'FR', to: 'UK' })), 'errors.translate_unavailable');

  const avec = new TranslationService(fakeSsh, fakeSites({ sites: [] }), { deeplKey: 'abc:fx' });
  assert.equal(avec.machineAvailable, true);
  assert.equal(await key(() => avec.translate(['x'], { from: 'FR', to: 'klingon' })), 'errors.translate_lang_unknown');
});

test('application : rien à écrire sans modification', async () => {
  const service = new TranslationService(fakeSsh, fakeSites({ sites: [] }), {});
  assert.equal(await key(() => service.apply('vps-003', 'a.com', [])), 'errors.translate_nothing');
  const out = await service.apply('vps-003', 'a.com', [{ path: 'site_tagline', from: 'a', to: 'b' }]);
  assert.equal(out.applied.length, 1);
});

test('script d analyse : transport et garde-fous', () => {
  // Les chemins techniques ne sont jamais proposés à la traduction.
  assert.match(SCAN_LANG, /url\|href\|link\|slug\|id\|image/);
  // Un config.php illisible ne doit pas emporter le lot entier.
  assert.match(SCAN_LANG, /catch \(\\Throwable/);
  // Les expressions régulières doivent avoir survécu au gabarit JavaScript.
  assert.match(SCAN_LANG, /preg_split\('\/\\s\+\/'/);
  assert.ok(SCAN_LANG.includes("[^\\p{L}']+"));
  assert.ok(!SCAN_LANG.includes('${'));
});

test('emplacements : un chemin de configuration devient une phrase', async () => {
  // Le module d'interface est chargé tel quel : sans dictionnaire chargé, `t` renvoie
  // la clé, ce qui laisse voir la structure construite — c'est elle qu'on vérifie ici.
  const { whereLabel } = await import('../public/js/translate.js');
  assert.equal(whereLabel('homepage.hero.title'), 'hero — title');
  assert.equal(whereLabel('homepage.faq.items.2.q'), 'faq — q 3');
  assert.equal(whereLabel('homepage.split.features.0'), 'split — features 1');
  // Champ posé directement sur la page, hors bloc (libellé réel : « Description pour les moteurs »).
  assert.equal(whereLabel('homepage.meta_description'), 'meta_description');
  assert.equal(whereLabel('site_tagline'), 'translate.where.site_tagline');
  assert.equal(whereLabel('inconnu.chose'), 'inconnu.chose');
});
