import { Router } from 'express';
import { AppError } from '../errors.js';
import { listThematiques, statsThematiques } from '../db/thematiques.js';
import { requireConnection, requirePermission, requireServerAccess } from '../middleware/index.js';

/**
 *  GET    /api/thematiques                 la liste et son menu, depuis la base
 *  POST   /api/thematiques/apply           pose une thématique sur un ou plusieurs sites
 *  POST   /api/thematiques/backups         les sauvegardes d'un ou plusieurs sites
 *  POST   /api/thematiques/restore         remet un site dans son état d'avant
 *
 * L'ANALYSE N'EST PAS ICI : elle passe par une tournée (`theme.analyze`), parce que lire
 * cent cinquante sites ne doit pas dépendre d'un onglet resté ouvert. L'écran montre
 * ensuite ce qu'elle a trouvé, et c'est de là qu'on applique — comme pour les
 * redirections et les rubriques, dont l'agent connaît déjà la façon de faire.
 *
 * La pose a donc deux portes pour une seule mécanique : cette route, qui sert l'écran, et
 * la tournée `theme.apply`, qui reste disponible pour les très grandes séries. Toutes
 * deux appellent `themes.apply`, et il n'y a pas deux fois la même logique.
 *
 * LA RESTAURATION EXIGE LE DROIT D'APPLIQUER. Elle écrit sur un site : remettre un
 * ancien état est une écriture comme une autre, et le droit de lire n'y suffit pas.
 */
export function thematiquesRouter({ ssh, themes, audit }) {
  const r = Router();
  const conn = requireConnection(ssh);
  const access = requireServerAccess(ssh);
  const canRead = requirePermission('bulk.read');
  const canApply = requirePermission('bulk.apply');

  /** Les domaines reçus d'un écran : nettoyés ici, revalidés par le service. */
  const domaines = (body) =>
    [...new Set((Array.isArray(body?.domains) ? body.domains : []).map((d) => String(d ?? '').trim().toLowerCase()).filter(Boolean))];

  r.get('/', canRead, async (req, res) => {
    const lang = String(req.query.lang ?? '').toUpperCase().slice(0, 5);
    res.json({
      thematiques: await listThematiques({ lang }),
      // Ce qui reste à compléter : l'écran doit pouvoir prévenir avant qu'une thématique
      // sans icônes ne soit posée sur un site.
      stats: await statsThematiques(),
    });
  });

  /**
   * Le serveur visé arrive dans le corps de la requête, et non dans le chemin : la liste
   * de domaines l'accompagne, et elle peut être longue. Les deux intergiciels de portée
   * ont besoin de `req.params.id`, qu'on leur donne donc avant de les appeler.
   */
  const avecServeur = (req, _res, next) => {
    const id = String(req.body?.server ?? '').trim();
    if (!id) return next(new AppError('errors.bad_request', { status: 400 }));
    req.params.id = id;
    next();
  };

  r.post('/backups', canRead, avecServeur, access, conn, async (req, res) => {
    res.json(await themes.backups(req.params.id, domaines(req.body)));
  });

  /**
   * LA POSE. Elle appelle le MÊME service que la tournée `theme.apply` : deux portes, une
   * seule mécanique. Celle-ci sert l'écran, qui applique après avoir montré l'analyse —
   * c'est la façon de faire des redirections et des rubriques, et l'agent la connaît. La
   * tournée, elle, reste disponible pour les très grandes séries, qu'un onglet fermé ne
   * doit pas interrompre.
   *
   * `allowOrphans` est une autorisation EXPLICITE : sans elle, un site dont des articles
   * perdraient leur rubrique est laissé de côté, et le dit.
   */
  r.post('/apply', canApply, avecServeur, access, conn, async (req, res) => {
    const liste = domaines(req.body);
    const thematiqueId = Number(req.body?.thematiqueId) || 0;
    const allowOrphans = req.body?.allowOrphans === true;
    try {
      const out = await themes.apply(req.params.id, liste, thematiqueId, req.user?.id ?? null, { allowOrphans });
      const poses = out.sites.filter((s) => s.state === 'done').length;
      audit(req, {
        action: 'theme.apply',
        server: req.params.id,
        target: `${out.target?.label ?? thematiqueId} · ${poses}/${liste.length}`,
        ok: true,
      });
      res.json(out);
    } catch (err) {
      audit(req, { action: 'theme.apply', server: req.params.id, target: String(thematiqueId), ok: false, error: err.key ?? err.message });
      throw err;
    }
  });

  r.post('/restore', canApply, avecServeur, access, conn, async (req, res) => {
    const domain = String(req.body?.domain ?? '').trim().toLowerCase();
    const stamp = String(req.body?.stamp ?? '').trim();
    try {
      const out = await themes.restore(req.params.id, domain, stamp, req.user?.id ?? null);
      audit(req, { action: 'theme.restore', server: req.params.id, domain, target: stamp, ok: true });
      res.json(out);
    } catch (err) {
      audit(req, { action: 'theme.restore', server: req.params.id, domain, target: stamp, ok: false, error: err.key ?? err.message });
      throw err;
    }
  });

  return r;
}
