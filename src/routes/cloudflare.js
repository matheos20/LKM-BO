import { Router } from 'express';
import { requirePermission } from '../middleware/index.js';

/**
 * Module Cloudflare, monté sous /api/cloudflare
 *
 *  GET    /                      l'inventaire : ?search= ?status= ?page= ?perPage=
 *  GET    /stats                 ce que la base contient
 *  GET    /zones/:domain         l'état d'une zone : réglages et DNS      — LECTURE
 *  PATCH  /zones/:domain/setting { setting, value }                       — ÉCRITURE
 *  POST   /zones/:domain/purge   { everything } ou { files }              — PURGE
 *  POST   /zones/:domain/dns     { type, name, content, ttl, proxied }    — ÉCRITURE
 *  PUT    /zones/:domain/dns/:id idem                                     — ÉCRITURE
 *  DELETE /zones/:domain/dns/:id                                          — ÉCRITURE
 *  POST   /bulk                  { kind, domains, options }               — MASSE
 *
 * Trois droits, parce que trois gestes de portée différente. `cloudflare.read` ne change
 * rien. `cloudflare.purge` vide un cache : le site repart de zéro, c'est visible mais
 * réversible tout seul. `cloudflare.write` touche au SSL, au DNS, à la sécurité — là,
 * une erreur se voit par les visiteurs et ne se répare pas d'elle-même.
 *
 * Aucune route ne renvoie de secret : le service ne fait sortir que des résultats.
 */
export function cloudflareRouter({ cloudflare, audit }) {
  const r = Router();
  const canRead = requirePermission('cloudflare.read');
  const canWrite = requirePermission('cloudflare.write');
  const canPurge = requirePermission('cloudflare.purge');

  /** Journalise l'issue, et laisse l'erreur remonter au gestionnaire central. */
  const audited = async (req, action, target, fn) => {
    try {
      const out = await fn();
      audit(req, { action, domain: req.params.domain ?? null, target, ok: true });
      return out;
    } catch (err) {
      audit(req, { action, domain: req.params.domain ?? null, target, ok: false, error: err.key ?? err.message });
      throw err;
    }
  };

  r.get('/', canRead, async (req, res) => {
    const { search, status, page, perPage } = req.query;
    res.json(await cloudflare.list({ search, status, page, perPage }));
  });

  r.get('/stats', canRead, async (_req, res) => res.json(await cloudflare.stats()));

  /**
   * Retrouve une liste de domaines d'un coup.
   *
   * En POST, et non en paramètre d'adresse : une liste collée peut compter des milliers
   * de lignes, bien au-delà de ce qu'une adresse accepte. Lecture seule malgré le verbe.
   */
  r.post('/lookup', canRead, async (req, res) => res.json(await cloudflare.lookup(req.body?.domains ?? req.body?.text ?? '')));

  /**
   * Les acces d'un domaine, cle comprise.
   *
   * Droit d'ECRITURE exige, et demande journalisee : une cle globale ouvre le compte
   * entier. Cloudflare masque la sienne derriere un bouton pour la meme raison.
   */
  r.get('/zones/:domain/credentials', canWrite, async (req, res) => {
    audit(req, { action: 'cloudflare.reveal_key', domain: req.params.domain, target: 'credentials', ok: true });
    res.json(await cloudflare.credentials(req.params.domain));
  });

  /**
   * Purge à partir d'une saisie libre : un domaine par ligne.
   *
   * Une ligne peut porter ses propres accès, séparés par des points-virgules, pour un
   * domaine que la base ne connaît pas encore. Ces accès-là ne sont pas enregistrés :
   * une purge est un geste de passage, l'import reste la porte d'entrée.
   */
  r.post('/purge', canPurge, async (req, res) => {
    const { text = '', everything = true, files = [] } = req.body ?? {};
    const lignes = String(text).split('\n').filter((l) => l.trim()).length;
    res.json(await audited(req, 'cloudflare.bulk_purge', `saisie · ${lignes} ligne(s)`, () => cloudflare.purgeFromInput(text, { everything, files })));
  });

  r.get('/zones/:domain', canRead, async (req, res) => {
    res.json(await cloudflare.detail(req.params.domain));
  });

  r.patch('/zones/:domain/setting', canWrite, async (req, res) => {
    const { setting, value } = req.body ?? {};
    res.json(await audited(req, 'cloudflare.setting', setting, () => cloudflare.updateSetting(req.params.domain, setting, value)));
  });

  r.post('/zones/:domain/purge', canPurge, async (req, res) => {
    const { everything = false, files = [] } = req.body ?? {};
    res.json(await audited(req, 'cloudflare.purge', everything ? 'everything' : `${files.length} adresse(s)`, () => cloudflare.purge(req.params.domain, { everything, files })));
  });

  r.post('/zones/:domain/dns', canWrite, async (req, res) => {
    res.json(await audited(req, 'cloudflare.dns_create', `${req.body?.type} ${req.body?.name}`, () => cloudflare.dnsCreate(req.params.domain, req.body ?? {})));
  });

  r.put('/zones/:domain/dns/:recordId', canWrite, async (req, res) => {
    res.json(await audited(req, 'cloudflare.dns_update', req.params.recordId, () => cloudflare.dnsUpdate(req.params.domain, req.params.recordId, req.body ?? {})));
  });

  r.delete('/zones/:domain/dns/:recordId', canWrite, async (req, res) => {
    res.json(await audited(req, 'cloudflare.dns_delete', req.params.recordId, () => cloudflare.dnsDelete(req.params.domain, req.params.recordId)));
  });

  /**
   * Une opération sur plusieurs domaines.
   *
   * Le droit exigé suit la NATURE du geste, pas le fait qu'il soit groupé : purger cent
   * sites reste une purge, changer cent modes SSL reste une écriture.
   */
  r.post('/bulk', (req, res, next) => {
    const garde = req.body?.kind === 'purge' ? canPurge : canWrite;
    garde(req, res, next);
  }, async (req, res) => {
    const { kind, domains = [], options = {} } = req.body ?? {};
    const cible = `${kind} · ${domains.length} domaine(s)`;
    res.json(await audited(req, `cloudflare.bulk_${kind}`, cible, () => cloudflare.bulk(kind, domains, options)));
  });

  return r;
}
