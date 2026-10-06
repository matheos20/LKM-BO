import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DUREE_CACHE, ETATS, MAX_PAR_LOT, ReputationService, lireStatut, verdict } from '../src/services/reputationService.js';
import { HealthService, estSignale, resume } from '../src/services/healthService.js';

/**
 * La réputation d'un domaine, et la règle qui rend ce module digne de confiance.
 *
 * CE QUI A MOTIVÉ CE SERVICE, le 06/10/2026 : `gkmtaxzone.com` affichait « site
 * dangereux » dans le navigateur pendant que la santé du parc annonçait « tous les sites
 * vérifiés répondent normalement ». Les deux disaient vrai. Vérifié le jour même sur ce
 * domaine : certificat Google Trust Services valide jusqu'au 09/11/2026, HTTP 200,
 * 57 662 octets, aucun script étranger hormis la balise Cloudflare, aucune iframe, aucun
 * code obfusqué, aucune redirection JavaScript. Le site est sain ; sa RÉPUTATION ne
 * l'est pas, et une réputation ne se lit pas sur le serveur.
 *
 * LES RÉPONSES CI-DESSOUS SONT CELLES QUI ONT ÉTÉ RELEVÉES, recopiées telles quelles —
 * pas inventées. C'est la leçon du changement de thématique, où une éprouvette qui
 * reproduisait mon invention avait laissé passer une fonctionnalité cassée.
 */
const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE = readFileSync(join(RACINE, 'src/services/reputationService.js'), 'utf8');
const ECRAN = readFileSync(join(RACINE, 'public/js/health.js'), 'utf8');

/** Les réponses réelles du 06/10/2026, avec la garde anti-injection qui les précède. */
const REPONSES = {
  signale: ')]}\'\n[["sb.ssr",2,false,false,true,false,false,1790256475762,"gkmtaxzone.com",false]]',
  dangereux: ')]}\'\n[["sb.ssr",3,true,true,true,false,false,1791248611028,"testsafebrowsing.appspot.com",false]]',
  propre4: ')]}\'\n[["sb.ssr",4,false,false,false,false,false,1791190456485,"google.com",false]]',
  propre1: ')]}\'\n[["sb.ssr",1,false,false,false,false,false,1791274834165,"example.com",false]]',
  jamaisVu: ')]}\'\n[["sb.ssr",6,false,false,false,false,false,0,"ceci-nexiste-pas.com",false]]',
};

const reponse = (corps, status = 200) => ({ status, text: async () => corps });

// ─────────────────────────── le dépouillement ───────────────────────────

test('réputation : les réponses réellement relevées sont lues correctement', () => {
  const signale = lireStatut(REPONSES.signale);
  assert.equal(signale.code, 2);
  assert.deepEqual(signale.drapeaux, [false, false, true]);
  assert.equal(signale.checkedAt, 1790256475762);

  assert.deepEqual(lireStatut(REPONSES.dangereux).drapeaux, [true, true, true]);
  assert.deepEqual(lireStatut(REPONSES.propre4).drapeaux, [false, false, false]);
  assert.equal(lireStatut(REPONSES.propre1).code, 1);
  // Jamais visité : la date est à zéro, et c'est elle qui distingue « inconnu » de « sain ».
  assert.equal(lireStatut(REPONSES.jamaisVu).checkedAt, null);
});

test('réputation : tout ce qui ne ressemble pas à un verdict en est un refus', () => {
  // La règle qui rend ce module digne de confiance. Cette adresse n'est pas documentée
  // par Google : elle peut changer sans préavis, et ce jour-là le module doit se taire,
  // jamais rassurer.
  for (const sortie of [
    '',
    null,
    undefined,
    'une page HTML d’erreur',
    ')]}\'\n[]',
    ')]}\'\n[["autre.chose",2,false,false,true]]',
    ')]}\'\n[["sb.ssr","deux",false,false,true]]',
    ')]}\'\n[["sb.ssr",2,"oui","non","peut-etre"]]',
    ')]}\'\n[["sb.ssr",2]]',
    '{ ceci n’est pas du JSON',
  ]) {
    assert.equal(lireStatut(sortie), null, `« ${String(sortie).slice(0, 30)} » ne doit pas passer pour un verdict`);
    assert.equal(verdict(lireStatut(sortie)), ETATS.UNCHECKED);
  }
});

