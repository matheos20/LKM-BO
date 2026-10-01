import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudflareError, authHeaders, cfPaginate, cfRequest, redact, runBatch } from '../src/services/cloudflareClient.js';
import {
  SSL_MODES, createDnsRecord, purgeCache, purgeMany, setAlwaysUseHttps, setAutoMinify,
  setBrowserCacheTtl, setSecurityLevel, setSslMode, setSslModeMany, validateDnsRecord,
} from '../src/services/cloudflareOps.js';

const CLE = 'a'.repeat(37);
const JETON = 'T'.repeat(40);
// Aucun test n'attend pour de vrai : les reprises sont immediates.
const VITE = { backoff: () => 0 };
const ZONE = 'b'.repeat(32);

/** Une API simulée : on dicte les réponses et on relit ce qui a été envoyé. */
function faussseApi(reponses) {
  const appels = [];
  const file = [...reponses];
  const impl = async (url, init = {}) => {
    appels.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    const r = file.length > 1 ? file.shift() : file[0];
    if (r.throw) throw Object.assign(new Error(r.throw), { name: r.name ?? 'TypeError' });
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      headers: { get: (k) => r.headers?.[k.toLowerCase()] ?? null },
      text: async () => JSON.stringify(r.body ?? { success: true, result: r.result ?? {} }),
    };
  };
  return { impl, appels };
}

const succes = (result, extra = {}) => ({ body: { success: true, result, ...extra } });
const echec = (status, code, message) => ({ status, body: { success: false, errors: [{ code, message }] } });

// ───────── Les secrets ne fuient pas ─────────

test('un secret ne survit pas à l’affichage', () => {
  assert.ok(!redact(`clé ${CLE} ici`).includes(CLE));
  assert.ok(!redact(`Authorization: Bearer ${JETON}`).includes(JETON));
  assert.ok(!redact(`jeton ${JETON}`).includes(JETON));
  // Et ce qui n'est pas un secret est laissé tel quel.
  assert.equal(redact('zone introuvable'), 'zone introuvable');
});

test('le message d’une erreur Cloudflare est déjà masqué', () => {
  const e = new CloudflareError(`refus pour ${CLE}`, { status: 403 });
  assert.ok(!e.message.includes(CLE), e.message);
});

// ───────── L'authentification ─────────

test('un jeton se présente seul, en Bearer', () => {
  assert.deepEqual(authHeaders({ apiToken: JETON }), { Authorization: `Bearer ${JETON}` });
});

test('une clé globale sans e-mail est refusée AVANT l’appel', () => {
  // Mesuré sur l'API le 01/10/2026 : elle répond « 9106 Missing X-Auth-Email header ».
  // Autant le dire tout de suite que de gâcher un appel et un quota.
  assert.throws(() => authHeaders({ globalApiKey: CLE }), (e) => e.code === 9106);
  assert.deepEqual(authHeaders({ globalApiKey: CLE, email: 'a@b.c' }), { 'X-Auth-Email': 'a@b.c', 'X-Auth-Key': CLE });
});

test('le jeton l’emporte sur la clé globale', () => {
  // Portée limitée, révocation simple : à choisir, c'est la bonne voie.
  assert.deepEqual(authHeaders({ apiToken: JETON, globalApiKey: CLE, email: 'a@b.c' }), { Authorization: `Bearer ${JETON}` });
});

test('sans aucun accès, on le dit clairement', () => {
  assert.throws(() => authHeaders({}), /aucun accès/);
});

// ───────── Les reprises ─────────

test('une erreur définitive n’est pas réessayée', async () => {
  const { impl, appels } = faussseApi([echec(403, 9106, 'Missing X-Auth-Email header')]);
  await assert.rejects(
    cfRequest(`/zones/${ZONE}`, { apiToken: JETON }, { fetchImpl: impl, retries: 3 }),
    (e) => e.status === 403 && e.code === 9106,
  );
  assert.equal(appels.length, 1, 'un mot de passe refusé ne devient pas bon en insistant');
});

