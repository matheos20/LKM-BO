import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { CloudflareService } from '../src/services/cloudflareService.js';
import { importCsv } from '../src/services/cloudflareImport.js';
import { prepare } from '../src/db/mysql.js';
import { creerBaseJetable } from './mysqlTestDb.js';

/**
 * Le côté LECTURE du module Cloudflare : l'inventaire, la recherche, le relevé.
 *
 * Aucun appel à l'API ici — ces méthodes ne lisent que la base. C'est justement la
 * partie que la migration a touchée, et celle que l'agent a sous les yeux en permanence.
 */
const base = creerBaseJetable('cfservice');
before(() => base.ouvrir({ seedRoles: false }));
after(() => base.fermer());

const CLE = 'a'.repeat(37);
const ID = (c) => c.repeat(32);
const EN_TETE = '"domain","account_id","global_api_key","zone_id"';
const ligne = (d, a, k, z) => `"${d}","${a}","${k}","${z}"`;

const cf = new CloudflareService();

/** Un petit parc de huit domaines, sur trois comptes, dont un domaine inutilisable. */
async function parc() {
  await base.vider('cf_zones', 'cf_accounts', 'cf_imports');
  const csv = [
    EN_TETE,
    ligne('alpha.com', ID('a'), CLE, ID('1')),
    ligne('beta.com', ID('a'), CLE, ID('2')),
    ligne('gamma.fr', ID('a'), CLE, ID('3')),
    ligne('delta.fr', ID('b'), CLE, ID('4')),
    ligne('epsilon.org', ID('b'), CLE, ID('5')),
    // Sans identifiant de zone : connu, mais pas utilisable tel quel.
    ligne('sans-zone.com', ID('b'), CLE, 'NULL'),
    ligne('zeta.com', ID('c'), CLE, ID('6')),
    ligne('eta.com', ID('c'), CLE, ID('7')),
  ].join('\n');
  await importCsv(csv, { source: 'essai' });
  // Les comptes reçoivent une adresse : sans elle, une clé globale ne sert à rien et
  // tout le parc serait compté comme bloqué.
  await prepare("UPDATE cf_accounts SET email = CONCAT(account_id, '@linkuma.co')").run();
}

test('Cloudflare : l’inventaire pagine, et ne dépasse jamais la borne', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await parc();

  const p1 = await cf.list({ perPage: 3, page: 1 });
  assert.deepEqual([p1.total, p1.pages, p1.page, p1.zones.length], [8, 3, 1, 3]);
  assert.deepEqual(p1.zones.map((z) => z.domain), ['alpha.com', 'beta.com', 'delta.fr'], 'par ordre alphabétique');

  const p3 = await cf.list({ perPage: 3, page: 3 });
  assert.equal(p3.zones.length, 2);
  assert.equal(p3.zones.at(-1).domain, 'zeta.com', 'le dernier du parc');

  // Une demande démesurée est ramenée à la borne : on ne sort pas 38 000 lignes d'un coup.
  assert.equal((await cf.list({ perPage: 10000 })).perPage, 200);
  assert.equal((await cf.list({ perPage: 0 })).perPage, 50);
  assert.equal((await cf.list({ page: 0 })).page, 1);
});

test('Cloudflare : la recherche ne se fait pas berner par un joker', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await parc();

  assert.equal((await cf.list({ search: 'alpha' })).total, 1);
  assert.equal((await cf.list({ search: '.fr' })).total, 2);
  assert.equal((await cf.list({ search: 'ALPHA' })).total, 1, 'la casse ne compte pas');

  assert.equal((await cf.list({ search: 'sans-zone' })).total, 1, 'le tiret est cherché pour lui-même');

  // LE POINT IMPORTANT. « % » et « _ » sont les jokers de LIKE : sans échappement, le
  // premier rend TOUT le parc et le second tout ce qui a au moins un caractère — soit
  // 38 266 lignes en production. Un nom de zone étant un nom d'hôte, aucun ne peut
  // contenir ces signes : les deux recherches doivent donc rendre zéro, et c'est
  // exactement ce que l'échappement garantit.
  assert.equal((await cf.list({ search: '%' })).total, 0, '« % » ne doit pas rendre le parc entier');
  assert.equal((await cf.list({ search: '_' })).total, 0, '« _ » non plus');
  assert.equal((await cf.list({ search: 'alpha%' })).total, 0, 'ni un joker collé à un vrai mot');
});

test('Cloudflare : « prêt » et « bloqué » partagent exactement le parc', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await parc();

  const prets = await cf.list({ status: 'ready', perPage: 200 });
  const bloques = await cf.list({ status: 'blocked', perPage: 200 });
  assert.equal(prets.total + bloques.total, 8, 'aucun domaine ne doit tomber entre les deux');
  assert.equal(bloques.total, 1, 'seul celui sans identifiant de zone');
  assert.equal(bloques.zones[0].domain, 'sans-zone.com');
  assert.ok(prets.zones.every((z) => z.ready === true));
  assert.ok(bloques.zones.every((z) => z.ready === false));
});