test('réputation : le verdict lit les DRAPEAUX, pas le code', () => {
  // Les codes 1 et 4 veulent tous deux dire « rien à signaler », le 6 « jamais visité » :
  // s'appuyer sur eux demanderait de deviner un tableau que Google ne publie pas. Les
  // drapeaux, eux, sont sans ambiguïté.
  assert.equal(verdict(lireStatut(REPONSES.signale)), ETATS.FLAGGED);
  assert.equal(verdict(lireStatut(REPONSES.dangereux)), ETATS.FLAGGED);
  assert.equal(verdict(lireStatut(REPONSES.propre4)), ETATS.CLEAN);
  assert.equal(verdict(lireStatut(REPONSES.propre1)), ETATS.CLEAN);
  assert.equal(verdict(lireStatut(REPONSES.jamaisVu)), ETATS.UNKNOWN, 'jamais visité n’est pas « sain »');
  // Un drapeau quelconque suffit, quelle que soit sa place.
  for (const rang of [2, 3, 4]) {
    const ligne = ['sb.ssr', 9, false, false, false, false, false, 123, 'x.com', false];
    ligne[rang] = true;
    assert.equal(verdict(lireStatut(JSON.stringify([ligne]))), ETATS.FLAGGED, `le drapeau ${rang} doit suffire`);
  }
});

// ─────────────────────────── le service ───────────────────────────

/** Un faux Google : un journal des domaines demandés, et la réponse qu'on choisit. */
function faux(table, { status = () => 200 } = {}) {
  const vus = [];
  const fetch = async (url) => {
    const domain = decodeURIComponent(String(url).split('site=')[1] ?? '');
    vus.push(domain);
    const code = status(domain, vus.length);
    if (code !== 200) return reponse('', code);
    return reponse(table[domain] ?? REPONSES.jamaisVu);
  };
  return { vus, fetch };
}

test('réputation : un domaine signalé l’est, les autres non', async () => {
  const g = faux({ 'gkmtaxzone.com': REPONSES.signale, 'bagnac.fr': REPONSES.propre1 });
  const s = new ReputationService({ fetch: g.fetch });
  const { results, interrupted } = await s.check(['gkmtaxzone.com', 'bagnac.fr', 'inconnu.fr']);
  assert.equal(results.get('gkmtaxzone.com').state, ETATS.FLAGGED);
  assert.equal(results.get('gkmtaxzone.com').code, 2);
  assert.equal(results.get('bagnac.fr').state, ETATS.CLEAN);
  assert.equal(results.get('inconnu.fr').state, ETATS.UNKNOWN);
  assert.equal(interrupted, false);
});

test('réputation : une rebuffade ARRÊTE le lot, et ne rend personne « sain »', async () => {
  // Insister ferait prendre notre adresse pour un robot. Et les domaines restants sont
  // rendus « non vérifiés » : ils ne disparaissent pas du résultat.
  const g = faux({}, { status: (d) => (d === 'deux.fr' ? 429 : 200) });
  const s = new ReputationService({ fetch: g.fetch });
  const { results, interrupted } = await s.check(['un.fr', 'deux.fr', 'trois.fr', 'quatre.fr'], { parallel: 2 });
  assert.equal(interrupted, true);
  assert.equal(results.size, 4, 'chaque domaine demandé a une entrée');
  assert.equal(results.get('deux.fr').state, ETATS.UNCHECKED);
  for (const d of ['trois.fr', 'quatre.fr']) assert.equal(results.get(d).state, ETATS.UNCHECKED);
  assert.ok(g.vus.length <= 2, `le lot doit s’arrêter net (vu : ${g.vus.length} interrogations)`);
  for (const r of results.values()) assert.notEqual(r.state, ETATS.CLEAN);
});

test('réputation : un à-coup réseau vaut un second essai, un REFUS n’en vaut aucun', async () => {
  // Mesuré le 06/10/2026 : le tout premier appel sortant d'un processus a mis 2,3 s là où
  // les suivants en mettent 0,4, et un essai à froid sur quatre a échoué. Laisser cet
  // à-coup faire taire le module aurait rendu « non vérifié » un domaine que trois
  // passages d'affilée ont signalé.
  let appels = 0;
  const bancal = new ReputationService({
    fetch: async (url) => {
      appels++;
      if (appels === 1) throw new Error('socket hang up');
      return reponse(REPONSES.signale);
    },
  });
  const { results, interrupted } = await bancal.check(['a.fr']);
  assert.equal(appels, 2, 'le réseau a droit à un second essai');
  assert.equal(results.get('a.fr').state, ETATS.FLAGGED);
  assert.equal(interrupted, false);

  // Un refus délibéré, lui, ne se réessaie pas : insister ferait prendre notre adresse
  // pour un robot.
  let refus = 0;
  const refuse = new ReputationService({ fetch: async () => { refus++; return reponse('', 429); } });
  const r = await refuse.check(['a.fr', 'b.fr'], { parallel: 1 });
  assert.equal(refus, 1, 'un seul appel, et on s’arrête — pas de second essai, pas de suite');
  assert.equal(r.interrupted, true);
});