test('une limite de taux est respectée, puis l’appel repasse', async () => {
  const { impl, appels } = faussseApi([
    { ...echec(429, 10000, 'rate limited'), headers: { 'retry-after': '0' } },
    succes({ id: ZONE, name: 'x.com' }),
  ]);
  const attentes = [];
  const r = await cfRequest(`/zones/${ZONE}`, { apiToken: JETON }, { fetchImpl: impl, onRetry: (i) => attentes.push(i), ...VITE });
  assert.equal(r.result.name, 'x.com');
  assert.equal(appels.length, 2);
  assert.equal(attentes.length, 1, 'l’appelant est prévenu de l’attente');
  assert.equal(attentes[0].status, 429);
});

test('une panne passagère est réessayée, une panne durable abandonnée', async () => {
  const { impl } = faussseApi([{ throw: 'network down', name: 'TypeError' }, succes({ id: ZONE })]);
  assert.equal((await cfRequest('/zones/x', { apiToken: JETON }, { fetchImpl: impl, ...VITE })).result.id, ZONE);

  const dur = faussseApi([{ throw: 'network down', name: 'TypeError' }]);
  await assert.rejects(cfRequest('/zones/x', { apiToken: JETON }, { fetchImpl: dur.impl, retries: 1, ...VITE }));
  assert.equal(dur.appels.length, 2, 'un essai, puis une reprise, puis on renonce');
});

test('la pagination va jusqu’au bout', async () => {
  const { impl, appels } = faussseApi([
    succes([{ id: '1' }, { id: '2' }], { result_info: { total_pages: 2 } }),
    succes([{ id: '3' }], { result_info: { total_pages: 2 } }),
  ]);
  const tout = await cfPaginate('/zones/x/dns_records', { apiToken: JETON }, { fetchImpl: impl, perPage: 2 });
  assert.equal(tout.length, 3);
  assert.ok(appels[0].url.includes('page=1'));
  assert.ok(appels[1].url.includes('page=2'));
});

// ───────── Les lots ─────────

test('un lot va au bout malgré les échecs, et rend tout dans l’ordre', async () => {
  const sorties = await runBatch([1, 2, 3, 4], async (n) => {
    if (n % 2 === 0) throw new CloudflareError(`refus ${n}`, { status: 403 });
    return n * 10;
  }, { concurrency: 2 });

  assert.equal(sorties.length, 4);
  assert.deepEqual(sorties.map((s) => s.ok), [true, false, true, false]);
  assert.equal(sorties[0].result, 10);
  assert.match(sorties[1].error, /refus 2/);
});

test('un lot ne lance jamais plus d’appels que la limite fixée', async () => {
  let enCours = 0;
  let pointe = 0;
  await runBatch(Array.from({ length: 20 }, (_, i) => i), async () => {
    enCours += 1;
    pointe = Math.max(pointe, enCours);
    await new Promise((r) => setTimeout(r, 5));
    enCours -= 1;
  }, { concurrency: 3 });
  assert.ok(pointe <= 3, `jusqu’à ${pointe} appels simultanés, la limite était 3`);
});

// ───────── Les réglages ─────────

test('le mode SSL n’accepte que les quatre valeurs de Cloudflare', async () => {
  const { impl, appels } = faussseApi([succes({ value: 'strict' })]);
  const r = await setSslMode(ZONE, 'strict', { apiToken: JETON }, { fetchImpl: impl });
  assert.equal(r.value, 'strict');
  assert.equal(appels[0].method, 'PATCH');
  assert.deepEqual(appels[0].body, { value: 'strict' });

  for (const mauvais of ['full_strict', 'ON', '', null, 'maximum']) {
    await assert.rejects(setSslMode(ZONE, mauvais, { apiToken: JETON }, { fetchImpl: impl }), /mode SSL inconnu/);
  }
  assert.equal(appels.length, 1, 'une valeur refusée ne consomme aucun appel');
  assert.deepEqual(SSL_MODES, ['off', 'flexible', 'full', 'strict']);
});

