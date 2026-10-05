// Les thématiques en base de données.
//
//   npm run thematiques list
//   npm run thematiques import                     — les sept CSV de thematiques/
//   npm run thematiques harvest <serveur> [n]      — complète icônes et descriptions
//                                                     depuis les sites du parc
//   npm run thematiques show <clé> <langue>
//
// POURQUOI UN IMPORT, ET PAS UNE LECTURE DIRECTE DES CSV. Une liste en fichiers se
// corrige en modifiant le code et se relit à chaque écran ; en base, elle se corrige
// seule et se lit d'une requête. Les CSV restent la source d'origine, rien de plus.
//
// POURQUOI UNE « MOISSON » SÉPARÉE. Les CSV donnent le sujet et les noms de rubriques,
// mais pas l'icône ni la description — or chaque rubrique d'un site du parc en porte
// une. Mesuré sur 60 sites de vps-004 le 05/10/2026 : l'icône est identique d'un site à
// l'autre dans 100 % des cas pour la plupart des rubriques, et la description dépend du
// SUJET (« actu » en a douze variantes, une par thématique). La moisson va donc les
// chercher là où elles existent, et ne remplace jamais une valeur déjà remplie.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config, loadServers } from '../src/config.js';
import { closeMysql, openMysql } from '../src/db/mysql.js';
import {
  LANGUES,
  cleThematique,
  enrichirRubriques,
  findThematique,
  listThematiques,
  statsThematiques,
  upsertThematique,
} from '../src/db/thematiques.js';
import { slugify } from '../src/services/categoryService.js';
import { lireCsvThematiques, nomRubrique } from '../src/services/thematiqueCsv.js';
import { KnownHosts } from '../src/ssh/knownHosts.js';
import { SshManager } from '../src/ssh/SshManager.js';
import { SiteService } from '../src/services/siteService.js';
import { CATEGORY_DETAILS } from '../src/services/phpScripts.js';

openMysql(config.mysql);

const [commande, ...args] = process.argv.slice(2);
const DOSSIER = path.join(ROOT, 'thematiques');

async function importer() {
  if (!fs.existsSync(DOSSIER)) {
    console.error(`✖ Dossier introuvable : ${DOSSIER}`);
    return 1;
  }
  let sujets = 0;
  let rubriques = 0;

  for (const langue of LANGUES) {
    const fichier = path.join(DOSSIER, `thematiques ${langue}.csv`);
    if (!fs.existsSync(fichier)) {
      console.log(`  ${langue} : fichier absent, ignoré`);
      continue;
    }
    const lus = lireCsvThematiques(fs.readFileSync(fichier, 'utf8'));
    let n = 0;
    for (const [i, sujet] of lus.entries()) {
      const vues = new Set();
      const menu = [];
      for (const nom of sujet.rubriques) {
        const slug = slugify(nom);
        if (!slug || vues.has(slug)) continue;
        vues.add(slug);
        menu.push({ slug, name: nomRubrique(nom), icon: '', description: '' });
      }
      if (!menu.length) continue;
      await upsertThematique({
        key: cleThematique(sujet.label),
        lang: langue,
        label: sujet.label,
        position: i,
        source: 'csv',
        rubriques: menu,
      });
      n += 1;
      rubriques += menu.length;
    }
    sujets += n;
    console.log(`  ${langue} : ${n} thématique(s), ${lus.reduce((a, s) => a + s.rubriques.length, 0)} entrée(s) de menu`);
  }

  const s = await statsThematiques();
  console.log(`\n✔ ${sujets} thématique(s) importée(s), ${rubriques} rubrique(s).`);
  console.log(`  en base : ${s.thematiques} thématiques · ${s.langues} langues · ${s.rubriques} rubriques`);
  if (s.sansIcone) console.log(`  ${s.sansIcone} rubrique(s) sans icône et ${s.sansDescription} sans description — lancez « harvest ».`);
  return 0;
}

/**
 * Va chercher icônes et descriptions sur les sites du parc.
 *
 * Elle lit, elle n'écrit rien sur les serveurs. Pour chaque site, elle relève le jeu de
 * rubriques et, s'il correspond EXACTEMENT au menu d'une thématique connue, elle retient
 * ses icônes et descriptions. La valeur retenue est la plus fréquente : un site mal
 * rempli ne doit pas imposer son icône à toute la thématique.
 */
