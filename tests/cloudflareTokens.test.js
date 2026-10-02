import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { HORS_PORTEE, PERMISSIONS, buildTokenRequest, createScopedToken, revokeToken, verifyToken } from '../src/services/cloudflareTokens.js';
import { CloudflareService } from '../src/services/cloudflareService.js';
import { importCsv } from '../src/services/cloudflareImport.js';
import { prepare } from '../src/db/mysql.js';
import { creerBaseJetable } from './mysqlTestDb.js';

/**
 * Remplacer une clé globale par un jeton à portée limitée.
 *
 * La base porte 38 195 clés GLOBALES, et une clé globale ouvre la totalité d'un compte
 * Cloudflare — facturation, membres, Workers, suppression de zones. Le back-office a
 * besoin de six permissions.
 *
 * CE QUI EST VÉRIFIÉ ICI EST L'ORDRE DES GESTES. Créer, VÉRIFIER, enregistrer, puis
 * seulement effacer la clé. Un jeton inutilisable avec une clé déjà effacée laisserait
 * le domaine injoignable, et c'est précisément le genre de panne qu'on ne découvre
 * qu'en production.
 *
 * Aucun appel ne sort : une fausse API Cloudflare répond à la place.
 */
const base = creerBaseJetable('cftokens');
before(() => base.ouvrir({ seedRoles: false }));
after(() => base.fermer());

const CLE = 'a'.repeat(37);
const ID = (c) => c.repeat(32);
const EN_TETE = '"domain","account_id","global_api_key","zone_id"';
const ligne = (d, a, k, z) => `"${d}","${a}","${k}","${z}"`;

/**
 * Une fausse API Cloudflare.
 *
 * Elle note ce qu'on lui demande — c'est ce qui permet de vérifier l'ORDRE des appels,
 * qui est tout l'enjeu ici — et répond ce qu'on lui a dit de répondre.
 */
function fausseApi({ tokenValue = 'T'.repeat(40), verifyStatus = 'active', createFails = false } = {}) {
  const vu = [];
  const vrai = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const methode = options.method ?? 'GET';
    vu.push({ methode, url: u, body: options.body ? JSON.parse(options.body) : null, headers: options.headers ?? {} });

    // Le client lit la réponse en TEXTE puis la décode : la fausse API doit répondre
    // comme la vraie, sans quoi on contrôlerait autre chose que le code réel.
    const repondre = (result) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ success: true, result, errors: [] }) });

    if (u.endsWith('/user/tokens') && methode === 'POST') {
      if (createFails) {
        return { ok: false, status: 403, headers: { get: () => null }, text: async () => JSON.stringify({ success: false, errors: [{ code: 9109, message: 'interdit' }] }) };
      }
      return repondre({ id: ID('7'), value: tokenValue, name: 'LKM Back-Office', status: 'active' });
    }
    if (u.endsWith('/user/tokens/verify')) return repondre({ id: ID('7'), status: verifyStatus });
    if (/\/user\/tokens\/[0-9a-f]{32}$/.test(u) && methode === 'DELETE') return repondre({ id: ID('7') });
    return repondre([]);
  };
  return { vu, rendre: () => { globalThis.fetch = vrai; } };
}

/** Un compte avec une clé globale et une adresse : le cas à convertir. */
async function unCompte(domain = 'exemple.com') {
  await base.vider('cf_zones', 'cf_accounts', 'cf_imports');
  await importCsv([EN_TETE, ligne(domain, ID('a'), CLE, ID('1'))].join('\n'), { source: 'essai' });
  await prepare("UPDATE cf_accounts SET email = ?").run(`${domain}@linkuma.co`);
}

// ───────── Ce qu'on accorde, et ce qu'on n'accorde pas ─────────

test('jeton : la portée est LE COMPTE, et lui seul', () => {
  // Sans cette restriction, le jeton vaudrait pour tous les comptes auxquels le
  // titulaire a accès — on n'aurait rien limité du tout.
  const d = buildTokenRequest(ID('a'));
  assert.deepEqual(Object.keys(d.policies[0].resources), [`com.cloudflare.api.account.${ID('a')}`]);
  assert.equal(d.policies[0].effect, 'allow');
  assert.equal(d.policies.length, 1, 'une seule règle : rien ne s’ajoute par mégarde');
});

test('jeton : exactement les six permissions nécessaires, pas une de plus', () => {
  const d = buildTokenRequest(ID('a'));
  const accordees = d.policies[0].permission_groups.map((g) => g.id);
  assert.equal(accordees.length, 6);
  assert.deepEqual(accordees, PERMISSIONS.map((p) => p.id));
  assert.equal(new Set(accordees).size, 6, 'aucun doublon');
  // Chacune porte un identifiant Cloudflare bien formé, et une raison lisible.
  for (const p of PERMISSIONS) {
    assert.match(p.id, /^[0-9a-f]{32}$/, `${p.nom} doit avoir un identifiant valide`);
    assert.ok(p.pourquoi.length > 10, `${p.nom} doit dire à quoi elle sert`);
  }
  assert.ok(HORS_PORTEE.length >= 4, 'ce qu’on n’accorde pas doit être écrit noir sur blanc');
});

