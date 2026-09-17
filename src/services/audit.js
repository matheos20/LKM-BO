import fs from 'node:fs';
import path from 'node:path';

/** Journal d'audit JSON Lines : qui a fait quoi, sur quel serveur, avec quel résultat. */
export function createAudit(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return (req, entry) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), user: req.session?.user ?? null, ip: req.ip, ...entry });
    fs.appendFile(file, `${line}\n`, (err) => err && console.error(`[audit] ${err.message}`));
  };
}
