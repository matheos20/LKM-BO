import { Router } from 'express';
import { requirePermission, visibleServers } from '../middleware/index.js';

/**
 * Recherche globale, montée sous /api/search
 *
 *  POST /  { q }   où se trouve ce domaine, ou à quoi correspond cette adresse ?
 *
 * Lecture seule, et volontairement en POST : l'agent colle des adresses complètes,
 * parfois longues, qui n'ont rien à faire dans un journal d'accès ni dans l'historique
 * du navigateur.
 *
 * La recherche ne lance aucune commande SSH pour les domaines : elle parcourt les
 * listes déjà en cache. Elle n'ouvre le site que si l'adresse portait un chemin, pour
 * y retrouver l'article.
 */
export function searchRouter({ ssh, search }) {
  const r = Router();

  r.post('/', requirePermission('domains.read'), async (req, res) => {
    const visibles = visibleServers(req.user, ssh.list());
    res.json(await search.find(req.body?.q, visibles));
  });

  return r;
}
