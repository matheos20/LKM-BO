#!/usr/bin/env node
/**
 * Sauvegarde et remise en place de la base.
 *
 *   npm run backup                      écrit une sauvegarde
 *   npm run backup -- list              ce qui existe déjà
 *   npm run backup -- restore <nom>     montre ce qui se passerait
 *   npm run backup -- restore <nom> --yes   remplace la base par cette sauvegarde
 *
 * Deux règles, comme ailleurs dans ce dépôt : rien ne s'écrase sans « --yes », et le
 * résultat se raconte. Une restauration prend d'abord une sauvegarde de l'état courant :
 * se tromper de fichier ne doit pas être définitif.
 */
import { config } from '../src/config.js';
import { backupDatabase, findMysqlTool, listDbBackups, restoreDatabase } from '../src/services/dbBackup.js';

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
const mo = (o) => `${(o / 1048576).toFixed(2)} Mo`;
/** Les serveurs sont en UTC, l'agent est à UTC+3 : la date affichée est la sienne. */
const local = (ms) => new Date(ms).toLocaleString('fr-FR');

const [, , commande = 'write', ...reste] = process.argv;
const options = Object.fromEntries(reste.filter((a) => a.startsWith('--')).map((a) => [a.slice(2).split('=')[0], a.includes('=') ? a.split('=')[1] : true]));
const positionnels = reste.filter((a) => !a.startsWith('--'));

const { dir, keep, secret, mysqldump, mysqlClient } = config.backup;

function afficherListe() {
  const toutes = listDbBackups(dir);
  if (!toutes.length) { note(`aucune sauvegarde dans ${dir}`); return toutes; }
  for (const b of toutes) {
    info(`${b.name.padEnd(30)} ${local(b.at).padEnd(20)} ${String(mo(b.bytes)).padStart(10)}${b.encrypted ? `  ${gris('chiffrée')}` : ''}`);
  }
  note(`${toutes.length} sauvegarde(s), ${keep} conservée(s)`);
  return toutes;
}

try {
  if (commande === 'list') {
    titre('Sauvegardes de la base');
    afficherListe();
    process.exit(0);
  }

  if (commande === 'restore') {
    const nom = positionnels[0];
    titre('Remise en place de la base');
    if (!nom) {
      ko('indiquez le nom d’une sauvegarde');
      console.log();
      afficherListe();
      process.exit(1);
    }
    info(`sauvegarde : ${gras(nom)}`);
    info(`cible      : ${config.mysql.user}@${config.mysql.host}:${config.mysql.port}/${gras(config.mysql.database)}`);
    console.log();
    note('TOUT ce que la base contient aujourd’hui sera remplacé par l’état de cette');
    note('sauvegarde. Une sauvegarde de l’état courant est prise avant, automatiquement.');
    if (!options.yes) {
      console.log();
      info(`${orange('Rien n’a été remplacé.')} Ajoutez ${gras('--yes')} pour remettre en place.`);
      process.exit(0);
    }
    console.log();
    const r = restoreDatabase({
      dir, name: nom, mysql: config.mysql, secret, confirm: true, mysqldump, mysqlClient,
    });
    ok(`base remise dans l’état de ${r.restored} (${(r.ms / 1000).toFixed(1)} s)`);
    if (r.safetyBackup) note(`l’état précédent est conservé dans ${r.safetyBackup}`);
    process.exit(0);
  }

  // Par défaut : écrire une sauvegarde.
  titre('Sauvegarde de la base');
  const outil = findMysqlTool('mysqldump', mysqldump);
  if (!outil) {
    ko('mysqldump est introuvable');
    note('Indiquez son chemin dans .env : MYSQLDUMP_PATH=C:/xampp/mysql/bin/mysqldump.exe');
    process.exit(1);
  }
  info(`source : ${config.mysql.user}@${config.mysql.host}:${config.mysql.port}/${gras(config.mysql.database)}`);
  info(`outil  : ${gris(outil)}`);
  info(`dossier: ${dir}`);
  if (!secret) note('sans clé de chiffrement : la sauvegarde reste en clair (BACKUP_SECRET)');
  console.log();

  const r = backupDatabase({ dir, mysql: config.mysql, keep, secret, mysqldump });
  ok(`${r.name} — ${mo(r.bytes)} en ${(r.ms / 1000).toFixed(1)} s${r.encrypted ? ', chiffrée' : ''}`);
  if (r.removed.length) note(`${r.removed.length} ancienne(s) effacée(s) : ${r.removed.join(', ')}`);
  console.log();
  afficherListe();
  process.exit(0);
} catch (err) {
  console.log();
  ko(err.message);
  process.exit(1);
}
