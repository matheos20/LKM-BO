import express, { Router } from 'express';
import { AppError } from '../errors.js';
import { requireConnection, requirePermission, requireServerAccess } from '../middleware/index.js';
import { EXIT_ERRORS } from '../services/fsDriver.js';

/**
 * Gestionnaire de fichiers, monté sous /api/servers/:id/domains/:domain/files
 *
 *  GET    /                    liste un dossier            ?path=sous/dossier
 *  GET    /read                contenu d'un fichier texte  ?path=...
 *  PUT    /content             enregistre un fichier       { path, content, expectMtime }
 *  POST   /rename              renomme                     { path, name }
 *  POST   /mkdir               nouveau dossier             { path, name }
 *  POST   /new-file            nouveau fichier vide        { path, name }
 *  POST   /upload              téléversement              ?path=&name=&extract=1 + corps binaire
 *  POST   /compress            crée une archive .zip       { path, names[], archive }
 *  POST   /extract             décompresse une archive     { path, dest }
 *  DELETE /                    supprime                    { paths[] }
 *  GET    /download            télécharge un fichier       ?path=...
 *  POST   /download            télécharge une sélection    { path, names[] }  → .zip
 */
export function filesRouter({ ssh, files, audit, uploadLimit }) {
  const r = Router({ mergeParams: true });
  const conn = requireConnection(ssh);
  const canRead = requirePermission('files.read');
  const canWrite = requirePermission('files.write');
  const canDelete = requirePermission('files.delete');
  // Portée par serveur d'abord, connexion SSH ensuite, puis permission par route.
  r.use(requireServerAccess(ssh), conn);

  const ctx = (req) => ({ id: req.params.id, domain: req.params.domain });

  const audited = async (req, action, target, fn) => {
    try {
      const out = await fn();
      audit(req, { action, server: req.params.id, domain: req.params.domain, target, ok: true });
      return out;
    } catch (err) {
      audit(req, { action, server: req.params.id, domain: req.params.domain, target, ok: false, error: err.key ?? err.message });
      throw err;
    }
  };

  /** En-tête de téléchargement : nom compatible RFC 5987 (accents, espaces). */
  function attach(res, name) {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Cache-Control', 'no-store');
  }

  const exitError = (code, server) => {
    const mapped = EXIT_ERRORS[code];
    return mapped
      ? new AppError(mapped.key, { status: mapped.status, vars: { server } })
      : new AppError('errors.ssh_command_failed', { status: 502, vars: { server, code } });
  };

  const write = (res, chunk) =>
    res.write(chunk) ? Promise.resolve() : new Promise((resolve) => res.once('drain', resolve));

  // ───────────────────────── Lecture ─────────────────────────

  r.get('/', canRead, async (req, res) => {
    const { id, domain } = ctx(req);
    res.json(await files.list(id, domain, req.query.path));
  });

  r.get('/read', canRead, async (req, res) => {
    const { id, domain } = ctx(req);
    res.json(await files.read(id, domain, req.query.path));
  });

  r.get('/download', canRead, async (req, res, next) => {
    const { id, domain } = ctx(req);
    const { name, stream, done } = await files.openDownload(id, domain, req.query.path);
    let started = false;
    stream.on('data', (chunk) => {
      if (!started) {
        started = true;
        attach(res, name);
      }
      if (!res.write(chunk)) {
        stream.pause();
        res.once('drain', () => stream.resume());
      }
    });
    const result = await done;
    if (result.code !== 0) {
      if (!started) return next(exitError(result.code, ssh.server(id).label));
      return res.destroy(); // erreur en cours de flux : on coupe plutôt que livrer un fichier tronqué
    }
    if (!started) attach(res, name); // fichier vide
    audit(req, { action: 'file.download', server: id, domain, target: req.query.path, ok: true });
    res.end();
  });

  r.post('/download', canRead, async (req, res, next) => {
    const { id, domain } = ctx(req);
    const { name, chunks, done } = await files.openArchiveDownload(id, domain, req.body?.path, req.body?.names);
    let started = false;
    try {
      for await (const chunk of chunks) {
        if (!started) {
          started = true;
          attach(res, name);
        }
        await write(res, chunk);
      }
    } catch (err) {
      if (!started) return next(err);
      return res.destroy();
    }
    const result = await done;
    if (result.code !== 0 && !started) return next(exitError(result.code, ssh.server(id).label));
    if (result.code !== 0) return res.destroy();
    audit(req, { action: 'file.download_zip', server: id, domain, target: (req.body?.names ?? []).join(', '), ok: true });
    res.end();
  });

  // ───────────────────────── Écriture ─────────────────────────

  r.put('/content', canWrite, async (req, res) => {
    const { id, domain } = ctx(req);
    const { path, content, expectMtime } = req.body ?? {};
    res.json(await audited(req, 'file.save', path, () => files.write(id, domain, path, content, { expectMtime })));
  });

  r.post('/rename', canWrite, async (req, res) => {
    const { id, domain } = ctx(req);
    const { path, name } = req.body ?? {};
    res.json(await audited(req, 'file.rename', `${path} → ${name}`, () => files.rename(id, domain, path, name)));
  });

  r.post('/mkdir', canWrite, async (req, res) => {
    const { id, domain } = ctx(req);
    const { path, name } = req.body ?? {};
    res.status(201).json(await audited(req, 'file.mkdir', name, () => files.mkdir(id, domain, path, name)));
  });

  r.post('/new-file', canWrite, async (req, res) => {
    const { id, domain } = ctx(req);
    const { path, name } = req.body ?? {};
    res.status(201).json(await audited(req, 'file.create', name, () => files.createFile(id, domain, path, name)));
  });

  // Le fichier arrive en corps binaire brut (aucune dépendance multipart) ; nom et
  // destination passent en paramètres d'URL, validés comme partout ailleurs.
  r.post('/upload', canWrite, express.raw({ type: () => true, limit: uploadLimit }), async (req, res) => {
    const { id, domain } = ctx(req);
    const { path = '', name, extract } = req.query;
    const out = await audited(req, 'file.upload', name, () => files.upload(id, domain, path, name, req.body, { extract: extract === '1' }));
    res.status(201).json(out);
  });

  r.delete('/', canDelete, async (req, res) => {
    const { id, domain } = ctx(req);
    const paths = req.body?.paths;
    res.json(await audited(req, 'file.delete', (paths ?? []).join(', '), () => files.remove(id, domain, paths)));
  });

  r.post('/compress', canWrite, async (req, res) => {
    const { id, domain } = ctx(req);
    const { path, names, archive } = req.body ?? {};
    res.status(201).json(await audited(req, 'file.compress', (names ?? []).join(', '), () => files.compress(id, domain, path, names, archive)));
  });

  r.post('/extract', canWrite, async (req, res) => {
    const { id, domain } = ctx(req);
    const { path, dest } = req.body ?? {};
    res.status(201).json(await audited(req, 'file.extract', path, () => files.extract(id, domain, path, dest)));
  });

  return r;
}
