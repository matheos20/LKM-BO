#!/usr/bin/env node
/**
 * Surveillant du back-office : il lance le serveur, et le relance.
 *
 *   npm run serve           lance le serveur sous surveillance
 *   npm run serve -- --once lance une seule fois, sans relance (pour comprendre une panne)
 *
 * POURQUOI UN SURVEILLANT. `npm start` lance UN processus. S'il s'arrête — une erreur
 * jamais prévue, la machine qui redémarre, MySQL qui n'est pas encore là — le
 * back-office est mort jusqu'à ce que quelqu'un s'en aperçoive. Cinq agents en
 * dépendent chaque jour.
 *
 * DEUX PANNES, PAS UNE. Un processus qui s'arrête se voit tout seul : le système nous
 * prévient. Un processus qui reste là sans plus rien servir — base perdue, boucle
 * bloquée — ne se voit pas : du dehors, il tourne. Le surveillant interroge donc
 * `/api/health` régulièrement, et relance aussi dans ce cas-là.
 *
 * L'ATTENTE DOUBLE À CHAQUE ÉCHEC. Si le serveur ne peut pas démarrer — MySQL arrêté,
 * fichier de configuration absent — relancer dix fois par seconde ne le fera pas
 * démarrer : cela remplira le disque de journaux et masquera la cause. On attend donc
 * une seconde, puis deux, quatre… jusqu'à une minute. Et dès que le serveur tient
 * debout un moment, le compteur repart de zéro : une panne passagère ne doit pas
 * laisser le prochain démarrage attendre une minute.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const options = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => [a.slice(2).split('=')[0], a.includes('=') ? a.split('=')[1] : true]),
);

const PORT = Number(process.env.PORT) || 3000;
const HOTE = process.env.HOST || '127.0.0.1';
const JOURNAL = path.join(RACINE, 'logs', 'supervisor.log');
/**
 * L'adresse interrogee pour le releve de sante.
 *
 * Deduite du port par defaut. SUPERVISOR_HEALTH_URL permet de la designer autrement :
 * quand le serveur est derriere un relais, ou qu'il n'ecoute pas sur l'adresse ou on
 * l'interroge. C'est aussi par la qu'on eprouve le surveillant, en le faisant interroger
 * une adresse morte pendant que le serveur, lui, se porte bien.
 */
const URL_SANTE = process.env.SUPERVISOR_HEALTH_URL || `http://${HOTE}:${PORT}/api/health`;

/** Combien de temps attendre avant la énième relance, en millisecondes. */
export function attente(echecs) {
  const n = Math.max(0, Number(echecs) || 0);
  if (n === 0) return 0; // la première relance est immédiate : une panne isolée arrive
  return Math.min(60_000, 1000 * 2 ** (n - 1));
}

/** Au-delà, on considère que le serveur « tient debout » et on oublie les échecs passés. */
const STABLE_MS = 60_000;
/** Intervalle entre deux relevés de santé. */
const SANTE_MS = Number(process.env.SUPERVISOR_HEALTH_MS) || 30_000;
/** Nombre de relevés manqués d'affilée avant de conclure que le serveur est bloqué. */
const SANTE_ECHECS = Number(process.env.SUPERVISOR_HEALTH_FAILS) || 3;
/** Un relevé qui n'aboutit pas dans ce délai compte comme manqué. */
const SANTE_DELAI_MS = 5000;

// ───────────────────────────── Journal ─────────────────────────────

/**
 * Écrit dans la console ET dans un fichier.
 *
 * Lancé par le système au démarrage de la machine, le surveillant n'a pas de console :
 * sans fichier, on ne saurait jamais pourquoi il a relancé, ni combien de fois.
 */
function dire(texte) {
  const ligne = `${new Date().toISOString()}  ${texte}`;
  console.log(ligne);
  try {
    fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
    // Un journal de surveillance qui remplit le disque ferait tomber ce qu'il surveille.
    if (fs.existsSync(JOURNAL) && fs.statSync(JOURNAL).size > 5 * 1024 * 1024) {
      fs.renameSync(JOURNAL, `${JOURNAL}.1`);
    }
    fs.appendFileSync(JOURNAL, `${ligne}\n`);
  } catch {
    // Ne jamais faire tomber le surveillant pour un problème d'écriture de journal.
  }
}

// ───────────────────────────── Santé ─────────────────────────────

async function sante() {
  const stop = AbortSignal.timeout(SANTE_DELAI_MS);
  try {
    const r = await fetch(URL_SANTE, { signal: stop });
    const corps = await r.json().catch(() => ({}));
    return { ok: r.status === 200, status: r.status, detail: corps?.checks?.database?.error ?? null };
  } catch (err) {
    return { ok: false, status: 0, detail: String(err.message).slice(0, 80) };
  }
}

// ───────────────────────────── Boucle ─────────────────────────────

const etat = { enfant: null, echecs: 0, arret: false, relances: 0, manques: 0, veille: null, tueParNous: false };

