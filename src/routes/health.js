import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prepare } from '../db/mysql.js';

/**
 * État de santé de l'application, monté sur /api/health.
 *
 * SANS AUTHENTIFICATION, et c'est voulu : ce qui surveille une application ne peut pas
 * se connecter avec un compte. La contrepartie est qu'on ne dit RIEN d'utile à un
 * curieux — pas de version, pas de nom de serveur, pas d'adresse. Des compteurs et un
 * verdict, rien de plus.
 *
 * LE VERDICT NE PORTE QUE SUR CE QUI EMPÊCHE DE TRAVAILLER. MySQL en panne, et plus rien
 * ne fonctionne : c'est « en panne ». Un VPS non connecté, en revanche, est l'état
 * NORMAL au démarrage — les sessions SSH s'ouvrent à la demande de l'agent. Les compter
 * comme un problème ferait sonner l'alarme tous les matins, et on finirait par ne plus
 * la regarder.
 *
 * Le code HTTP porte le verdict : 200 si tout va, 503 sinon. Un surveillant n'a donc pas
 * besoin de lire la réponse pour décider.
 */

/** Au-delà, on considère que la base ne répond pas : mieux vaut un échec qu'une attente. */
const DELAI_BASE_MS = 3000;

/**
 * Interroge la base avec une limite de temps.
 *
 * Une base ARRÊTÉE refuse la connexion tout de suite ; une base SURCHARGÉE, elle, peut
 * ne jamais répondre. Sans cette limite, l'appel resterait suspendu, le surveillant
 * attendrait avec lui, et la panne la plus sournoise serait la seule à ne pas se voir.
 */
async function pingBase(delai = DELAI_BASE_MS) {
  const t0 = Date.now();
  let minuteur;
  try {
    await Promise.race([
      prepare('SELECT 1 AS ok').get(),
      new Promise((_, rejeter) => { minuteur = setTimeout(() => rejeter(new Error(`pas de réponse en ${delai} ms`)), delai); }),
    ]);
    return { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: String(err.message).slice(0, 120) };
  } finally {
    clearTimeout(minuteur);
  }
}

/**
 * Compte les sessions SSH par état, SANS EN OUVRIR AUCUNE.
 *
 * `ssh.status(id)` crée l'objet de connexion s'il n'existe pas encore : l'appeler ici
 * ferait naître cinq connexions à chaque passage du surveillant. On lit donc la table
 * telle quelle, et un serveur jamais touché compte pour « déconnecté ».
 */
function etatDesServeurs(ssh) {
  const etats = { connected: 0, connecting: 0, error: 0, disconnected: 0 };
  let total = 0;
  for (const serveur of ssh.list()) {
    total += 1;
    const etat = ssh.peek(serveur.id) ?? 'disconnected';
    if (etats[etat] === undefined) etats.disconnected += 1;
    else etats[etat] += 1;
  }
  return { configured: total, ...etats };
}

/**
 * Compose le bilan.
 *
 * Séparé de la route pour être vérifiable sans serveur : c'est ici que vit la règle de
 * décision, et c'est elle qu'on veut contrôler.
 */
export async function buildHealth({ ssh, startedAt, ping = pingBase } = {}) {
  const base = await ping();
  const serveurs = ssh ? etatDesServeurs(ssh) : null;
  return {
    status: base.ok ? 'ok' : 'down',
    // Arrondi à la seconde : une mesure au millième ne dit rien de plus et change à
    // chaque appel, ce qui rend deux relevés impossibles à comparer d'un coup d'œil.
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    checks: {
      database: base,
      // Informatif : une session fermée n'est pas une panne, elle s'ouvre à la demande.
      servers: serveurs,
    },
  };
}

export function healthRouter({ ssh, startedAt = Date.now() } = {}) {
  const r = Router();

  /**
   * Une limite large, mais une limite.
   *
   * Chaque appel interroge la base. Ouverte sans compte, cette route serait sinon le
   * seul endroit où un inconnu peut faire travailler MySQL autant qu'il veut. Deux
   * relevés par seconde laissent toute la place à un surveillant — le nôtre en fait un
   * toutes les trente secondes.
   */
  r.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));

  r.get('/', async (_req, res) => {
    const bilan = await buildHealth({ ssh, startedAt });
    // Jamais de cache : un relevé de santé gardé en mémoire par un intermédiaire
    // annoncerait « tout va bien » longtemps après la panne.
    res.setHeader('Cache-Control', 'no-store');
    res.status(bilan.status === 'ok' ? 200 : 503).json(bilan);
  });
  return r;
}
