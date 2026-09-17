import fs from 'node:fs';
import path from 'node:path';

/**
 * Épinglage des clés d'hôte (équivalent de ~/.ssh/known_hosts, format JSON).
 * { "host:port": "SHA256:..." }
 *  - hôte connu + même empreinte → ok
 *  - hôte connu + empreinte différente → mismatch (connexion refusée : MITM possible)
 *  - hôte inconnu → enregistré au 1er contact (TOFU), ou refusé si mode strict
 */
export class KnownHosts {
  constructor(file) {
    this.file = file;
    this.map = {};
    try {
      this.map = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`known_hosts illisible (${file}) : ${err.message}`);
    }
  }

  check(hostId, fingerprint, strict) {
    const known = this.map[hostId];
    if (known) return known === fingerprint ? 'ok' : 'mismatch';
    if (strict) return 'unknown';
    this.map[hostId] = fingerprint;
    this.save();
    return 'new';
  }

  get(hostId) {
    return this.map[hostId] ?? null;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.map, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }
}
