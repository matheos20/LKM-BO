import fs from 'node:fs';
import path from 'node:path';
import { recordEvent } from '../db/audit.js';

/**
 * Journal d'audit : qui a fait quoi, sur quel serveur, avec quel résultat.
 *
 * Deux destinations, volontairement :
 *
 *   - le FICHIER en JSON Lines, ajouté ligne à ligne, qui survit à une remise à zéro
 *     de la base et se lit avec n'importe quel outil ;
 *   - la BASE, seule forme qu'on puisse filtrer, chercher et paginer — c'est elle que
 *     lit l'écran « Journal ».
 *
 * L'auteur est lu dans `req.user`, que le middleware d'authentification charge depuis
 * la base à chaque requête. Il l'était auparavant dans `req.session.user`, qui n'existe
 * pas : la session ne garde qu'un `userId`. 446 des 703 premières lignes du journal
 * sont ainsi anonymes — un journal d'audit sans auteur ne répond pas à la question
 * qu'on lui pose.
 */
export function createAudit(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return (req, entry) => {
    const u = req.user ?? null;
    // Une entrée peut nommer son auteur elle-même : la connexion journalise un
    // utilisateur que la requête ne porte pas encore.
    const nom = entry.user ?? u?.username ?? null;

    const ligne = {
      ts: new Date().toISOString(),
      user: nom,
      ip: req.ip,
      ...entry,
    };
    fs.appendFile(file, `${JSON.stringify(ligne)}\n`, (err) => err && console.error(`[audit] ${err.message}`));

    recordEvent({
      at: Date.now(),
      userId: u?.id ?? null,
      username: nom ?? '',
      displayName: u?.displayName ?? '',
      role: u?.role?.name ?? entry.role ?? '',
      action: entry.action,
      server: entry.server ?? null,
      domain: entry.domain ?? null,
      target: entry.target ?? null,
      ok: entry.ok,
      error: entry.error ?? null,
      ip: req.ip,
    });
  };
}
