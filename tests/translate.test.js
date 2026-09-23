import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dictionaryLookup, machineTranslate, normalizeLang, pickProvider } from '../src/services/langTools.js';
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
  // Même texte à un accent près : ce n'est pas une traduction. 51 sites français du
  // parc écrivent « Questions frequentes » ; les proposer noierait le vrai travail.
  assert.equal(dictionaryLookup('Questions frequentes', 'FR'), null);
  assert.equal(dictionaryLookup('Questions frequentes', 'UK'), 'Frequently asked questions');
});

test('traduction automatique : trois services, une seule interface', async () => {
  let seen = null;
  const faux = (reponse) => async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => reponse };
  };

  // DeepL : formulaire, un champ « text » par texte.
  const deepl = pickProvider({ deeplKey: 'abc:fx' });
  const a = await machineTranslate(['Notre guide du café'], { from: 'FR', to: 'UK', provider: deepl, fetchImpl: faux({ translations: [{ text: 'Our coffee guide' }] }) });
  assert.deepEqual(a, ['Our coffee guide']);
  assert.match(seen.url, /api-free\.deepl\.com/); // la clé « :fx » désigne l'offre gratuite
  const body = new URLSearchParams(seen.init.body);
  assert.equal(body.get('target_lang'), 'EN-GB'); // la cible accepte la variante régionale…
  assert.equal(body.get('source_lang'), 'FR');
  assert.equal(body.get('tag_handling'), 'html'); // les balises d'un titre doivent survivre
  await machineTranslate(['Olá'], { from: 'PT', to: 'FR', provider: deepl, fetchImpl: faux({ translations: [] }) });
  assert.equal(new URLSearchParams(seen.init.body).get('source_lang'), 'PT'); // …la source, non

  // Google : JSON, et une réponse échappée en HTML qu'il faut redéchiffrer.
  const google = pickProvider({ googleKey: 'AIzaXXX' });
  const b = await machineTranslate(["L'été"], { from: 'FR', to: 'UK', provider: google, fetchImpl: faux({ data: { translations: [{ translatedText: 'Summer &#39;s &amp; heat' }] } }) });
  assert.deepEqual(b, ["Summer 's & heat"]);
  assert.match(seen.url, /translation\.googleapis\.com.*key=AIzaXXX/);
  assert.deepEqual(JSON.parse(seen.init.body), { q: ["L'été"], target: 'en', source: 'fr', format: 'html' });

  // LibreTranslate : installable chez soi, l'adresse vient de la configuration.
  const libre = pickProvider({ libreUrl: 'https://lt.exemple.net/' });
  const c = await machineTranslate(['Bonjour'], { from: 'FR', to: 'DE', provider: libre, fetchImpl: faux({ translatedText: ['Guten Tag'] }) });
  assert.deepEqual(c, ['Guten Tag']);
  assert.equal(seen.url, 'https://lt.exemple.net/translate'); // pas de double barre oblique
  assert.equal(JSON.parse(seen.init.body).target, 'de');

  // Aucun service configuré : silence, pas d'erreur.
  assert.equal(pickProvider({}), null);
  assert.equal(await machineTranslate(['x'], { from: 'FR', to: 'UK', provider: null }), null);
});

