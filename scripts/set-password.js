// npm run set-password  →  écrit ADMIN_PASSWORD_HASH (scrypt) dans .env, et génère SESSION_SECRET si absent.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { ROOT } from '../src/config.js';
import { hashPassword } from '../src/auth/password.js';

const envFile = path.join(ROOT, '.env');

function askHidden(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(query)) process.stdout.write(query);
    };
    rl.question(query, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const fromArg = process.argv[2];
const password = fromArg ?? (await askHidden('Nouveau mot de passe administrateur : '));
if (password.length < 12) {
  console.error('✖ 12 caractères minimum.');
  process.exit(1);
}
if (!fromArg && (await askHidden('Confirmez le mot de passe : ')) !== password) {
  console.error('✖ Les deux saisies ne correspondent pas.');
  process.exit(1);
}

let env = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
const set = (key, value) => {
  const re = new RegExp(`^${key}=.*$`, 'm');
  // Remplacement par fonction : le hash contient des "$" qu'il ne faut pas interpréter.
  env = re.test(env) ? env.replace(re, () => `${key}=${value}`) : `${env.trimEnd()}\n${key}=${value}\n`;
};

set('ADMIN_PASSWORD_HASH', hashPassword(password));
if (!/^SESSION_SECRET=.{32,}$/m.test(env)) set('SESSION_SECRET', crypto.randomBytes(48).toString('base64url'));
fs.writeFileSync(envFile, env);
console.log(`✔ Mot de passe enregistré dans ${envFile}`);
console.log("  Il sert à créer l'administrateur initial au premier démarrage.");
console.log('  Ensuite, les comptes se gèrent dans l\'application ou avec « npm run user ».');
