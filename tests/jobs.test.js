import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  advanceJob, cancelJob, createJob, finishJob, getJob, jobResults, jobTargets,
  listJobs, markRunning, nextJob, nextSeq, purgeJobs, saveResult, tallyJob,
} from '../src/db/jobs.js';
import { decouper, estInterrompue, startJobRunner } from '../src/services/jobRunner.js';
import { prepare } from '../src/db/mysql.js';
import { creerBaseJetable } from './mysqlTestDb.js';

/**
 * Les tournées : un traitement de masse confié au serveur.
 *
 * La boucle vivait dans l'onglet du navigateur. Fermer l'onglet arrêtait une tournée de
 * 7 733 sites en plein milieu, et rien ne disait où elle en était. Ce qui est vérifié
 * ici, c'est ce qui rend la reprise possible : un découpage STABLE, et un point de
 * reprise lu dans ce qui est ÉCRIT plutôt que dans un compteur.
 */
const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = creerBaseJetable('jobs');
before(() => base.ouvrir({ seedRoles: false }));
after(() => base.fermer());

const muet = { log: () => {}, error: () => {} };
const dodo = (ms) => new Promise((r) => setTimeout(r, ms));

/** Des cibles réparties sur plusieurs serveurs. */
const cibles = (n, serveurs = ['vps-001', 'vps-002', 'vps-003']) =>
  Array.from({ length: n }, (_, i) => ({ server: serveurs[i % serveurs.length], domain: `d${i}.com` }));

async function surTableVide(fn) {
  await base.vider('job_results', 'jobs');
  return fn();
}

// ───────── Le découpage ─────────

test('tournée : un lot ne mélange jamais deux serveurs', () => {
  // Chaque appel s'adresse à UNE session SSH : un lot à cheval sur deux machines n'aurait
  // aucun sens, et une machine tombée emporterait le travail de l'autre.
  const lots = decouper(cibles(250), { batch: 100, perServer: true });
  assert.ok(lots.every((l) => l.domains.length <= 100));
  assert.equal(new Set(lots.map((l) => l.server)).size, 3);
  assert.equal(lots.reduce((n, l) => n + l.domains.length, 0), 250, 'aucune cible perdue');
});

test('tournée : le découpage est STABLE — c’est ce qui rend la reprise possible', () => {
  // Au redémarrage, on refait le même découpage et on saute les lots déjà écrits. Un
  // ordre qui changerait d'une fois sur l'autre retraiterait des sites et en oublierait.
  const a = decouper(cibles(250), { batch: 100, perServer: true });
  const b = decouper(cibles(250), { batch: 100, perServer: true });
  assert.deepEqual(a, b);
});

test('tournée : sans serveur, les lots sont simplement découpés', () => {
  // Cloudflare ne passe par aucune machine du parc : il n'y a rien à regrouper.
  const lots = decouper(cibles(450, ['']), { batch: 200, perServer: false });
  assert.equal(lots.length, 3);
  assert.deepEqual(lots.map((l) => l.domains.length), [200, 200, 50]);
  assert.ok(lots.every((l) => l.server === null));
});

test('tournée : une liste vide ne produit aucun lot', () => {
  assert.deepEqual(decouper([], { batch: 100 }), []);
  assert.deepEqual(decouper([], { batch: 100, perServer: false }), []);
});

// ───────── Ce qui est écrit ─────────

test('tournée : la liste des cibles est FIGÉE au départ', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    // Une tournée d'une heure ne doit pas dépendre de ce que l'écran avait en tête au
    // moment du clic : la sélection peut changer, la tournée non.
    const job = await createJob({ kind: 'essai', label: 'figée', targets: cibles(30), userName: 'Anna' });
    assert.equal(job.total, 30);
    assert.equal(job.status, 'pending');
    assert.equal(job.by.name, 'Anna', 'le nom de l’auteur est RECOPIÉ : la tournée lui survit');
    assert.equal((await jobTargets(job.id)).length, 30);
  });
});

test('tournée : le point de reprise se lit dans ce qui est ÉCRIT', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    const job = await createJob({ kind: 'essai', targets: cibles(30) });
    assert.equal(await nextSeq(job.id), 0, 'rien d’écrit : on repart de zéro');

    await saveResult(job.id, 0, { server: 'vps-001', count: 10, ok: true, payload: { sites: [] } });
    await saveResult(job.id, 1, { server: 'vps-001', count: 10, ok: true, payload: { sites: [] } });
    assert.equal(await nextSeq(job.id), 2, 'deux lots écrits : on reprend au troisième');

    // Un compteur séparé pourrait mentir après un arrêt brutal ; la table ne contient
    // que ce qui a vraiment abouti.
    await advanceJob(job.id, 999);
    assert.equal(await nextSeq(job.id), 2, 'le compteur de progression ne décide de rien');
  });
});