test('réputation : sans accès sortant, tout est « non vérifié » et rien n’est affirmé', async () => {
  // Le cas de la machine de déploiement prévue : ses ports sortants sont fermés.
  const s = new ReputationService({ fetch: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
  const { results, interrupted } = await s.check(['a.fr', 'b.fr']);
  assert.equal(interrupted, true);
  assert.equal(results.get('a.fr').state, ETATS.UNCHECKED);
  assert.equal(results.get('b.fr').state, ETATS.UNCHECKED);
});

test('réputation : coupée, elle ne demande rien et ne prétend rien', async () => {
  const g = faux({});
  const s = new ReputationService({ fetch: g.fetch, enabled: false });
  const { results, off } = await s.check(['a.fr']);
  assert.equal(off, true);
  assert.equal(results.get('a.fr').state, ETATS.UNCHECKED);
  assert.equal(g.vus.length, 0, 'aucune requête ne doit partir');
});

test('réputation : rien n’est demandé deux fois en six heures', async () => {
  let horloge = 1000;
  const g = faux({ 'a.fr': REPONSES.signale });
  const s = new ReputationService({ fetch: g.fetch, now: () => horloge });
  await s.check(['a.fr', 'b.fr']);
  await s.check(['a.fr', 'b.fr']);
  assert.equal(g.vus.length, 2, 'le second passage lit le cache');
  horloge += DUREE_CACHE + 1;
  await s.check(['a.fr']);
  assert.equal(g.vus.length, 3, 'passé six heures, on redemande');
});

test('réputation : un « non vérifié » n’est JAMAIS mis en cache', async () => {
  // Sinon un incident réseau d'une seconde ferait taire le module pendant six heures.
  let refuse = true;
  const g = faux({ 'a.fr': REPONSES.signale }, { status: () => (refuse ? 503 : 200) });
  const s = new ReputationService({ fetch: g.fetch });
  assert.equal((await s.check(['a.fr'])).results.get('a.fr').state, ETATS.UNCHECKED);
  refuse = false;
  assert.equal((await s.check(['a.fr'])).results.get('a.fr').state, ETATS.FLAGGED, 'on réessaie, et on trouve');
});

test('réputation : la casse, les blancs et les doublons sont ramenés à un seul appel', async () => {
  const g = faux({ 'a.fr': REPONSES.propre1 });
  const s = new ReputationService({ fetch: g.fetch });
  const { results } = await s.check([' A.FR ', 'a.fr', 'A.fr', '', null]);
  assert.deepEqual(g.vus, ['a.fr']);
  assert.equal(results.size, 1);
});

test('réputation : un garde-fou empêche une avalanche de requêtes', async () => {
  // Un appel mal formé ne doit pas lancer cinq mille requêtes vers Google d'un coup.
  const g = faux({});
  const s = new ReputationService({ fetch: g.fetch });
  const trop = Array.from({ length: MAX_PAR_LOT + 25 }, (_, i) => `site-${i}.fr`);
  const { results, interrupted } = await s.check(trop);
  assert.equal(g.vus.length, MAX_PAR_LOT);
  assert.equal(results.size, trop.length, 'les domaines en trop ne sont pas oubliés');
  assert.equal(interrupted, true, 'et le lot est dit incomplet');
  assert.equal(results.get('site-224.fr').state, ETATS.UNCHECKED);
});

test('réputation : aucune liste vide ne part en requête', async () => {
  const g = faux({});
  const s = new ReputationService({ fetch: g.fetch });
  for (const vide of [[], null, undefined, ['', '  ']]) {
    const { results } = await s.check(vide);
    assert.equal(results.size, 0);
  }
  assert.equal(g.vus.length, 0);
});

// ─────────────────────────── la greffe dans la santé du parc ───────────────────────────

/** Le faux parc de `parcHealth.test.js`, réduit à ce dont cet essai a besoin. */
function fauxSsh(lignes) {
  return {
    server: () => ({ id: 'vps-001', label: 'VPS 001', wwwRoot: '/srv/www', httpPort: 8080 }),
    exec: async (id, cmd) => {
      if (cmd.includes('/proc/loadavg')) return { stdout: '1.0\n8\n0' };
      if (cmd.includes('find -L')) return { stdout: '' };
      return { stdout: lignes.join('\n') };
    },
  };
}

const sonde = (domain, code = 200) => [domain, String(code), '0.14', '57662', '', '0', `https://${domain}/`].join('\t');

test('santé : un site qui répond parfaitement mais que Google signale REMONTE', async () => {
  // L'essai de bout en bout du défaut constaté : HTTP 200, 57 662 octets, 0,14 s — les
  // chiffres mêmes relevés sur `gkmtaxzone.com` le 06/10/2026.
  const ssh = fauxSsh([sonde('lkm-sonde-sans-site.invalid', 404), sonde('gkmtaxzone.com')]);
  const g = faux({ 'gkmtaxzone.com': REPONSES.signale });
  const health = new HealthService(ssh, undefined, new ReputationService({ fetch: g.fetch }));
  const out = await health.scan('vps-001', ['gkmtaxzone.com'], { rate: 1e6 });

  const site = out.sites[0];
  assert.equal(site.state, 'ok', 'la sonde dit vrai : le site répond');
  assert.equal(site.reputation.state, ETATS.FLAGGED, 'et Google le signale');
  assert.ok(estSignale(site));
  assert.equal(out.summary.flagged, 1);
  assert.equal(out.summary.problems, 1, '« à regarder » ne peut plus afficher zéro');
  assert.equal(out.reputationIncomplete, false);
});

test('santé : une réputation illisible n’emporte pas l’analyse', async () => {
  // La santé du site est le renseignement principal ; la réputation est un supplément.
  const ssh = fauxSsh([sonde('lkm-sonde-sans-site.invalid', 404), sonde('bagnac.fr')]);
  const casse = new ReputationService({ fetch: async () => { throw new Error('réseau coupé'); } });
  const out = await new HealthService(ssh, undefined, casse).scan('vps-001', ['bagnac.fr'], { rate: 1e6 });
  assert.equal(out.sites[0].state, 'ok');
  assert.equal(out.sites[0].reputation.state, ETATS.UNCHECKED);
  assert.equal(out.summary.problems, 0, 'faute de verdict, on n’invente pas un problème');
  assert.equal(out.reputationIncomplete, true, 'mais l’écran doit pouvoir le dire');
});

test('santé : un site qui ne répond PAS porte quand même son verdict de réputation', async () => {
  const ssh = fauxSsh([sonde('lkm-sonde-sans-site.invalid', 404)]);
  const g = faux({ 'perdu.fr': REPONSES.signale });
  const out = await new HealthService(ssh, undefined, new ReputationService({ fetch: g.fetch })).scan('vps-001', ['perdu.fr'], { rate: 1e6 });
  assert.equal(out.sites[0].state, 'no_answer');
  assert.equal(out.sites[0].reputation.state, ETATS.FLAGGED);
  assert.equal(out.summary.problems, 1, 'il ne compte qu’une fois, pas deux');
});

// ─────────────────────────── ce que l’écran promet ───────────────────────────

test('réputation : l’écran ne peut plus dire « tout va bien » sur un site signalé', () => {
  assert.ok(ECRAN.includes("s.reputation?.state === 'flagged'"), 'l’écran sait reconnaître un site signalé');
  assert.ok(/const sains = \(\) =>[^;]*!signale\(s\)/s.test(ECRAN), 'un site signalé n’est pas compté parmi les sains');
  assert.ok(ECRAN.includes('sectionSignales()'), 'et il a sa section, en tête de page');
  assert.ok(ECRAN.includes('health.rep_unchecked'), 'ce qui n’a pas été vérifié est dit');
  assert.ok(ECRAN.includes('transparencyreport.google.com'), 'le lien vers la raison est donné à l’agent');
});

test('réputation : rien n’est demandé à une machine du parc', () => {
  // La réputation se lit chez Google. Aucun site du parc n'est sollicité, et rien n'est
  // écrit nulle part.
  for (const interdit of ['this.ssh', 'runPhp', 'writeFile', 'exec(']) {
    assert.ok(!SERVICE.includes(interdit), `le service ne doit pas contenir « ${interdit} »`);
  }
  assert.ok(SERVICE.includes('transparencyreport.google.com'), 'une seule source, et elle est nommée');
});

test('réputation : l’adresse non documentée est signalée comme telle dans le code', () => {
  // Celui qui reprendra ce fichier doit savoir sur quoi il s'appuie, et pourquoi tout ce
  // qui n'est pas lisible devient « non vérifié ».
  assert.ok(/GOOGLE NE DOCUMENTE PAS/.test(SERVICE), 'la fragilité de la source est écrite noir sur blanc');
  assert.ok(/JAMAIS « sain »/.test(SERVICE));
});