test('jeton : l’adresse IP et l’expiration sont OPTIONNELLES', () => {
  // Les deux renforcent, et les deux peuvent casser : une IP qui change, un jeton qui
  // expire un matin sans que personne n'y ait pensé. D'où le choix de ne rien imposer.
  const nu = buildTokenRequest(ID('a'));
  assert.equal(nu.condition, undefined);
  assert.equal(nu.expires_on, undefined);

  const restreint = buildTokenRequest(ID('a'), { ip: ['203.0.113.7', '2001:db8::/32'], expiresInDays: 90 });
  assert.deepEqual(restreint.condition['request.ip'].in, ['203.0.113.7', '2001:db8::/32']);
  assert.ok(new Date(restreint.expires_on) > new Date());

  // Une adresse qui n'en est pas une est refusée plutôt que transmise.
  assert.throws(() => buildTokenRequest(ID('a'), { ip: 'pas une adresse' }), /adresse IP invalide/);
});

test('jeton : un identifiant de compte douteux est refusé avant tout appel', () => {
  for (const mauvais of ['', 'abc', ID('a').slice(0, 31), `${ID('a')}x`, null, undefined]) {
    assert.throws(() => buildTokenRequest(mauvais), /compte invalide/, `doit être refusé : ${JSON.stringify(mauvais)}`);
  }
});

// ───────── L'ordre des gestes ─────────

test('jeton : créer, VÉRIFIER, enregistrer, puis effacer la clé — dans cet ordre', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await unCompte();
  const api = fausseApi();
  try {
    const out = await new CloudflareService().convertToToken('exemple.com');
    assert.equal(out.already, false);
    assert.equal(out.tokenId, ID('7'));
    assert.equal(out.keyDropped, true);

    // L'ORDRE, lu dans les appels réellement passés.
    const chemins = api.vu.map((a) => `${a.methode} ${a.url.replace('https://api.cloudflare.com/client/v4', '')}`);
    assert.deepEqual(chemins, ['POST /user/tokens', 'GET /user/tokens/verify']);

    // La création emploie la CLÉ GLOBALE — c'est le seul moment où elle sert.
    assert.equal(api.vu[0].headers['X-Auth-Key'], CLE);
    assert.equal(api.vu[0].headers['X-Auth-Email'], 'exemple.com@linkuma.co');
    // La vérification emploie LE JETON : c'est la seule façon de savoir qu'il marche.
    assert.equal(api.vu[1].headers.Authorization, `Bearer ${'T'.repeat(40)}`);

    const compte = await prepare('SELECT api_token, global_api_key, verified_at FROM cf_accounts').get();
    assert.equal(compte.api_token, 'T'.repeat(40), 'le jeton est enregistré : sa valeur n’est montrée qu’une fois');
    assert.equal(compte.global_api_key, '', 'et la clé globale ne figure plus dans NOTRE base');
    assert.ok(Number(compte.verified_at) > 0);
  } finally {
    api.rendre();
  }
});

test('jeton : un jeton inutilisable ne remplace RIEN', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await unCompte();
  // Un jeton créé mais inactif existe. Sans la vérification, on l'enregistrerait, on
  // effacerait la clé, et on ne le découvrirait qu'au premier usage — en production.
  const api = fausseApi({ verifyStatus: 'disabled' });
  try {
    await assert.rejects(
      () => new CloudflareService().convertToToken('exemple.com'),
      (err) => err.key === 'errors.cf_token_unusable',
    );
    const chemins = api.vu.map((a) => `${a.methode} ${a.url.split('/v4')[1]}`);
    assert.ok(chemins.includes('DELETE /user/tokens/' + ID('7')), 'le jeton bancal est révoqué, pas laissé derrière');

    const compte = await prepare('SELECT api_token, global_api_key FROM cf_accounts').get();
    assert.equal(compte.api_token, '', 'aucun jeton enregistré');
    assert.equal(compte.global_api_key, CLE, 'ET LA CLÉ EST INTACTE : le domaine reste joignable');
  } finally {
    api.rendre();
  }
});

test('jeton : si Cloudflare refuse la création, la clé ne bouge pas', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await unCompte();
  const api = fausseApi({ createFails: true });
  try {
    await assert.rejects(() => new CloudflareService().convertToToken('exemple.com'));
    const compte = await prepare('SELECT api_token, global_api_key FROM cf_accounts').get();
    assert.equal(compte.global_api_key, CLE);
    assert.equal(compte.api_token, '');
  } finally {
    api.rendre();
  }
});