test('tournée : les totaux s’additionnent depuis les lots, pas depuis la mémoire', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    // C'est la seule façon d'avoir juste après une reprise : le processus qui termine
    // n'a pas vu les lots traités par celui qui avait commencé.
    const job = await createJob({ kind: 'essai', targets: cibles(30) });
    await saveResult(job.id, 0, { count: 10, ok: true, payload: {} });
    await saveResult(job.id, 1, { count: 10, ok: false, payload: { error: 'session perdue' } });
    await saveResult(job.id, 2, { count: 10, ok: true, payload: {} });

    assert.deepEqual(await tallyJob(job.id), { ok: 20, failed: 10 });
    const relu = await getJob(job.id);
    assert.equal(relu.ok, 20);
    assert.equal(relu.failed, 10);
  });
});

test('tournée : rejouer un lot le remplace, il ne se double pas', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    const job = await createJob({ kind: 'essai', targets: cibles(10) });
    await saveResult(job.id, 0, { count: 10, ok: false, payload: { error: 'raté' } });
    await saveResult(job.id, 0, { count: 10, ok: true, payload: { sites: ['a'] } });
    const lots = await jobResults(job.id);
    assert.equal(lots.length, 1, 'un seul lot numéro zéro');
    assert.equal(lots[0].ok, true);
    assert.deepEqual(await tallyJob(job.id), { ok: 10, failed: 0 });
  });
});

test('tournée : on ne redemande que la suite', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    // L'écran qui suit une tournée absorbe les lots au fur et à mesure : relire les
    // précédents à chaque passage ferait transiter des mégaoctets pour rien.
    const job = await createJob({ kind: 'essai', targets: cibles(30) });
    for (let i = 0; i < 3; i += 1) await saveResult(job.id, i, { count: 10, ok: true, payload: { n: i } });

    assert.deepEqual((await jobResults(job.id)).map((l) => l.seq), [0, 1, 2]);
    assert.deepEqual((await jobResults(job.id, { afterSeq: 0 })).map((l) => l.seq), [1, 2]);
    assert.deepEqual((await jobResults(job.id, { afterSeq: 2 })).map((l) => l.seq), []);
    assert.deepEqual((await jobResults(job.id, { afterSeq: -1, limit: 2 })).map((l) => l.seq), [0, 1]);
  });
});

// ───────── Le moteur ─────────

test('tournée : menée jusqu’au bout, lot par lot', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    const vus = [];
    const moteur = startJobRunner({
      kinds: { essai: { batch: 10, perServer: true, run: ({ domains }) => { vus.push(domains.length); return { n: domains.length }; } } },
      log: muet,
      retentionDays: 0,
    });
    const job = await createJob({ kind: 'essai', targets: cibles(60) });
    await moteur.tick();
    moteur.stop();

    const fini = await getJob(job.id);
    assert.equal(fini.status, 'done');
    assert.equal(fini.ok, 60);
    assert.equal(fini.done, 60, 'la progression compte des CIBLES, comme le total');
    assert.deepEqual(vus, [10, 10, 10, 10, 10, 10]);
  });
});

test('tournée : reprise — seuls les lots qui manquent sont refaits', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    const job = await createJob({ kind: 'essai', targets: cibles(60) });
    // Quatre lots avaient abouti avant l'arrêt ; le serveur redémarre.
    for (let i = 0; i < 4; i += 1) await saveResult(job.id, i, { count: 10, ok: true, payload: { n: i } });
    await markRunning(job.id);
    await prepare('UPDATE jobs SET heartbeat_at = ? WHERE id = ?').run(Date.now() - 300_000, job.id);
    assert.equal(estInterrompue(await getJob(job.id)), true, 'sans battement récent, la tournée est reconnue interrompue');

    const vus = [];
    const moteur = startJobRunner({
      kinds: { essai: { batch: 10, perServer: true, run: ({ domains }) => { vus.push(domains.length); return {}; } } },
      log: muet,
      retentionDays: 0,
    });
    await moteur.tick();
    moteur.stop();

    assert.equal(vus.length, 2, 'les quatre premiers lots ne sont PAS refaits');
    const fini = await getJob(job.id);
    assert.equal(fini.status, 'done');
    assert.equal(fini.ok, 60, 'et le total porte sur les six lots, pas sur les deux refaits');
  });
});

