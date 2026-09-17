import { AppError } from '../errors.js';
import { assertDomain } from '../ssh/shell.js';
import { statusCommand } from './parcDriver.js';
import {
  EXIT_ERRORS,
  assertEntryName,
  baseOf,
  catCommand,
  createFileCommand,
  deleteCommand,
  joinRel,
  listCommand,
  mkdirCommand,
  normalizeRelPath,
  parentOf,
  parseListing,
  readCommand,
  renameCommand,
  stripCommonRoot,
  tarCommand,
  untarCommand,
  writeCommand,
} from './fsDriver.js';
import { parseTar, tarStream } from '../util/tar.js';
import { extractEntry, readZipEntries, zipStream, zipToBuffer } from '../util/zip.js';

const SNIFF = 8192; // octets examinés pour décider « texte ou binaire »
const LONG_TIMEOUT = 300000; // opérations d'archive

/**
 * Gestionnaire de fichiers d'un domaine.
 *
 * Deux principes de conception, imposés par la latence des liaisons (~500 ms par aller-retour) :
 *   - une opération = une commande SSH ;
 *   - les arborescences transitent en TAR (un seul flux), converties en ZIP côté application,
 *     car les serveurs du parc n'ont ni `zip` ni `unzip`.
 *
 * Toute écriture est refusée si le domaine est verrouillé (public_html immuable).
 */
export class FileService {
  constructor(ssh, { limits }) {
    this.ssh = ssh;
    this.limits = limits;
  }

  context(serverId, domain) {
    const server = this.ssh.server(serverId);
    assertDomain(domain);
    return { server, docroot: `${server.wwwRoot}/${domain}/public_html` };
  }

