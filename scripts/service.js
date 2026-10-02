#!/usr/bin/env node
/**
 * Fait démarrer le back-office avec la machine.
 *
 *   npm run service              montre ce qui serait installé, et l'état actuel
 *   npm run service -- install --yes
 *   npm run service -- install --at=startup --yes   (démarrage machine, demande l'admin)
 *   npm run service -- status
 *   npm run service -- uninstall --yes
 *
 * RIEN NE S'INSTALLE SANS « --yes ». Déclarer une tâche planifiée modifie la machine en
 * dehors de ce dossier : c'est le genre de geste qu'on doit avoir voulu.
 *
 * DEUX MOMENTS POSSIBLES, ET ILS NE SE VALENT PAS :
 *
 *   --at=logon (défaut)   le back-office démarre quand quelqu'un ouvre sa session.
 *                         Ne demande aucun droit d'administrateur. C'est ce qu'il faut
 *                         sur le poste d'un agent.
 *   --at=startup          il démarre avec la machine, même sans personne connectée.
 *                         Demande l'administrateur — ET que MySQL démarre aussi tout
 *                         seul : sous XAMPP, il faut l'installer en service Windows,
 *                         sans quoi le back-office tournera en rond faute de base.
 *
 * Le surveillant, lui, fait le reste : il relance le serveur s'il s'arrête, et aussi
 * s'il cesse de répondre.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOM = 'LKM Back-Office';

const COULEUR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COULEUR ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const gras = (s) => c('1', s);
const vert = (s) => c('32', s);
const rouge = (s) => c('31', s);
const orange = (s) => c('33', s);
const gris = (s) => c('90', s);
const titre = (s) => console.log(`\n${gras(s)}\n${gris('─'.repeat(Math.min(72, s.length + 8)))}`);
const ok = (s) => console.log(`  ${vert('✓')} ${s}`);
const ko = (s) => console.log(`  ${rouge('✗')} ${s}`);
const info = (s) => console.log(`  ${s}`);
const note = (s) => console.log(`  ${gris(s)}`);

const [, , commande = 'show', ...reste] = process.argv;
const options = Object.fromEntries(reste.filter((a) => a.startsWith('--')).map((a) => [a.slice(2).split('=')[0], a.includes('=') ? a.split('=')[1] : true]));
const quand = options.at === 'startup' ? 'startup' : 'logon';
const WINDOWS = process.platform === 'win32';

/** La commande que la tâche planifiée exécutera. */
const commandeLancee = () => `cmd /c cd /d "${RACINE}" && node scripts/supervise.js >> logs\\service.log 2>&1`;

const schtasks = (args) => spawnSync('schtasks', args, { encoding: 'utf8', windowsHide: true });

function etat() {
  const r = schtasks(['/Query', '/TN', NOM]);
  return { installee: r.status === 0, sortie: String(r.stdout || r.stderr || '').trim() };
}

/** Ce qu'il faut faire sur un serveur Linux : un fichier de service, et deux commandes. */
function expliquerSystemd() {
  titre('Démarrage automatique (Linux)');
  note('Le fichier de service est fourni dans deploy/lkm-bo.service.');
  console.log();
  info('  sudo cp deploy/lkm-bo.service /etc/systemd/system/');
  info('  sudo systemctl daemon-reload');
  info(`  sudo systemctl enable --now lkm-bo`);
  console.log();
  note('Adaptez d’abord User, WorkingDirectory et ExecStart au serveur.');
  note('Chez un hébergeur mutualisé (o2switch), c’est le panneau Node.js qui');
  note('redémarre l’application : il n’y a pas de service à installer.');
}

if (!WINDOWS && commande !== 'status') {
  expliquerSystemd();
  process.exit(0);
}

try {
  if (commande === 'status') {
    titre('Démarrage automatique');
    if (!WINDOWS) { expliquerSystemd(); process.exit(0); }
    const e = etat();
    if (e.installee) {
      ok(`la tâche « ${NOM} » est déclarée`);
      console.log();
      console.log(gris(e.sortie));
    } else {
      info(`${orange('aucune tâche déclarée')} : le back-office ne redémarrera pas tout seul.`);
      note('npm run service -- install --yes');
    }
    process.exit(0);
  }

  if (commande === 'uninstall') {
    titre('Retrait du démarrage automatique');
    if (!etat().installee) { info('rien à retirer.'); process.exit(0); }
    info(`tâche : ${gras(NOM)}`);
    if (!options.yes) {
      console.log();
      info(`${orange('Rien n’a été retiré.')} Ajoutez ${gras('--yes')}.`);
      process.exit(0);
    }
    const r = schtasks(['/Delete', '/TN', NOM, '/F']);
    if (r.status !== 0) { ko(String(r.stderr || r.stdout).trim()); process.exit(1); }
    ok('tâche retirée — le back-office ne démarrera plus tout seul.');
    process.exit(0);
  }

  // install, ou l'aperçu par défaut.
  titre('Démarrage automatique du back-office');
  const e = etat();
  info(`tâche      : ${gras(NOM)}${e.installee ? ` ${vert('(déjà déclarée, elle sera remplacée)')}` : ''}`);
  info(`déclenchée : ${gras(quand === 'startup' ? 'au démarrage de la machine' : 'à l’ouverture de session')}`);
  info(`exécute    : ${gris(commandeLancee())}`);
  console.log();
  note('Le surveillant relance le serveur s’il s’arrête, et aussi s’il cesse de répondre.');
  note('Son journal : logs/supervisor.log — celui du service : logs/service.log');
  if (quand === 'startup') {
    console.log();
    info(orange('À SAVOIR'));
    note('« --at=startup » exige une console ouverte en administrateur.');
    note('Et MySQL doit démarrer seul lui aussi : sous XAMPP, installez-le en service');
    note('Windows, sinon le back-office tournera en rond faute de base de données.');
  }

  if (commande !== 'install' || !options.yes) {
    console.log();
    info(`${orange('Rien n’a été installé.')} Ajoutez ${gras('install --yes')} pour déclarer la tâche.`);
    process.exit(0);
  }

  const args = ['/Create', '/TN', NOM, '/TR', commandeLancee(), '/F'];
  if (quand === 'startup') args.push('/SC', 'ONSTART', '/RU', 'SYSTEM');
  else args.push('/SC', 'ONLOGON');

  const r = schtasks(args);
  if (r.status !== 0) {
    ko(String(r.stderr || r.stdout).trim().split('\n')[0]);
    if (quand === 'startup') note('Ouvrez une console en administrateur, ou gardez « --at=logon ».');
    process.exit(1);
  }
  ok('tâche déclarée.');
  console.log();
  note('Pour la lancer tout de suite sans redémarrer :');
  info(`  schtasks /Run /TN "${NOM}"`);
  note('Pour vérifier : npm run service -- status');
} catch (err) {
  console.log();
  ko(err.message);
  process.exit(1);
}