test('tournée : une tournée vivante n’est pas reprise par quelqu’un d’autre', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    // Sans ce délai, deux processus pourraient mener la même tournée en même temps.
    const job = await createJob({ kind: 'essai', targets: cibles(10) });
    await markRunning(job.id);
    const vivante = await getJob(job.id);
    assert.equal(estInterrompue(vivante), false, 'elle vient de donner signe de vie');

    let touche = false;
    const moteur = startJobRunner({ kinds: { essai: { batch: 10, run: () => { touche = true; return {}; } } }, log: muet, retentionDays: 0 });
    await moteur.tick();
    moteur.stop();
    assert.equal(touche, false, 'le moteur la laisse tranquille');
  });
});

test('tournée : un serveur qui tombe n’emporte pas les autres', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    // Une session SSH peut lâcher au milieu d'une tournée de dix minutes. Perdre un
    // cinquième du parc vaut mieux que tout perdre.
    const moteur = startJobRunner({
      kinds: {
        essai: {
          batch: 10,
          perServer: true,
          run: ({ serverId, domains }) => {
            if (serverId === 'vps-002') throw new Error('session SSH perdue');
            return { n: domains.length };
          },
        },
      },
      log: muet,
      retentionDays: 0,
    });
    const job = await createJob({ kind: 'essai', targets: cibles(60) });
    await moteur.tick();
    moteur.stop();

    const fini = await getJob(job.id);
    assert.equal(fini.status, 'done', 'la tournée va à son terme');
    assert.equal(fini.ok, 40, 'les deux autres machines ont été traitées');
    assert.equal(fini.failed, 20, 'ni plus, ni comptées deux fois');

    // Les lots perdus sont ÉCRITS : un trou silencieux serait pire que l'échec, parce
    // que l'agent ne saurait pas quels sites n'ont pas été vus.
    const perdus = (await jobResults(job.id, { limit: 100 })).filter((l) => !l.ok);
    assert.equal(perdus.length, 2);
    assert.ok(perdus.every((l) => l.server === 'vps-002'));
    assert.ok(perdus.every((l) => l.payload.domains.length === 10), 'avec la liste des domaines non traités');
  });
});

test('tournée : un traitement inconnu échoue proprement', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    const moteur = startJobRunner({ kinds: {}, log: muet, retentionDays: 0 });
    const job = await createJob({ kind: 'disparu', targets: cibles(10) });
    await moteur.tick();
    moteur.stop();
    const fini = await getJob(job.id);
    assert.equal(fini.status, 'failed');
    assert.match(fini.error, /disparu/);
  });
});

test('tournée : on peut l’arrêter, et elle s’arrête ENTRE deux lots', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    // Interrompre un lot en plein travail laisserait des sites à moitié traités.
    const moteur = startJobRunner({
      kinds: { essai: { batch: 10, perServer: true, run: async () => { await dodo(80); return {}; } } },
      log: muet,
      retentionDays: 0,
    });
    const job = await createJob({ kind: 'essai', targets: cibles(300) });
    const course = moteur.tick();
    await dodo(200);
    moteur.cancel(job.id);
    await course;
    moteur.stop();

    const fini = await getJob(job.id);
    assert.equal(fini.status, 'cancelled');
    assert.ok(fini.done > 0 && fini.done < 300, `arrêtée en route : ${fini.done}/300`);
    assert.equal(fini.ok % 10, 0, 'sur une frontière de lot, jamais au milieu');
  });
});

test('tournée : une tournée en attente s’annule sans avoir commencé', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    const job = await createJob({ kind: 'essai', targets: cibles(10) });
    const out = await cancelJob(job.id);
    assert.equal(out.status, 'cancelled');
    // Annuler deux fois ne change rien : une tournée terminée ne repart pas.
    await finishJob(job.id, 'done');
    const deja = await getJob(job.id);
    assert.equal((await cancelJob(job.id)).status, deja.status);
  });
});

// ───────── La file et l'historique ─────────