async function moissonner(serverId, combien) {
  const servers = loadServers();
  const server = servers.find((s) => s.id === serverId);
  if (!server) {
    console.error(`✖ Serveur inconnu : ${serverId}. Connus : ${servers.map((s) => s.id).join(', ')}`);
    return 1;
  }

  const ssh = new SshManager(servers, { knownHosts: new KnownHosts(config.knownHostsFile), settings: config.ssh });
  const sites = new SiteService(ssh);
  try {
    await ssh.connect(serverId);
    const { stdout } = await ssh.exec(
      serverId,
      `find ${JSON.stringify(server.wwwRoot)} -mindepth 1 -maxdepth 1 -printf '%f\\n' | grep -E '^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}$' | shuf -n ${Number(combien) || 200}`,
      { timeout: 90000 },
    );
    const domaines = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    console.log(`  ${domaines.length} site(s) lus sur ${serverId}…`);

    const out = await sites.runPhp(
      serverId,
      server.wwwRoot,
      CATEGORY_DETAILS,
      { LKM_ROOT: server.wwwRoot, LKM_B64: Buffer.from(JSON.stringify(domaines), 'utf8').toString('base64') },
      { timeout: 300000 },
    );

    // Les thématiques connues, indexées par leur signature de rubriques.
    const connues = new Map();
    for (const t of await listThematiques()) {
      connues.set(t.rubriques.map((r) => r.slug).sort().join(','), t);
    }

    // Pour chaque thématique : par rubrique, les icônes et descriptions rencontrées.
    const votes = new Map();
    let reconnus = 0;
    for (const site of out.sites ?? []) {
      const sig = (site.items ?? []).map((i) => i.slug).sort().join(',');
      const them = connues.get(sig);
      if (!them) continue;
      reconnus += 1;
      if (!votes.has(them.id)) votes.set(them.id, { them, parSlug: new Map() });
      const { parSlug } = votes.get(them.id);
      for (const it of site.items) {
        if (!parSlug.has(it.slug)) parSlug.set(it.slug, { icon: new Map(), desc: new Map(), nom: new Map() });
        const e = parSlug.get(it.slug);
        if (it.icon) e.icon.set(it.icon, (e.icon.get(it.icon) ?? 0) + 1);
        if (it.description) e.desc.set(it.description, (e.desc.get(it.description) ?? 0) + 1);
        if (it.name) e.nom.set(it.name, (e.nom.get(it.name) ?? 0) + 1);
      }
    }

    const majoritaire = (m) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    let touchees = 0;
    for (const { them, parSlug } of votes.values()) {
      const valeurs = {};
      for (const [slug, e] of parSlug) {
        valeurs[slug] = { icon: majoritaire(e.icon), description: majoritaire(e.desc), name: majoritaire(e.nom) };
      }
      // Les noms ne sont reecrits que si personne n'a retouche cette thematique.
      const n = await enrichirRubriques(them.id, valeurs, { noms: them.source === 'csv' });
      touchees += n;
      console.log(`  ${them.label} (${them.lang}) : ${n} rubrique(s) complétée(s)`);
    }

    const s = await statsThematiques();
    console.log(`\n✔ ${reconnus} site(s) reconnus, ${touchees} rubrique(s) complétée(s).`);
    console.log(`  reste sans icône : ${s.sansIcone} · sans description : ${s.sansDescription}`);
    return 0;
  } finally {
    ssh.closeAll();
  }
}

try {
  let code = 0;
  switch (commande) {
    case 'list': {
      const tout = await listThematiques({ lang: args[0] ?? '' });
      const s = await statsThematiques();
      console.log(`${tout.length} thématique(s) · ${s.rubriques} rubriques · ${s.sansIcone} sans icône\n`);
      let langue = null;
      for (const t of tout) {
        if (t.lang !== langue) { langue = t.lang; console.log(`── ${langue} ──`); }
        const menu = t.rubriques.map((r) => `${r.icon || '·'} ${r.name}`).join(', ');
        console.log(`  ${t.label.padEnd(24)} ${String(t.rubriques.length).padStart(2)} rubriques  ${menu.slice(0, 96)}`);
      }
      break;
    }
    case 'show': {
      const t = await findThematique(args[0], args[1]);
      if (!t) { console.error(`✖ Inconnue : ${args[0]} / ${args[1]}`); code = 1; break; }
      console.log(`${t.label} (${t.lang}) — clé « ${t.key} », ${t.rubriques.length} rubriques`);
      for (const r of t.rubriques) {
        console.log(`  ${(r.icon || ' ').padEnd(3)} ${r.slug.padEnd(22)} ${r.name.padEnd(22)} ${r.description}`);
      }
      break;
    }
    case 'import':
      code = await importer();
      break;
    case 'harvest':
      if (!args[0]) { console.error('✖ Usage : npm run thematiques harvest <serveur> [nombre de sites]'); code = 1; break; }
      code = await moissonner(args[0], args[1]);
      break;
    default:
      console.log('Usage :');
      console.log('  npm run thematiques list [langue]');
      console.log('  npm run thematiques import');
      console.log('  npm run thematiques harvest <serveur> [nombre de sites]');
      console.log('  npm run thematiques show <clé> <langue>');
      code = commande ? 1 : 0;
  }
  await closeMysql();
  process.exit(code);
} catch (err) {
  console.error(`✖ ${err.message}`);
  await closeMysql();
  process.exit(1);
}