  /** Exécute une commande en collectant stdout binaire, avec entrée standard optionnelle. */
  async #run(serverId, command, { stdin, maxBytes = 16 * 1024 * 1024, timeout } = {}) {
    const { stream, done } = await this.ssh.spawn(serverId, command, { timeout });
    const chunks = [];
    let size = 0;
    let overflow = false;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        overflow = true;
        stream.close();
        return;
      }
      chunks.push(chunk);
    });
    stream.end(stdin);
    const res = await done;
    if (overflow) throw new AppError('errors.file_too_big', { status: 413 });
    return { ...res, stdout: Buffer.concat(chunks) };
  }

  #check(res, server) {
    if (res.code === 0) return res;
    const mapped = EXIT_ERRORS[res.code];
    if (mapped) throw new AppError(mapped.key, { status: mapped.status, vars: { server: server.label } });
    throw new AppError('errors.ssh_command_failed', {
      status: 502,
      vars: { server: server.label, code: res.code ?? res.signal },
      detail: (res.stderr || '').trim().slice(-2000) || undefined,
    });
  }

  /** missing | incomplete | locked | unlocked */
  async status(serverId, domain) {
    const { server } = this.context(serverId, domain);
    const r = await this.ssh.exec(serverId, statusCommand(server, domain), { timeout: 20000 });
    return r.stdout.trim();
  }

  /** Une écriture n'est possible que sur un domaine déverrouillé. */
  async #assertWritable(serverId, domain) {
    const status = await this.status(serverId, domain);
    const server = this.ssh.server(serverId);
    if (status === 'missing') throw new AppError('errors.domain_not_found', { status: 404, vars: { domain, server: server.label } });
    if (status === 'locked') throw new AppError('errors.file_locked', { status: 409, vars: { domain } });
    return status;
  }

  // ───────────────────────── Lecture ─────────────────────────

  async list(serverId, domain, path) {
    const { server, docroot } = this.context(serverId, domain);
    const rel = normalizeRelPath(path);
    const limit = this.limits.maxEntries;
    const [listing, status] = await Promise.all([
      this.#run(serverId, listCommand(docroot, rel, limit), { timeout: 60000 }),
      this.status(serverId, domain).catch(() => null),
    ]);
    this.#check(listing, server);
    const { entries, truncated } = parseListing(listing.stdout, limit);
    entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
    return {
      server: serverId,
      domain,
      path: rel,
      parent: rel ? parentOf(rel) : null,
      docroot,
      entries,
      truncated,
      limit,
      status,
      maxUpload: this.limits.maxUploadBytes,
    };
  }

  async read(serverId, domain, path) {
    const { server, docroot } = this.context(serverId, domain);
    const rel = normalizeRelPath(path, { allowRoot: false });
    const max = this.limits.maxEditBytes;
    const res = await this.#run(serverId, readCommand(docroot, rel, max), { maxBytes: max + 1024, timeout: 120000 });
    if (res.code === 81) throw new AppError('errors.file_too_big_edit', { status: 413, vars: { size: this.#fmtMax(max) } });
    this.#check(res, server);
    const [, mtime] = (res.stderr.trim().split(/\s+/) ?? []).map(Number);
    const binary = res.stdout.subarray(0, SNIFF).includes(0);
    return {
      path: rel,
      name: baseOf(rel),
      size: res.stdout.length,
      mtime: Number.isFinite(mtime) ? mtime * 1000 : null,
      mtimeRaw: Number.isFinite(mtime) ? mtime : null,
      binary,
      content: binary ? null : res.stdout.toString('utf8'),
    };
  }

  /** Téléchargement d'un fichier : flux brut, non mis en mémoire. */
  async openDownload(serverId, domain, path) {
    const { docroot } = this.context(serverId, domain);
    const rel = normalizeRelPath(path, { allowRoot: false });
    const { stream, done } = await this.ssh.spawn(serverId, catCommand(docroot, rel), { timeout: LONG_TIMEOUT });
    stream.end();
    return { name: baseOf(rel), stream, done };
  }

  /** Téléchargement groupé : TAR côté serveur → ZIP produit à la volée. */
  async openArchiveDownload(serverId, domain, path, names) {
    const { docroot } = this.context(serverId, domain);
    const rel = normalizeRelPath(path);
    const selection = this.#selection(names);
    const { stream, done } = await this.ssh.spawn(serverId, tarCommand(docroot, rel, selection), { timeout: LONG_TIMEOUT });
    stream.end();
    const name = selection.length === 1 ? `${selection[0]}.zip` : `${domain}${rel ? `-${rel.replace(/\//g, '-')}` : ''}.zip`;
    const limits = this.limits;
    return {
      name,
      done,
      chunks: zipStream(parseTar(stream, { maxBytes: limits.maxArchiveBytes, maxEntries: limits.maxArchiveEntries })),
    };
  }

  // ───────────────────────── Écriture ─────────────────────────

  async write(serverId, domain, path, content, { expectMtime } = {}) {
    const { server, docroot } = this.context(serverId, domain);
    const rel = normalizeRelPath(path, { allowRoot: false });
    const data = Buffer.from(String(content ?? ''), 'utf8');
    if (data.length > this.limits.maxEditBytes) throw new AppError('errors.file_too_big_edit', { status: 413, vars: { size: this.#fmtMax(this.limits.maxEditBytes) } });
    await this.#assertWritable(serverId, domain);
    const res = await this.#run(serverId, writeCommand(docroot, rel, { expectMtime }), { stdin: data, timeout: 120000 });
    if (res.code === 82) throw new AppError('errors.file_conflict', { status: 409, vars: { name: baseOf(rel) } });
    this.#check(res, server);
    const [size, mtime] = res.stdout.toString('utf8').trim().split(/\s+/).map(Number);
    return { path: rel, size, mtime: mtime * 1000, mtimeRaw: mtime };
  }

  async rename(serverId, domain, path, newName) {
    const { server, docroot } = this.context(serverId, domain);
    const rel = normalizeRelPath(path, { allowRoot: false });
    const name = assertEntryName(newName);
    if (name === baseOf(rel)) return { path: rel, name };
    await this.#assertWritable(serverId, domain);
    const res = await this.#run(serverId, renameCommand(docroot, rel, name), { timeout: 60000 });
    if (res.code === 79) throw new AppError('errors.file_exists', { status: 409, vars: { name } });
    this.#check(res, server);
    return { path: joinRel(parentOf(rel), name), name };
  }

  async remove(serverId, domain, paths) {
    const { server, docroot } = this.context(serverId, domain);
    const list = (Array.isArray(paths) ? paths : [paths]).map((p) => normalizeRelPath(p, { allowRoot: false }));
    if (!list.length) throw new AppError('errors.bad_request', { status: 400 });
    if (list.length > this.limits.maxBatch) throw new AppError('errors.file_batch_too_big', { status: 400, vars: { max: this.limits.maxBatch } });
    await this.#assertWritable(serverId, domain);
    const res = await this.#run(serverId, deleteCommand(docroot, list), { timeout: LONG_TIMEOUT });
    this.#check(res, server);
    return { deleted: list.length, paths: list };
  }

  /**
   * Téléverse un fichier depuis le poste de l'utilisateur dans le dossier courant.
   * Avec `extract`, une archive .zip est décompressée dans la foulée (sans relecture réseau).
   */
  async upload(serverId, domain, path, name, data, { extract = false } = {}) {
    const { server, docroot } = this.context(serverId, domain);
    const dir = normalizeRelPath(path);
    const entry = assertEntryName(name);
    if (!Buffer.isBuffer(data) || data.length === 0) throw new AppError('errors.file_upload_empty', { status: 400 });
    if (data.length > this.limits.maxUploadBytes) throw new AppError('errors.file_too_big', { status: 413 });
    await this.#assertWritable(serverId, domain);

    const rel = joinRel(dir, entry);
    const res = await this.#run(serverId, createFileCommand(docroot, rel), { stdin: data, timeout: LONG_TIMEOUT });
    if (res.code === 79) throw new AppError('errors.file_exists', { status: 409, vars: { name: entry } });
    this.#check(res, server);

    const uploaded = { path: rel, name: entry, size: data.length };
    if (!extract) return uploaded;
    if (!/\.zip$/i.test(entry)) throw new AppError('errors.file_zip_invalid', { status: 400, vars: { name: entry } });
    return { ...uploaded, extracted: await this.extract(serverId, domain, rel, undefined, { zipBuffer: data }) };
  }

  /** Crée un fichier vide (le contenu s'écrit ensuite par l'éditeur). */
  async createFile(serverId, domain, path, name) {
    const { server, docroot } = this.context(serverId, domain);
    const dir = normalizeRelPath(path);
    const entry = assertEntryName(name);
    await this.#assertWritable(serverId, domain);
    const rel = joinRel(dir, entry);
    const res = await this.#run(serverId, createFileCommand(docroot, rel), { stdin: Buffer.alloc(0), timeout: 60000 });
    if (res.code === 79) throw new AppError('errors.file_exists', { status: 409, vars: { name: entry } });
    this.#check(res, server);
    return { path: rel, name: entry };
  }

  async mkdir(serverId, domain, path, name) {
    const { server, docroot } = this.context(serverId, domain);
    const dir = normalizeRelPath(path);
    const entry = assertEntryName(name);
    await this.#assertWritable(serverId, domain);
    const rel = joinRel(dir, entry);
    const res = await this.#run(serverId, mkdirCommand(docroot, rel), { timeout: 60000 });
    if (res.code === 79) throw new AppError('errors.file_exists', { status: 409, vars: { name: entry } });
    this.#check(res, server);
    return { path: rel, name: entry };
  }

  // ───────────────────────── Archives ─────────────────────────

  /** Compresse une sélection en .zip DANS le dossier courant (lecture TAR → ZIP → écriture). */
  async compress(serverId, domain, path, names, archiveName) {
    const { server, docroot } = this.context(serverId, domain);
    const rel = normalizeRelPath(path);
    const selection = this.#selection(names);
    const zipName = assertEntryName(archiveName || `${selection.length === 1 ? selection[0] : domain}.zip`);
    const target = zipName.toLowerCase().endsWith('.zip') ? zipName : `${zipName}.zip`;
    await this.#assertWritable(serverId, domain);

    const { stream, done } = await this.ssh.spawn(serverId, tarCommand(docroot, rel, selection), { timeout: LONG_TIMEOUT });
    stream.end();
    let buffer;
    try {
      buffer = await zipToBuffer(parseTar(stream, { maxBytes: this.limits.maxArchiveBytes, maxEntries: this.limits.maxArchiveEntries }));
    } catch (err) {
      stream.close();
      await done.catch(() => {});
      throw new AppError('errors.file_archive_too_big', { status: 413, vars: { size: this.#fmtMax(this.limits.maxArchiveBytes) }, detail: err.message });
    }
    this.#check(await done, server);

    const res = await this.#run(serverId, createFileCommand(docroot, joinRel(rel, target)), { stdin: buffer, timeout: LONG_TIMEOUT });
    if (res.code === 79) throw new AppError('errors.file_exists', { status: 409, vars: { name: target } });
    this.#check(res, server);
    return { path: joinRel(rel, target), name: target, size: buffer.length, entries: selection.length };
  }

  /** Décompresse une archive .zip dans un sous-dossier (lecture ZIP → TAR → extraction). */
  async extract(serverId, domain, path, destName, { zipBuffer } = {}) {
    const { server, docroot } = this.context(serverId, domain);
    const rel = normalizeRelPath(path, { allowRoot: false });
    const dir = parentOf(rel);
    const base = baseOf(rel).replace(/\.zip$/i, '') || 'archive';
    const dest = assertEntryName(destName || base);
    await this.#assertWritable(serverId, domain);

    // Après un téléversement, l'archive est déjà en mémoire : inutile de la relire sur le serveur.
    const read = zipBuffer ? { code: 0, stdout: zipBuffer } : await this.#run(serverId, catCommand(docroot, rel), { maxBytes: this.limits.maxArchiveBytes, timeout: LONG_TIMEOUT });
    if (!zipBuffer) this.#check(read, server);

    let entries;
    try {
      entries = readZipEntries(read.stdout);
    } catch (err) {
      throw new AppError('errors.file_zip_invalid', { status: 400, vars: { name: baseOf(rel) }, detail: err.message });
    }

    const safe = [];
    let skipped = 0;
    let total = 0;
    for (const entry of entries) {
      let name;
      try {
        name = normalizeRelPath(entry.name, { allowRoot: false }); // neutralise « ../ » et les chemins absolus
      } catch {
        skipped++;
        continue;
      }
      if (entry.isSymlink) {
        skipped++;
        continue;
      }
      total += entry.size;
      if (total > this.limits.maxArchiveBytes || safe.length > this.limits.maxArchiveEntries) {
        throw new AppError('errors.file_archive_too_big', { status: 413, vars: { size: this.#fmtMax(this.limits.maxArchiveBytes) } });
      }
      safe.push({ entry, name });
    }
    if (!safe.length) throw new AppError('errors.file_zip_empty', { status: 400, vars: { name: baseOf(rel) } });

    // Archive à dossier racine unique : on le retire pour éviter « parts/parts/… ».
    const { root, items } = stripCommonRoot(safe);

    const archive = read.stdout;
    const max = this.limits.maxArchiveBytes;
    async function* toTar() {
      for (const { entry, name } of items) {
        yield {
          name,
          isDir: entry.isDir,
          mtime: new Date(),
          mode: entry.isDir ? 0o755 : 0o644,
          data: entry.isDir ? Buffer.alloc(0) : extractEntry(archive, entry, max),
        };
      }
    }

    const { stream, done } = await this.ssh.spawn(serverId, untarCommand(docroot, joinRel(dir, dest)), { timeout: LONG_TIMEOUT });
    // `tar -xf -` n'écrit rien : sans lecteur, le flux resterait en pause et la fermeture
    // du canal ne serait jamais notifiée. On consomme donc la sortie, même vide.
    stream.on('data', () => {});
    for await (const chunk of tarStream(toTar())) {
      if (!stream.write(chunk)) await new Promise((resolve) => stream.once('drain', resolve));
    }
    stream.end();
    const res = await done;
    if (res.code === 79) throw new AppError('errors.file_exists', { status: 409, vars: { name: dest } });
    this.#check({ ...res, stdout: Buffer.alloc(0) }, server);
    return { path: joinRel(dir, dest), name: dest, files: items.length, skipped, strippedRoot: root };
  }

  #selection(names) {
    const list = (Array.isArray(names) ? names : [names]).map(assertEntryName);
    if (!list.length) throw new AppError('errors.bad_request', { status: 400 });
    if (list.length > this.limits.maxBatch) throw new AppError('errors.file_batch_too_big', { status: 400, vars: { max: this.limits.maxBatch } });
    return list;
  }

  #fmtMax(bytes) {
    return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} Mo` : `${Math.round(bytes / 1024)} Ko`;
  }
}