test('tournée : ce qui a commencé passe avant ce qui attend', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    // Après un redémarrage, on termine le chantier ouvert plutôt que d'en ouvrir un autre.
    const enAttente = await createJob({ kind: 'essai', label: 'attend', targets: cibles(10) });
    const commencee = await createJob({ kind: 'essai', label: 'commencée', targets: cibles(10) });
    await markRunning(commencee.id);
    const suivante = await nextJob();
    assert.equal(suivante.id, commencee.id);
    void enAttente;
  });
});

test('tournée : l’historique dit qui, quoi, combien', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    const a = await createJob({ kind: 'translate.scan', label: 'analyse', targets: cibles(10), userId: null, userName: 'Anna' });
    const b = await createJob({ kind: 'categories.plan', label: 'rubriques', targets: cibles(20), userName: 'Bruno' });
    await finishJob(a.id, 'done');

    const tout = await listJobs({ limit: 10 });
    assert.equal(tout.length, 2);
    assert.ok(tout[0].id > tout[1].id, 'de la plus récente à la plus ancienne');
    assert.deepEqual((await listJobs({ kind: 'categories.plan' })).map((x) => x.id), [b.id]);
    assert.deepEqual((await listJobs({ status: 'done' })).map((x) => x.id), [a.id]);
    assert.equal((await listJobs({ limit: 1 })).length, 1);
  });
});

test('tournée : le ménage emporte les résultats avec la tournée', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    // Un balayage du parc entier laisse des dizaines de mégaoctets que plus personne ne
    // regardera. La clé étrangère est en cascade : les lots partent avec la ligne.
    const vieille = await createJob({ kind: 'essai', targets: cibles(10) });
    await saveResult(vieille.id, 0, { count: 10, ok: true, payload: { gros: 'x'.repeat(500) } });
    await finishJob(vieille.id, 'done');
    await prepare('UPDATE jobs SET finished_at = ? WHERE id = ?').run(Date.now() - 60 * 86_400_000, vieille.id);

    const recente = await createJob({ kind: 'essai', targets: cibles(10) });
    await finishJob(recente.id, 'done');
    const enCours = await createJob({ kind: 'essai', targets: cibles(10) });

    assert.equal(await purgeJobs(30), 1, 'seule la vieille part');
    assert.equal(await getJob(vieille.id), undefined);
    assert.equal((await jobResults(vieille.id)).length, 0, 'et ses résultats avec elle');
    assert.ok(await getJob(recente.id), 'la récente reste');
    assert.ok(await getJob(enCours.id), 'et celle qui n’est pas finie aussi');

    assert.equal(await purgeJobs(0), 0, 'à 0 jour, rien n’est effacé');
    assert.equal(await purgeJobs(-5), 0);
  });
});

// ───────── Ce que l'écran promet ─────────

test('tournée : l’écran ne boucle plus lui-même sur les domaines', () => {
  // C'ÉTAIT LE PROBLÈME : la boucle vivait dans l'onglet. Ce contrôle échouerait si
  // quelqu'un la remettait, et avec elle la perte d'une tournée à la fermeture.
  const ecran = readFileSync(join(RACINE, 'public/js/actions.js'), 'utf8');
  assert.ok(!/for \(let i = 0; i < domains\.length; i \+= size\)/.test(ecran), 'plus de découpage côté navigateur');
  assert.match(ecran, /api\('\/api\/jobs'/, 'l’écran confie le travail au serveur');
  assert.match(ecran, /async function suivre\(/, 'et se contente de suivre');

  // Chaque traitement sait désormais se faire mener par une tournée.
  for (const fichier of ['translate.js', 'templates.js', 'categories.js', 'redirects.js']) {
    const source = readFileSync(join(RACINE, 'public/js', fichier), 'utf8');
    assert.match(source, /jobKind: '/, `${fichier} doit nommer son traitement`);
    assert.match(source, /absorb\(server, out\)/, `${fichier} doit absorber ce que la tournée rend`);
  }
});

test('tournée : une grande opération Cloudflare ne tient plus dans une requête', () => {
  // Une seule requête pour 37 930 domaines tiendrait une heure et demie : le navigateur,
  // le relais et la patience de l'agent abandonneraient bien avant.
  const ecran = readFileSync(join(RACINE, 'public/js/cloudflare.js'), 'utf8');
  assert.match(ecran, /SEUIL_TOURNEE/, 'un seuil sépare le geste courant du chantier');
  assert.match(ecran, /kind: 'cloudflare\.bulk'/, 'au-delà, l’opération devient une tournée');
});
