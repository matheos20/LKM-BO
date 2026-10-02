import { TERMINES, advanceJob, finishJob, getJob, jobTargets, markRunning, nextJob, nextSeq, purgeJobs, saveResult, tallyJob } from '../db/jobs.js';

/**
 * Le moteur des tournées.
 *
 * Il prend la tournée suivante, la découpe en lots, et après CHAQUE lot inscrit où il en
 * est. C'est tout — mais c'est cette inscription qui change tout : l'agent peut fermer
 * son navigateur, se déconnecter, revenir le lendemain ; le serveur peut redémarrer au
 * milieu. On reprend à la position écrite, jamais au début.
 *
 * UNE SEULE TOURNÉE À LA FOIS. Deux balayages du parc en parallèle doubleraient la
 * charge SSH sur les mêmes machines, et les deux iraient deux fois moins vite. Les
 * autres attendent leur tour, et l'écran le dit.
 *
 * UN SERVEUR QUI TOMBE N'EMPORTE PAS LES AUTRES. Une session SSH peut lâcher au milieu
 * d'une tournée de dix minutes : le lot est compté en échec, le serveur en cause est
 * abandonné, et la tournée continue sur les machines suivantes. Perdre un cinquième du
 * parc vaut mieux que tout perdre.
 */

/** Entre deux examens de la file, quand il n'y a rien à faire. */
const REPOS_MS = 3000;
/** Au-delà de ce silence, une tournée « en cours » a été interrompue : on la reprend. */
const BATTEMENT_MORT_MS = 90_000;

/** Les cibles regroupées par serveur, en gardant l'ordre d'origine. */
function parServeur(cibles) {
  const groupes = new Map();
  for (const c of cibles) {
    const cle = c.server ?? '';
    if (!groupes.has(cle)) groupes.set(cle, []);
    groupes.get(cle).push(c.domain);
  }
  return groupes;
}

/**
 * Découpe les cibles en lots, dans un ordre STABLE.
 *
 * La stabilité est ce qui rend la reprise possible : au redémarrage, on refait le même
 * découpage et on saute les `done` premiers lots. Un ordre qui changerait d'une fois sur
 * l'autre ferait retraiter certains sites et en oublier d'autres.
 */
export function decouper(cibles, { batch = 100, perServer = true } = {}) {
  const lots = [];
  if (!perServer) {
    for (let i = 0; i < cibles.length; i += batch) {
      lots.push({ server: null, domains: cibles.slice(i, i + batch).map((c) => c.domain) });
    }
    return lots;
  }
  for (const [server, domains] of parServeur(cibles)) {
    for (let i = 0; i < domains.length; i += batch) lots.push({ server, domains: domains.slice(i, i + batch) });
  }
  return lots;
}