test('jeton : on peut CONSERVER la clé le temps de prendre confiance', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await unCompte();
  const api = fausseApi();
  try {
    const out = await new CloudflareService().convertToToken('exemple.com', { dropKey: false });
    assert.equal(out.keyDropped, false);
    const compte = await prepare('SELECT api_token, global_api_key FROM cf_accounts').get();
    assert.equal(compte.api_token, 'T'.repeat(40));
    assert.equal(compte.global_api_key, CLE, 'la clé reste, l’exposition aussi — c’est un choix explicite');
  } finally {
    api.rendre();
  }
});

test('jeton : un compte déjà converti n’est pas retouché', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await unCompte();
  await prepare("UPDATE cf_accounts SET api_token = ?, global_api_key = ''").run('D'.repeat(40));
  const api = fausseApi();
  try {
    const out = await new CloudflareService().convertToToken('exemple.com');
    assert.equal(out.already, true);
    assert.equal(api.vu.length, 0, 'aucun appel : on ne crée pas un second jeton pour rien');
  } finally {
    api.rendre();
  }
});

test('jeton : sans adresse ou sans clé, on refuse AVANT d’appeler', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  const api = fausseApi();
  try {
    await unCompte();
    await prepare("UPDATE cf_accounts SET email = ''").run();
    await assert.rejects(() => new CloudflareService().convertToToken('exemple.com'), (e) => e.key === 'errors.cf_no_email');

    await prepare("UPDATE cf_accounts SET email = 'x@y.fr', global_api_key = ''").run();
    await assert.rejects(() => new CloudflareService().convertToToken('exemple.com'), (e) => e.key === 'errors.cf_no_access');

    await assert.rejects(() => new CloudflareService().convertToToken('jamais-vu.com'), (e) => e.key === 'errors.cf_unknown_domain');
    assert.equal(api.vu.length, 0, 'aucun appel inutile : le quota n’est pas entamé');
  } finally {
    api.rendre();
  }
});

// ───────── Le relevé ─────────

test('jeton : le relevé dit où en est la conversion', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await base.vider('cf_zones', 'cf_accounts', 'cf_imports');
  await importCsv([
    EN_TETE,
    ligne('un.com', ID('a'), CLE, ID('1')),
    ligne('deux.com', ID('b'), CLE, ID('2')),
    ligne('trois.com', ID('c'), CLE, ID('3')),
  ].join('\n'), { source: 'essai' });
  await prepare("UPDATE cf_accounts SET email = CONCAT(account_id, '@linkuma.co')").run();
  await prepare("UPDATE cf_accounts SET api_token = ?, global_api_key = '' WHERE account_id = ?").run('D'.repeat(40), ID('a'));
  // Un compte sans adresse n'est pas convertible : une clé globale sans e-mail ne
  // permet même pas de créer le jeton.
  await prepare("UPDATE cf_accounts SET email = '' WHERE account_id = ?").run(ID('c'));

  const etat = await new CloudflareService().tokenProgress();
  assert.deepEqual(etat, { total: 3, withToken: 1, withGlobalKey: 2, convertible: 1 });
});

// ───────── Les fonctions de base ─────────

test('jeton : la vérification lit l’état rendu par Cloudflare', async () => {
  const api = fausseApi({ verifyStatus: 'active' });
  try {
    assert.deepEqual(await verifyToken('T'.repeat(40)), { ok: true, status: 'active' });
  } finally {
    api.rendre();
  }
  const bancal = fausseApi({ verifyStatus: 'expired' });
  try {
    assert.deepEqual(await verifyToken('T'.repeat(40)), { ok: false, status: 'expired' });
  } finally {
    bancal.rendre();
  }
});

test('jeton : révoquer exige un identifiant valide', async () => {
  const api = fausseApi();
  try {
    await assert.rejects(() => revokeToken('pas-un-identifiant', { apiToken: 'x' }), /jeton invalide/);
    assert.equal(api.vu.length, 0);
    assert.deepEqual(await revokeToken(ID('7'), { apiToken: 'x'.repeat(40) }), { revoked: ID('7') });
  } finally {
    api.rendre();
  }
});

test('jeton : la valeur n’est rendue qu’une fois, et on le sait', async () => {
  // Cloudflare ne redonne JAMAIS la valeur d'un jeton après sa création. Si elle
  // manquait dans la réponse, l'enregistrer serait impossible et il faudrait recommencer.
  const vrai = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    text: async () => JSON.stringify({ success: true, result: { id: ID('7'), name: 'x', status: 'active' }, errors: [] }),
  });
  try {
    await assert.rejects(() => createScopedToken(ID('a'), { apiToken: 'x' }), /n’a pas rendu la valeur/);
  } finally {
    globalThis.fetch = vrai;
  }
});