test('une zone mal formée est refusée sans appeler l’API', async () => {
  const { impl, appels } = faussseApi([succes({})]);
  await assert.rejects(setSslMode('pas-une-zone', 'full', { apiToken: JETON }, { fetchImpl: impl }), /zone invalide/);
  assert.equal(appels.length, 0);
});

test('la redirection HTTPS s’active et se coupe', async () => {
  const a = faussseApi([succes({ value: 'on' })]);
  assert.equal((await setAlwaysUseHttps(ZONE, true, { apiToken: JETON }, { fetchImpl: a.impl })).value, 'on');
  assert.deepEqual(a.appels[0].body, { value: 'on' });

  const b = faussseApi([succes({ value: 'off' })]);
  await setAlwaysUseHttps(ZONE, false, { apiToken: JETON }, { fetchImpl: b.impl });
  assert.deepEqual(b.appels[0].body, { value: 'off' });
});

test('le niveau de sécurité est contrôlé', async () => {
  const { impl } = faussseApi([succes({ value: 'under_attack' })]);
  assert.equal((await setSecurityLevel(ZONE, 'under_attack', { apiToken: JETON }, { fetchImpl: impl })).value, 'under_attack');
  await assert.rejects(setSecurityLevel(ZONE, 'panique', { apiToken: JETON }, { fetchImpl: impl }), /niveau de sécurité inconnu/);
});

test('la minification ne promet plus le JavaScript', async () => {
  // Cloudflare l'a retiré en août 2024 : l'annoncer serait mentir.
  const { impl, appels } = faussseApi([succes({ value: { css: 'on', html: 'on', js: 'off' } })]);
  await setAutoMinify(ZONE, { css: true, html: true }, { apiToken: JETON }, { fetchImpl: impl });
  assert.equal(appels[0].body.value.js, 'off');
  assert.equal(appels[0].body.value.css, 'on');
});

test('la durée de cache navigateur doit être un palier accepté', async () => {
  const { impl, appels } = faussseApi([succes({ value: 3600 })]);
  await setBrowserCacheTtl(ZONE, 3600, { apiToken: JETON }, { fetchImpl: impl });
  assert.equal(appels[0].body.value, 3600);
  await assert.rejects(setBrowserCacheTtl(ZONE, 42, { apiToken: JETON }, { fetchImpl: impl }), /non acceptée/);
});

// ───────── La purge ─────────

test('purger tout et purger une sélection sont deux demandes distinctes', async () => {
  const a = faussseApi([succes({})]);
  assert.equal((await purgeCache(ZONE, { everything: true }, { apiToken: JETON }, { fetchImpl: a.impl })).purged, 'everything');
  assert.deepEqual(a.appels[0].body, { purge_everything: true });

  const b = faussseApi([succes({})]);
  const r = await purgeCache(ZONE, { files: ['https://x.com/a', 'https://x.com/b'] }, { apiToken: JETON }, { fetchImpl: b.impl });
  assert.equal(r.count, 2);
  assert.deepEqual(b.appels[0].body.files, ['https://x.com/a', 'https://x.com/b']);
});

test('une purge par lots de trente, comme l’API l’exige', async () => {
  const { impl, appels } = faussseApi([succes({})]);
  const urls = Array.from({ length: 70 }, (_, i) => `https://x.com/p${i}`);
  const r = await purgeCache(ZONE, { files: urls }, { apiToken: JETON }, { fetchImpl: impl });
  assert.equal(appels.length, 3, '70 adresses → trois appels');
  assert.equal(appels[0].body.files.length, 30);
  assert.equal(appels[2].body.files.length, 10);
  assert.equal(r.count, 70);
});

test('une purge vide ou une adresse incomplète sont refusées', async () => {
  const { impl, appels } = faussseApi([succes({})]);
  await assert.rejects(purgeCache(ZONE, {}, { apiToken: JETON }, { fetchImpl: impl }), /rien à purger/);
  await assert.rejects(purgeCache(ZONE, { files: ['/page'] }, { apiToken: JETON }, { fetchImpl: impl }), /adresse à purger doit être complète/);
  assert.equal(appels.length, 0);
});

// ───────── Le DNS ─────────