function lancer() {
  const demarre = Date.now();
  etat.manques = 0;
  etat.tueParNous = false;
  const enfant = spawn(process.execPath, [path.join(RACINE, 'src', 'server.js')], {
    cwd: RACINE,
    env: process.env,
    // Le serveur écrit comme d'habitude : on ne s'interpose pas entre lui et sa console.
    stdio: 'inherit',
  });
  etat.enfant = enfant;

  enfant.on('exit', (code, signal) => {
    etat.enfant = null;
    if (etat.arret) return;

    const vecu = Date.now() - demarre;
    // Un serveur qui a tenu une minute a bel et bien démarré : ce qui l'a arrêté est un
    // incident, pas une impossibilité. Le compteur d'échecs repart de zéro.
    if (vecu >= STABLE_MS) etat.echecs = 0;
    etat.echecs += 1;
    etat.relances += 1;

    const pause = attente(etat.echecs - 1);
    const cause = etat.tueParNous ? 'arrêté par le surveillant' : `arrêté de lui-même (${signal ? `signal ${signal}` : `code ${code}`})`;
    dire(`serveur ${cause} après ${Math.round(vecu / 1000)} s — relance dans ${Math.round(pause / 1000)} s (échec ${etat.echecs})`);
    // L'indice ne vaut QUE pour un serveur qui n'arrive pas à démarrer. Le donner après
    // une relance décidée par le relevé de santé enverrait chercher la panne au mauvais
    // endroit : là, le serveur a bel et bien démarré — c'est la sonde qui ne le joint pas.
    if (etat.echecs === 3 && !etat.tueParNous && vecu < 10_000) {
      dire('  ⚠ le serveur ne parvient pas à démarrer. MySQL est-il lancé ? le fichier .env est-il complet ?');
    }
    if (etat.echecs === 3 && etat.tueParNous) {
      dire(`  ⚠ le serveur démarre mais ne répond pas sur ${URL_SANTE}. L'adresse interrogée est-elle la bonne ?`);
    }
    // Ce minuteur n'est PAS « unref » : il doit tenir le surveillant en vie pendant
    // l'attente, sinon le processus se terminerait avant d'avoir relancé quoi que ce soit.
    setTimeout(lancer, pause);
  });

  enfant.on('error', (err) => dire(`impossible de lancer le serveur : ${err.message}`));
}

/** Relance le serveur parce qu'il ne répond plus, en le laissant d'abord se fermer. */
function relancerBloque(motif) {
  dire(`serveur sans réponse (${motif}) — relance`);
  const enfant = etat.enfant;
  if (!enfant) return;
  etat.tueParNous = true;
  enfant.kill('SIGTERM');
  // S'il ne se ferme pas de lui-même, on n'attend pas indéfiniment : l'objet de
  // l'opération est justement qu'il ne répond plus.
  setTimeout(() => { if (etat.enfant === enfant) enfant.kill('SIGKILL'); }, 8000).unref();
}

async function veiller() {
  if (etat.arret || !etat.enfant) return;
  const r = await sante();
  if (r.ok) {
    if (etat.manques) dire(`santé revenue après ${etat.manques} relevé(s) manqué(s)`);
    etat.manques = 0;
    return;
  }
  etat.manques += 1;
  dire(`relevé de santé manqué (${etat.manques}/${SANTE_ECHECS}) : HTTP ${r.status}${r.detail ? ` — ${r.detail}` : ''}`);
  if (etat.manques >= SANTE_ECHECS) {
    etat.manques = 0;
    relancerBloque(`${SANTE_ECHECS} relevés manqués`);
  }
}

function arreter(signal) {
  if (etat.arret) return;
  etat.arret = true;
  dire(`arrêt demandé (${signal}) — fermeture du serveur`);
  // Le relevé de santé s'arrête d'abord : sans cela, son minuteur tiendrait le
  // surveillant en vie et « Ctrl-C » ne rendrait jamais la main.
  clearInterval(etat.veille);
  const enfant = etat.enfant;
  if (!enfant) return process.exit(0);
  enfant.on('exit', () => process.exit(0));
  enfant.kill('SIGTERM');
  // Le serveur ferme ses sessions SSH avant de partir : on lui laisse le temps, mais
  // pas indéfiniment.
  setTimeout(() => {
    enfant.kill('SIGKILL');
    process.exit(0);
  }, 8000);
  return undefined;
}

// Lancé directement, pas importé par un contrôle.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (options.once) {
    dire('lancement unique (--once) : aucune relance');
    spawn(process.execPath, [path.join(RACINE, 'src', 'server.js')], { cwd: RACINE, env: process.env, stdio: 'inherit' })
      .on('exit', (code) => process.exit(code ?? 0));
  } else {
    dire(`surveillance démarrée — ${URL_SANTE}  (relevé toutes les ${SANTE_MS / 1000} s, relance après ${SANTE_ECHECS} manqués)`);
    lancer();
    etat.veille = setInterval(veiller, SANTE_MS);
    for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => arreter(s));
  }
}