test('Cloudflare : AUCUNE clé ne sort de l’inventaire', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await parc();

  const { zones } = await cf.list({ perPage: 200 });
  const texte = JSON.stringify(zones);
  assert.ok(!texte.includes(CLE), 'la clé globale ne doit figurer nulle part dans la liste');
  // On dit SEULEMENT de quelle sorte d'accès il s'agit. L'identifiant de compte, lui,
  // n'est pas un secret : c'est une référence que l'agent recopie ailleurs.
  assert.ok(zones.every((z) => z.auth === 'key'));
  assert.ok(zones.every((z) => z.accountId.length === 32));
  assert.ok(zones.every((z) => !('globalApiKey' in z) && !('apiToken' in z)));
});

test('Cloudflare : la clé ne se révèle que par la demande qui la nomme', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await parc();

  // Cette méthode est appelée par une route qui exige le droit d'écriture et journalise
  // la demande : on saura toujours qui a révélé quelle clé, et quand.
  const acces = await cf.credentials('ALPHA.COM');
  assert.equal(acces.domain, 'alpha.com', 'le domaine est reconnu quelle que soit la casse');
  assert.equal(acces.globalApiKey, CLE);
  assert.equal(acces.zoneId, ID('1'));
  assert.equal(acces.apiToken, null);

  await assert.rejects(() => cf.credentials('jamais-vu.com'), (err) => err.key === 'errors.cf_unknown_domain');
});

test('Cloudflare : une liste collée rend ce qui existe ET ce qui manque', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await parc();

  // L'agent colle sa liste depuis un tableur ou un courriel. Un domaine absent de la
  // réponse doit se VOIR : sans cela, on croit avoir tout traité.
  const r = await cf.lookup('alpha.com\nabsent.com\nBETA.COM\npas un domaine\n\nalpha.com');
  assert.deepEqual(r.zones.map((z) => z.domain), ['alpha.com', 'beta.com'], 'dans l’ordre de la saisie, sans doublon');
  assert.deepEqual(r.missing, ['absent.com']);
  assert.equal(r.invalid.length, 1);
  assert.equal(r.invalid[0].raw, 'pas un domaine');
  assert.equal(r.requested, 4);

  // Une liste vide ne doit pas rendre tout le parc.
  assert.deepEqual((await cf.lookup('')).zones, []);
  assert.equal((await cf.lookup('')).requested, 0);
});

test('Cloudflare : une liste plus longue qu’un paquet revient entière', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await base.vider('cf_zones', 'cf_accounts', 'cf_imports');
  // La recherche est découpée en paquets de 400 : une liste de 900 domaines traverse
  // donc trois requêtes, et doit revenir d'un seul tenant, dans l'ordre.
  const lignes = [EN_TETE];
  for (let i = 0; i < 900; i += 1) lignes.push(ligne(`d${i}.com`, ID('a'), CLE, ID('1')));
  await importCsv(lignes.join('\n'), { source: 'masse' });

  const demandes = Array.from({ length: 900 }, (_, i) => `d${i}.com`);
  const r = await cf.lookup([...demandes, 'introuvable.com'].join('\n'));
  assert.equal(r.zones.length, 900);
  assert.deepEqual(r.zones.map((z) => z.domain), demandes, 'l’ordre de la saisie est conservé d’un paquet à l’autre');
  assert.deepEqual(r.missing, ['introuvable.com']);
});

test('Cloudflare : le relevé compte juste, et dit ce qui bloque', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await parc();

  const s = await cf.stats();
  assert.equal(s.accounts, 3);
  assert.equal(s.zones, 8);
  assert.equal(s.ready, 7);
  assert.equal(s.withoutZone, 1);
  assert.equal(s.withoutEmail, 0);
  assert.equal(typeof s.emailDomain, 'string');

  // Sans adresse, une clé globale ne sert à rien : le relevé doit le montrer, sinon
  // l'agent cherche longtemps pourquoi rien ne fonctionne.
  await prepare("UPDATE cf_accounts SET email = ''").run();
  const apres = await cf.stats();
  assert.equal(apres.withoutEmail, 3);
  assert.equal(apres.ready, 0, 'plus un seul domaine utilisable');
});

test('Cloudflare : les domaines inutilisables sont écartés AVANT tout appel', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await parc();

  // Chaque appel compte dans le quota du compte. Un domaine dont on sait déjà qu'il
  // échouera doit être écarté ici, avec son motif, et non consommer un appel pour rien.
  const { targets, skipped } = await cf.targets(['alpha.com', 'sans-zone.com', 'jamais-vu.com']);
  assert.deepEqual(targets.map((c) => c.domain), ['alpha.com']);
  assert.deepEqual(
    skipped.map((s) => [s.domain, s.reason]),
    [['sans-zone.com', 'errors.cf_zone_unknown'], ['jamais-vu.com', 'errors.cf_unknown_domain']],
  );

  // Un compte sans adresse ni jeton : l'accès existe, mais Cloudflare le refusera
  // (erreur 9106). Autant le dire tout de suite.
  await prepare("UPDATE cf_accounts SET email = '' WHERE account_id = ?").run(ID('a'));
  const apres = await cf.targets(['alpha.com']);
  assert.equal(apres.targets.length, 0);
  assert.equal(apres.skipped[0].reason, 'errors.cf_no_email');
});