test('un enregistrement DNS est contrôlé avant d’être envoyé', () => {
  assert.deepEqual(validateDnsRecord({ type: 'a', name: 'x.com', content: '1.2.3.4' }), {
    type: 'A', name: 'x.com', content: '1.2.3.4', ttl: 1, proxied: false,
  });
  assert.throws(() => validateDnsRecord({ type: 'INCONNU', name: 'x', content: 'y' }), /type d’enregistrement inconnu/);
  assert.throws(() => validateDnsRecord({ type: 'A', name: 'x.com', content: 'pas-une-ip' }), /adresse IPv4/);
  assert.throws(() => validateDnsRecord({ type: 'A', name: 'x.com', content: '1.2.3.999' }), /hors limites/);
  assert.throws(() => validateDnsRecord({ type: 'MX', name: 'x.com', content: 'mail.x.com' }), /priorité/);
  assert.throws(() => validateDnsRecord({ type: 'A', name: 'x.com', content: '1.2.3.4', ttl: 10 }), /durée de vie/);
});

test('seuls A, AAAA et CNAME passent par le relais de Cloudflare', () => {
  assert.equal(validateDnsRecord({ type: 'A', name: 'x', content: '1.2.3.4', proxied: true }).proxied, true);
  assert.equal(validateDnsRecord({ type: 'TXT', name: 'x', content: 'v=spf1', proxied: true }).proxied, false);
});

test('la création DNS envoie exactement ce qui a été validé', async () => {
  const { impl, appels } = faussseApi([succes({ id: 'rec1' })]);
  const r = await createDnsRecord(ZONE, { type: 'CNAME', name: 'www.x.com', content: 'x.com', proxied: true }, { apiToken: JETON }, { fetchImpl: impl });
  assert.equal(r.id, 'rec1');
  assert.equal(appels[0].method, 'POST');
  assert.deepEqual(appels[0].body, { type: 'CNAME', name: 'www.x.com', content: 'x.com', ttl: 1, proxied: true });
});

// ───────── Les opérations de masse ─────────

test('une purge sur plusieurs domaines rend le sort de chacun', async () => {
  // Un domaine sur trois est refuse par l'API : le lot doit aller au bout et dire,
  // pour chacun, ce qui s'est passe.
  const refuse = 'c'.repeat(32);
  const impl = async (url) => {
    const ko = url.includes(refuse);
    return {
      ok: !ko,
      status: ko ? 403 : 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(ko ? { success: false, errors: [{ code: 1001, message: 'refuse' }] } : { success: true, result: {} }),
    };
  };
  const cibles = [
    { domain: 'un.com', zoneId: 'a'.repeat(32), creds: { apiToken: JETON } },
    { domain: 'deux.com', zoneId: refuse, creds: { apiToken: JETON } },
    { domain: 'trois.com', zoneId: 'd'.repeat(32), creds: { apiToken: JETON } },
  ];

  const r = await purgeMany(cibles, { everything: true }, { concurrency: 2, request: { fetchImpl: impl, ...VITE } });
  assert.equal(r.total, 3);
  assert.equal(r.succeeded, 2);
  assert.equal(r.failed, 1);
  // L'ordre d'entree est conserve : un releve de masse doit se relire.
  assert.deepEqual(r.results.map((x) => x.domain), ['un.com', 'deux.com', 'trois.com']);
  assert.equal(r.results[1].ok, false);
  assert.equal(r.results[1].status, 403);
  assert.match(r.results[1].error, /refuse/);
});

test('un changement de mode SSL en masse ne s’arrête pas au premier refus', async () => {
  const cibles = [
    { domain: 'a.com', zoneId: 'a'.repeat(32), creds: {} }, // aucun accès : refus immédiat
    { domain: 'b.com', zoneId: 'b'.repeat(32), creds: {} },
  ];
  const r = await setSslModeMany(cibles, 'full', { concurrency: 2 });
  assert.equal(r.total, 2);
  assert.equal(r.failed, 2);
  assert.equal(r.succeeded, 0);
  for (const x of r.results) assert.match(x.error, /aucun accès/);
});
