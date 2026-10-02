import { Router } from 'express';
import { AppError } from '../errors.js';
import { cancelJob, createJob, getJob, jobResults, listJobs } from '../db/jobs.js';
import { permissionOf } from '../services/jobKinds.js';

/**
 * Les tournées, montées sous /api/jobs
 *
 *  POST   /                  lance une tournée  { kind, label, params, targets[] }
 *  GET    /                  l'historique       ?kind= ?status= ?mine=1 ?limit=
 *  GET    /:id               l'état d'une tournée
 *  GET    /:id/results       ses résultats, lot par lot  ?after=  ?limit=
 *  POST   /:id/cancel        demande l'arrêt
 *
 * LE DROIT EXIGÉ EST CELUI DU TRAITEMENT, pas un droit « tournée » générique. Confier un
 * travail au serveur ne doit pas permettre de faire ce qu'on n'aurait pas le droit de
 * faire soi-même : une purge Cloudflare demande le droit de purge, une analyse du parc
 * celui de l'analyser. Le catalogue dit lequel, et il peut dépendre des options.
 */
export function jobsRouter({ kinds, runner, audit }) {
  const r = Router();

  const exigerDroit = (req, kind, params) => {
    const besoin = permissionOf(kind, params);
    if (!req.user?.permissions.has(besoin)) {
      throw new AppError('errors.forbidden', { status: 403, vars: { permission: `@perm.${besoin}` } });
    }
  };

  const trouver = async (req) => {
    const job = await getJob(req.params.id);
    if (!job) throw new AppError('errors.job_unknown', { status: 404, vars: { id: String(req.params.id).slice(0, 12) } });
    return job;
  };

  r.post('/', async (req, res) => {
    const { kind: nom, label = '', params = {}, targets = [] } = req.body ?? {};
    const kind = kinds[nom];
    if (!kind) throw new AppError('errors.job_kind_unknown', { status: 400, vars: { kind: String(nom).slice(0, 40) } });
    exigerDroit(req, kind, params);

    // La liste est NETTOYÉE puis FIGÉE : une tournée qui durerait une heure ne doit pas
    // dépendre de ce que l'écran avait en tête au moment du clic.
    const cibles = (Array.isArray(targets) ? targets : [])
      .map((t) => ({ server: String(t?.server ?? '').slice(0, 60) || null, domain: String(t?.domain ?? '').trim().toLowerCase() }))
      .filter((t) => t.domain);
    if (!cibles.length) throw new AppError('errors.job_no_target', { status: 400 });
    if (cibles.length > 100_000) throw new AppError('errors.job_too_many', { status: 400, vars: { max: 100000 } });

    const job = await createJob({
      kind: nom,
      label: String(label).slice(0, 190),
      params,
      targets: cibles,
      userId: req.user?.id ?? null,
      userName: req.user?.displayName || req.user?.username || '',
    });
    audit(req, { action: 'job.start', target: `${job.label || nom} · ${cibles.length} cible(s)`, ok: true });
    // Le moteur prend la suite au prochain tour ; on ne fait pas attendre l'agent.
    res.status(201).json(job);
  });

  r.get('/', async (req, res) => {
    const q = req.query ?? {};
    res.json({
      jobs: await listJobs({
        kind: q.kind || '',
        status: q.status || '',
        userId: q.mine === '1' ? req.user?.id : null,
        limit: Number(q.limit) || 30,
      }),
      // Ce que le serveur mène en ce moment : l'écran peut dire « une autre tournée
      // occupe le serveur » plutôt que de laisser croire que rien ne se passe.
      running: runner.current(),
    });
  });

  r.get('/:id', async (req, res) => res.json(await trouver(req)));

  r.get('/:id/results', async (req, res) => {
    const job = await trouver(req);
    res.json({
      job,
      results: await jobResults(job.id, { afterSeq: Number(req.query.after ?? -1), limit: Number(req.query.limit) || 50 }),
    });
  });

  r.post('/:id/cancel', async (req, res) => {
    const job = await trouver(req);
    exigerDroit(req, kinds[job.kind] ?? { permission: 'bulk.read' }, job.params);
    // L'arrêt est demandé des deux côtés : la base pour une tournée pas encore prise,
    // le moteur pour celle qui tourne — il s'arrêtera entre deux lots.
    runner.cancel(job.id);
    const out = await cancelJob(job.id);
    audit(req, { action: 'job.cancel', target: `${job.label || job.kind} · ${job.done}/${job.total}`, ok: true });
    res.json(out);
  });

  return r;
}