export function startJobRunner({ kinds, log = console, audit = null, retentionDays = 30 }) {
  const etat = { actif: true, enCours: null, minuteur: null, annulations: new Set() };

  /** Journalise au nom de l'agent qui a lancé la tournée : c'est lui, l'auteur. */
  const journal = (job, entree) => {
    if (!audit) return;
    audit({ ip: null, user: null }, { user: job.by?.name || 'système', ...entree });
  };

  async function mener(job) {
    const kind = kinds[job.kind];
    if (!kind) {
      await finishJob(job.id, 'failed', `traitement inconnu : ${job.kind}`);
      log.error(`[tournée] #${job.id} traitement inconnu : ${job.kind}`);
      return;
    }

    const cibles = await jobTargets(job.id);
    const lots = decouper(cibles, { batch: kind.batch, perServer: kind.perServer });
    // LE POINT DE REPRISE vient de ce qui est ecrit, pas d'un compteur : les lots deja
    // enregistres sont sautes, et aucun site n'est traite deux fois.
    const depart = await nextSeq(job.id);
    await markRunning(job.id);
    if (depart === 0) log.log(`[tournée] #${job.id} ${job.kind} — ${cibles.length} cible(s), ${lots.length} lot(s)`);
    else log.log(`[tournée] #${job.id} ${job.kind} — REPRISE au lot ${depart + 1}/${lots.length}`);

    const serveursPerdus = new Set();
    let faites = lots.slice(0, depart).reduce((n, l) => n + l.domains.length, 0);

    for (const [i, lot] of lots.entries()) {
      // Reprise : les lots déjà enregistrés sont sautés, pas refaits.
      if (i < depart) continue;
      if (!etat.actif) return; // arrêt du serveur : la tournée reprendra au redémarrage
      if (etat.annulations.has(job.id)) {
        etat.annulations.delete(job.id);
        const compte = await tallyJob(job.id);
        await finishJob(job.id, 'cancelled');
        log.log(`[tournée] #${job.id} annulée au lot ${i}/${lots.length}`);
        journal(job, { action: 'job.cancel', target: `${job.label} · ${compte.ok}/${job.total}`, ok: true });
        return;
      }

      // Un serveur dont la session est tombée : on ne s'acharne pas sur ses lots
      // suivants. Mais on l'ÉCRIT quand même — un lot sans trace serait un trou dans le
      // relevé, et l'agent ne saurait pas que ces domaines n'ont pas été vus.
      if (lot.server && serveursPerdus.has(lot.server)) {
        await saveResult(job.id, i, {
          server: lot.server,
          count: lot.domains.length,
          ok: false,
          payload: { error: 'errors.job_server_lost', domains: lot.domains },
        });
        faites += lot.domains.length;
        await advanceJob(job.id, faites);
        continue;
      }

      try {
        const sortie = await kind.run({ serverId: lot.server, domains: lot.domains, params: job.params, job });
        await saveResult(job.id, i, { server: lot.server, count: lot.domains.length, ok: true, payload: sortie });
      } catch (err) {
        if (lot.server) serveursPerdus.add(lot.server);
        // L'échec est ENREGISTRÉ comme un résultat : l'écran doit pouvoir dire à l'agent
        // ce qui n'a pas marché, et sur quelle machine. Un trou silencieux serait pire.
        await saveResult(job.id, i, {
          server: lot.server,
          count: lot.domains.length,
          ok: false,
          payload: { error: String(err.key ?? err.message).slice(0, 300), domains: lot.domains },
        });
        log.error(`[tournée] #${job.id} lot ${i} (${lot.server ?? 'sans serveur'}) : ${err.message}`);
      }
      faites += lot.domains.length;
      await advanceJob(job.id, faites);
    }

    // LES TOTAUX SE CALCULENT SUR CE QUI EST ÉCRIT. Un compteur tenu en mémoire ne
    // verrait que les lots traités par CE processus : après une reprise, il annoncerait
    // vingt cibles là où la tournée en a traité soixante.
    const compte = await tallyJob(job.id);
    const fini = await finishJob(job.id, 'done');
    log.log(`[tournée] #${job.id} terminée — ${compte.ok} cible(s) traitée(s), ${compte.failed} en échec`);
    journal(job, {
      action: 'job.finish',
      target: `${job.label} · ${compte.ok}/${job.total}${compte.failed ? ` · ${compte.failed} en échec` : ''}`,
      ok: compte.failed === 0,
      error: compte.failed ? `${serveursPerdus.size} serveur(s) perdu(s) en route` : null,
    });
    return fini;
  }

  async function tour() {
    if (!etat.actif || etat.enCours) return;
    try {
      const job = await nextJob();
      if (!job) return;
      // Une tournée « en cours » sans battement récent a été interrompue par un
      // redémarrage. Sans ce délai, deux processus pourraient la mener en même temps.
      if (job.status === 'running' && job.heartbeatAt && Date.now() - job.heartbeatAt < BATTEMENT_MORT_MS) return;
      etat.enCours = job.id;
      await mener(job);
    } catch (err) {
      log.error(`[tournée] ${err.message}`);
      if (etat.enCours) await finishJob(etat.enCours, 'failed', err.message).catch(() => {});
    } finally {
      etat.enCours = null;
    }
  }

  const boucle = setInterval(() => { tour().catch(() => {}); }, REPOS_MS);
  boucle.unref();

  // Le ménage : les tournées terminées depuis longtemps partent avec leurs résultats,
  // qui pèsent des dizaines de mégaoctets pour un balayage du parc entier.
  purgeJobs(retentionDays)
    .then((n) => n && log.log(`[tournée] ${n} tournée(s) de plus de ${retentionDays} jours effacée(s)`))
    .catch(() => {});

  return {
    /** Demande l'arrêt d'une tournée : il sera pris en compte entre deux lots. */
    cancel(id) { etat.annulations.add(Number(id)); },
    /** La tournée que ce serveur mène en ce moment, s'il y en a une. */
    current: () => etat.enCours,
    /** Pour les contrôles : fait un tour tout de suite, sans attendre le minuteur. */
    tick: tour,
    stop() {
      etat.actif = false;
      clearInterval(boucle);
    },
  };
}

/** Une tournée interrompue par un redémarrage, remise en attente au prochain tour. */
export const estInterrompue = (job, maintenant = Date.now()) =>
  job?.status === 'running' && (!job.heartbeatAt || maintenant - job.heartbeatAt >= BATTEMENT_MORT_MS);

export { TERMINES, getJob };