test('service en panne : le message du service remonte jusqu à l agent', async () => {
  const provider = pickProvider({ deeplKey: 'abc:fx' });
  const fetchImpl = async () => ({ ok: false, status: 456, json: async () => ({ message: 'Quota exceeded' }) });
  await assert.rejects(() => machineTranslate(['x'], { from: 'FR', to: 'UK', provider, fetchImpl }), /Quota exceeded/);
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
  assert.equal(avec.providerName, 'deepl');
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

test('périmètre : une liste collée depuis un tableur est comprise', async () => {
  const { parseDomains } = await import('../public/js/actions.js');
  // Séparateurs libres, adresses complètes, doublons, casse, espaces.
  assert.deepEqual(parseDomains('caswellscoffee.com\ndinemec.com, mandyscarr.com'), ['caswellscoffee.com', 'dinemec.com', 'mandyscarr.com']);
  assert.deepEqual(parseDomains('https://www.Ukinco.com/business/page.php'), ['ukinco.com']);
  assert.deepEqual(parseDomains('a.com ; a.com | A.COM'), ['a.com']);
  assert.deepEqual(parseDomains('  spirotiger.net.  '), ['spirotiger.net']);
  // Ce qui n'est pas un domaine est écarté sans bruit.
  assert.deepEqual(parseDomains('domaine\n-\n123\n'), []);
  assert.deepEqual(parseDomains(''), []);
});

test('certitude : un texte court mais dense ne demande pas de vérification', async () => {
  const { uncertainFor } = await import('../public/js/translate.js');
  const cas = (score, words, gap) => uncertainFor({ source: 'detected', score, words, gap });

  // Relevés réels du parc, tous du français sur des sites anglais.
  assert.equal(cas(3, 3, 3), false); // « S'informer, s'instruire, s'épanouir. »
  assert.equal(cas(3, 4, 3), false); // « « L'essentiel est une discipline » »
  assert.equal(cas(3, 5, 1), false); // « L'art de la <em>maîtrise</em> quotidienne »
  assert.equal(cas(2, 5, 2), false); // « Un avenir aux <em>ressources</em> limitées »
  assert.equal(cas(5, 10, 3), false); // le slogan de seosoftwareservices.com

  // Les cas réellement douteux restent signalés.
  assert.equal(cas(2, 4, 1), true); // « Voyageur en van aménagé » — en/van sont aussi néerlandais
  assert.equal(cas(2, 4, 2), true); // « L'intelligence des usages durables » — court et peu dense
  assert.equal(cas(2, 8, 1), true); // long mais indécis

  // Une expression reconnue par le dictionnaire ne se discute pas.
  assert.equal(uncertainFor({ source: 'dictionary' }), false);
});

test('Claude : contrainte de forme, balises conservées, décalage refusé', async () => {
  let vu = null;
  const client = (reponse) => ({
    messages: {
      parse: async (params) => {
        vu = params;
        return reponse;
      },
    },
  });

  const provider = pickProvider({ client: client({ parsed_output: { translations: ['The art of daily <em>mastery</em>'] } }) });
  assert.equal(provider.name, 'claude');
  const out = await machineTranslate(["L'art de la <em>maîtrise</em> quotidienne"], { from: 'FR', to: 'UK', provider });
  assert.deepEqual(out, ['The art of daily <em>mastery</em>']);

  // Des NOMS de langue, pas des codes : « UK » ne veut rien dire pour un modèle.
  assert.match(vu.system, /from French into British English/);
  assert.match(vu.system, /Keep every inline HTML tag/);
  // La réponse est contrainte par un schéma, et l'effort reste bas : la tâche est courte.
  assert.equal(typeof vu.output_config.format, 'object');
  assert.equal(vu.output_config.effort, 'low');
  assert.equal(vu.model, 'claude-opus-5');
  assert.deepEqual(JSON.parse(vu.messages[0].content), ["L'art de la <em>maîtrise</em> quotidienne"]);

  // Un décalage rendrait les traductions à côté de leur texte : refusé plutôt que publié.
  const bancal = pickProvider({ client: client({ parsed_output: { translations: ['un', 'deux'] } }) });
  await assert.rejects(() => machineTranslate(['a'], { from: 'FR', to: 'UK', provider: bancal }), /2 traduction\(s\) pour 1 texte/);

  // Réponse illisible : on ne devine pas.
  const muet = pickProvider({ client: client({ parsed_output: null }) });
  await assert.rejects(() => machineTranslate(['a'], { from: 'FR', to: 'UK', provider: muet }), /illisible/);

  // Le modèle se choisit : un très gros lot peut préférer Haiku.
  const haiku = pickProvider({ claudeKey: 'sk', claudeModel: 'claude-haiku-4-5', client: client({ parsed_output: { translations: ['x'] } }) });
  await machineTranslate(['a'], { from: 'FR', to: 'UK', provider: haiku });
  assert.equal(vu.model, 'claude-haiku-4-5');
});

test('balises : mêmes balises, et autour des mêmes mots', async () => {
  const { tagSignature, innerWords, tagIssue } = await import('../public/js/translate.js');

  const source = 'Le hardware, cet <em>écosystème</em> fragile';
  assert.deepEqual(tagSignature(source), ['em', '/em']);
  assert.deepEqual(innerWords(source), [1]);

  // Relevé sur flashkod.com : la balise survit, mais elle a changé de mots — elle
  // couvrait « écosystème », elle couvre « Fragile Ecosystem ». C'est ce que l'alerte doit voir.
  assert.equal(tagIssue(source, 'Hardware: That <em>Fragile Ecosystem</em>'), 'translate.tags_moved');
  // Balise perdue, remplacée, mal fermée ou dédoublée : autre alerte.
  assert.equal(tagIssue(source, 'Hardware, that fragile ecosystem'), 'translate.tags_differ');
  assert.equal(tagIssue(source, 'Hardware, that fragile <strong>ecosystem</strong>'), 'translate.tags_differ');
  assert.equal(tagIssue(source, 'Hardware, that fragile <em>ecosystem'), 'translate.tags_differ');
  assert.equal(tagIssue(source, '<em>Hardware</em>, that <em>fragile</em> ecosystem'), 'translate.tags_differ');
  // Bonne traduction : mêmes balises, même mot mis en valeur.
  assert.equal(tagIssue(source, 'Hardware, that fragile <em>ecosystem</em>'), null);
  // Champ vide : l'agent n'a pas encore écrit, rien à signaler.
  assert.equal(tagIssue(source, '   '), null);

  assert.deepEqual(tagSignature('Texte sans balise'), []);
  assert.deepEqual(tagSignature('<A HREF="/x">Lien</A><br>'), ['a', '/a', 'br']);
  assert.deepEqual(innerWords('<em>un mot</em> et <strong>deux mots ici</strong>'), [2, 3]);
});
