#!/usr/bin/env node
/**
 * Outil en ligne de commande pour le module Cloudflare.
 *
 *   npm run cf -- <commande> [options]
 *
 * Deux règles tiennent tout le reste :
 *
 *   1. RIEN NE S'ÉCRIT SANS DEMANDE EXPLICITE. Ces domaines sont en production. Toute
 *      commande qui modifie quoi que ce soit chez Cloudflare montre d'abord ce qu'elle
 *      ferait, et ne le fait qu'avec « --yes ». Purger le cache de quarante mille sites
 *      par inadvertance ne doit pas être à une faute de frappe près.
 *
 *   2. AUCUN SECRET NE S'AFFICHE. Ni dans une sortie, ni dans une erreur, ni dans un
 *      journal. Les identifiants de compte et de zone sont tronqués.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../src/config.js';
import { closeDatabase, getDb, openDatabase } from '../src/db/database.js';
import { analyzeCsv, cloudflareStats, deriveMissingEmails, importCsv } from '../src/services/cloudflareImport.js';
import { redact } from '../src/services/cloudflareClient.js';
import {
  SECURITY_LEVELS, SSL_MODES, createDnsRecord, deleteDnsRecord, findZoneByName, getSettings,
  getZone, listDnsRecords, purgeMany, setAlwaysUseHttpsMany, setSslModeMany,
} from '../src/services/cloudflareOps.js';

// ───────────────────────── Mise en forme ─────────────────────────

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
const nombre = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const court = (id) => (id ? `${String(id).slice(0, 8)}…` : '—');

/** Une barre de progression tenue sur une seule ligne. */
function progression(fait, total, suffixe = '') {
  if (!process.stdout.isTTY) return;
  const largeur = 28;
  const part = total ? fait / total : 0;
  const plein = Math.round(part * largeur);
  process.stdout.write(`\r  [${'█'.repeat(plein)}${'·'.repeat(largeur - plein)}] ${String(Math.round(part * 100)).padStart(3)} %  ${fait}/${total} ${suffixe}   `);
  if (fait >= total) process.stdout.write('\n');
}

// ───────────────────────── Arguments ─────────────────────────

function lireArguments(argv) {
  const options = {};
  const positionnels = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { positionnels.push(a); continue; }
    const [nom, valeurCollee] = a.slice(2).split('=');
    const suivant = argv[i + 1];
    if (valeurCollee !== undefined) options[nom] = valeurCollee;
    else if (suivant && !suivant.startsWith('--')) { options[nom] = suivant; i += 1; }
    else options[nom] = true;
  }
  return { options, positionnels };
}

// ───────────────────────── Accès à la base ─────────────────────────

/**
 * Les cibles d'une commande : domaines nommés, ou tous, avec leurs accès.
 * Un domaine sans identifiant de zone ou sans accès utilisable est écarté ICI, avec
 * son motif — plutôt que d'échouer plus tard, un appel et un quota plus loin.
 */
function cibles({ domains = [], all = false, limit = 0 }) {
  const db = getDb();
  const base = `SELECT z.domain, z.zone_id, a.account_id, a.email, a.global_api_key, a.api_token
                FROM cf_zones z JOIN cf_accounts a ON a.id = z.account_ref`;
  // La limite porte sur les domaines UTILISABLES, pas sur les lignes lues. Appliquée à
  // la requête, elle tombait sur les premiers par ordre alphabétique — tous sans accès
  // — et « verify --limit 6 » ne vérifiait rien du tout.
  const lignes = all
    ? db.prepare(`${base} ORDER BY z.domain`).all()
    : domains.map((d) => db.prepare(`${base} WHERE z.domain = ?`).get(String(d).trim().toLowerCase())).filter(Boolean);

  const pretes = [];
  const ecartees = [];
  const demandes = new Set(domains.map((d) => String(d).trim().toLowerCase()));
  for (const l of lignes) {
    if (!l.zone_id) { ecartees.push({ domain: l.domain, reason: 'identifiant de zone inconnu' }); continue; }
    if (!l.api_token && !l.email) { ecartees.push({ domain: l.domain, reason: 'clé globale sans e-mail' }); continue; }
    if (!l.api_token && !l.global_api_key) { ecartees.push({ domain: l.domain, reason: 'aucun accès' }); continue; }
    pretes.push({
      domain: l.domain,
      zoneId: l.zone_id,
      accountId: l.account_id,
      creds: l.api_token ? { apiToken: l.api_token } : { globalApiKey: l.global_api_key, email: l.email },
    });
  }
  for (const d of demandes) if (!lignes.some((l) => l.domain === d)) ecartees.push({ domain: d, reason: 'absent de la base' });
  const borne = Number(limit) || 0;
  return { pretes: borne ? pretes.slice(0, borne) : pretes, ecartees, prets: pretes.length };
}

/** Les domaines donnés en ligne de commande, ou lus dans un fichier. */
function domainesDemandes(positionnels, options) {
  const liste = [...positionnels];
  if (options.file) {
    const texte = readFileSync(options.file, 'utf8');
    liste.push(...texte.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
  }
  return liste;
}

/** Montre ce qui va se passer, et s'arrête là si « --yes » n'a pas été donné. */
function confirme(options, quoi, pretes, ecartees) {
  titre(quoi);
  info(`${gras(nombre(pretes.length))} domaine(s) concerné(s)`);
  for (const p of pretes.slice(0, 8)) note(`• ${p.domain}  ${gris(`zone ${court(p.zoneId)}`)}`);
  if (pretes.length > 8) note(`… et ${nombre(pretes.length - 8)} autre(s)`);

  if (ecartees.length) {
    console.log();
    info(`${orange(nombre(ecartees.length))} écarté(s) :`);
    const motifs = new Map();
    for (const e of ecartees) motifs.set(e.reason, (motifs.get(e.reason) ?? 0) + 1);
    for (const [m, n] of motifs) note(`• ${n} — ${m}`);
  }

  if (!pretes.length) { console.log(); ko('aucun domaine utilisable : rien à faire.'); return false; }
  if (options.yes) return true;
  console.log();
  info(`${orange('Rien n’a été modifié.')} Ajoutez ${gras('--yes')} pour exécuter.`);
  return false;
}

/** Imprime le relevé d'une opération de masse. */
function releve(r) {
  console.log();
  info(`${vert(nombre(r.succeeded))} réussi(s), ${r.failed ? rouge(nombre(r.failed)) : nombre(0)} en échec, sur ${nombre(r.total)}`);
  const rates = r.results.filter((x) => !x.ok);
  if (rates.length) {
    const motifs = new Map();
    for (const x of rates) motifs.set(x.error, (motifs.get(x.error) ?? 0) + 1);
    console.log();
    info('Motifs d’échec :');
    for (const [m, n] of [...motifs].sort((a, b) => b[1] - a[1]).slice(0, 8)) note(`• ${n}× ${m}`);
    console.log();
    note('Les dix premiers domaines en échec :');
    for (const x of rates.slice(0, 10)) note(`  ${x.domain} — ${x.error}`);
  }
  return r.failed ? 1 : 0;
}

// ───────────────────────── Commandes ─────────────────────────

const commandes = {
  async import(positionnels, options) {
    const fichier = positionnels[0] ?? 'dataCF.csv';
    const texte = readFileSync(fichier, 'utf8');

    titre(`Import de ${basename(fichier)}`);
    const a = analyzeCsv(texte);
    if (a.missingColumns.length) { ko(`colonnes absentes : ${a.missingColumns.join(', ')}`); return 1; }

    info(`colonnes : ${a.columns.join(gris(' | '))}`);
    info(`${nombre(a.rowsRead)} ligne(s) lue(s)${a.malformed ? `, ${orange(nombre(a.malformed))} mal formée(s)` : ''}`);
    info(`${vert(nombre(a.valid))} retenue(s) → ${nombre(a.domains)} domaine(s), ${nombre(a.accounts)} compte(s)`);
    if (a.withoutZone) info(`${orange(nombre(a.withoutZone))} sans identifiant de zone ${gris('(« cf verify » saura les retrouver)')}`);
    if (a.duplicates) info(`${nombre(a.duplicates)} doublon(s)${a.conflicts ? `, dont ${orange(nombre(a.conflicts))} divergent(s)` : ''}`);
    if (a.skipped) {
      console.log();
      info(`${orange(nombre(a.skipped))} ligne(s) écartée(s) :`);
      for (const [motif, n] of Object.entries(a.reasons).sort((x, y) => y[1] - x[1])) note(`• ${String(n).padStart(6)}  ${motif}`);
      note('exemples :');
      for (const s of a.samples) note(`  ligne ${s.line} : « ${s.domain || '(vide)'} » — ${s.reason}`);
    }

    if (!options.yes) { console.log(); info(`${orange('Rien n’a été écrit.')} Ajoutez ${gras('--yes')} pour importer.`); return 0; }

    console.log();
    const r = importCsv(texte, { source: basename(fichier), onProgress: (n, t) => progression(n, t, 'lignes') });
    progression(a.rowsRead, a.rowsRead, 'lignes');
    ok(`${nombre(r.accountsAdded)} compte(s) créé(s), ${nombre(r.zonesAdded)} zone(s) créée(s), ${nombre(r.zonesUpdated)} mise(s) à jour`);

    const s = cloudflareStats();
    if (s.accounts && !s.accountsWithEmail && !s.accountsWithToken) {
      console.log();
      info(orange('À SAVOIR'));
      note('Aucun compte ne porte d’e-mail ni de jeton d’API.');
      note('Cloudflare refuse une clé globale présentée sans l’e-mail du titulaire');
      note('(erreur 9106). Aucune opération ne fonctionnera tant que l’un ou l’autre');
      note('ne sera pas renseigné : « npm run cf -- email <compte> <adresse> ».');
    }
    return 0;
  },

  async stats() {
    const s = cloudflareStats();
    titre('État du module Cloudflare');
    info(`comptes : ${gras(nombre(s.accounts))}`);
    note(`avec e-mail : ${s.accountsWithEmail ? vert(nombre(s.accountsWithEmail)) : rouge('0')}   avec jeton : ${s.accountsWithToken ? vert(nombre(s.accountsWithToken)) : '0'}`);
    info(`zones   : ${gras(nombre(s.zones))}`);
    note(`avec identifiant : ${nombre(s.zonesWithId)}   sans : ${s.zones - s.zonesWithId}`);
    const utilisables = cibles({ all: true }).pretes.length;
    console.log();
    info(`${utilisables ? vert(nombre(utilisables)) : rouge('0')} domaine(s) prêt(s) à recevoir une commande`);
    if (s.lastImport) {
      console.log();
      note(`dernier import : ${new Date(s.lastImport.at).toLocaleString('fr-FR')} — ${s.lastImport.source}`);
      note(`${nombre(s.lastImport.rows_read)} lignes lues, ${nombre(s.lastImport.zones_added)} zones créées, ${nombre(s.lastImport.skipped)} écartées`);
    }
    return 0;
  },

  async email(positionnels, options) {
    const [compte, adresse] = positionnels;
    titre('Adresse des comptes Cloudflare');

    // La dérivation : l'adresse se déduit du domaine, « 201eat.com@linkuma.co ».
    if (options.derive || compte === '--derive') {
      const emailDomain = typeof options.derive === 'string' ? options.derive : config.cloudflare.emailDomain;
      const apercu = deriveMissingEmails(emailDomain, { dryRun: true });
      info(`${gras(nombre(apercu.candidates))} compte(s) sans adresse, à compléter en « <domaine>@${emailDomain} »`);
      for (const c of apercu.samples) note(`• ${c.domain} → ${c.email}`);
      if (!apercu.candidates) { ok('aucun compte à compléter.'); return 0; }
      if (!options.yes) { console.log(); info(`${orange('Rien n’a été modifié.')} Ajoutez ${gras('--yes')}.`); return 0; }
      const r = deriveMissingEmails(emailDomain);
      ok(`${nombre(r.updated)} compte(s) complété(s)`);
      note('Vérifiez maintenant les accès : npm run cf -- verify --limit 20');
      return 0;
    }

    if (!compte || !adresse) {
      ko('usage : npm run cf -- email <account_id|domaine> <adresse>');
      note('   ou : npm run cf -- email --derive --yes   (déduit l’adresse du domaine)');
      note('Une clé globale ne fonctionne qu’avec l’e-mail du titulaire du compte.');
      return 1;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adresse)) { ko(`adresse invalide : ${adresse}`); return 1; }

    const db = getDb();
    const ligne = db.prepare('SELECT a.id FROM cf_accounts a LEFT JOIN cf_zones z ON z.account_ref = a.id WHERE a.account_id = ? OR z.domain = ? LIMIT 1').get(compte, compte.toLowerCase());
    if (!ligne) { ko(`ni compte ni domaine connu : ${compte}`); return 1; }
    db.prepare('UPDATE cf_accounts SET email = ?, updated_at = ? WHERE id = ?').run(adresse, Date.now(), ligne.id);
    ok(`compte mis à jour : ${adresse}`);
    return 0;
  },

  async verify(positionnels, options) {
    const demandes = domainesDemandes(positionnels, options);
    const { pretes, ecartees } = cibles({ domains: demandes, all: !demandes.length, limit: options.limit ?? 20 });
    titre('Vérification des accès');
    if (ecartees.length) info(`${orange(nombre(ecartees.length))} domaine(s) écarté(s) avant tout appel`);
    if (!pretes.length) { ko('aucun domaine vérifiable.'); return 1; }

    info(`${nombre(pretes.length)} domaine(s) à vérifier ${gris('(lecture seule)')}`);
    console.log();
    const db = getDb();
    let bons = 0;
    for (const [i, cible] of pretes.entries()) {
      try {
        const z = await getZone(cible.zoneId, cible.creds);
        db.prepare('UPDATE cf_zones SET status = ?, plan = ?, name_servers = ?, checked_at = ? WHERE domain = ?')
          .run(z.status, z.plan, (z.nameServers ?? []).join(' '), Date.now(), cible.domain);
        db.prepare('UPDATE cf_accounts SET verified_at = ?, last_error = \'\' WHERE account_id = ?').run(Date.now(), cible.accountId);
        ok(`${cible.domain.padEnd(34)} ${z.status.padEnd(10)} ${gris(z.plan)}`);
        bons += 1;
      } catch (err) {
        // Un identifiant de zone perime se rattrape : l'API sait retrouver la zone par
        // son nom. On ne renonce donc qu'apres avoir essaye ce chemin.
        let rattrape = false;
        try {
          const trouvee = await findZoneByName(cible.domain, cible.creds, { retries: 0 });
          if (trouvee?.id) {
            db.prepare('UPDATE cf_zones SET zone_id = ?, status = ?, checked_at = ?, updated_at = ? WHERE domain = ?')
              .run(trouvee.id, trouvee.status ?? '', Date.now(), Date.now(), cible.domain);
            ok(`${cible.domain.padEnd(34)} ${String(trouvee.status ?? '').padEnd(10)} ${gris('zone retrouvee et corrigee')}`);
            bons += 1;
            rattrape = true;
          }
        } catch { /* le rattrapage a echoue aussi : on dira l'erreur d'origine */ }
        if (!rattrape) {
          db.prepare('UPDATE cf_accounts SET last_error = ? WHERE account_id = ?').run(redact(err.message).slice(0, 300), cible.accountId);
          ko(`${cible.domain.padEnd(34)} ${redact(err.message)}`);
        }
      }
      if (!process.stdout.isTTY) void i;
    }
    console.log();
    info(`${vert(nombre(bons))} accès valide(s) sur ${nombre(pretes.length)}`);
    return bons === pretes.length ? 0 : 1;
  },

  async purge(positionnels, options) {
    const demandes = domainesDemandes(positionnels, options);
    if (!demandes.length && !options.all) { ko('indiquez des domaines, ou --all, ou --file <liste>'); return 1; }
    const { pretes, ecartees } = cibles({ domains: demandes, all: Boolean(options.all), limit: options.limit ?? 0 });

    const urls = options.url ? [].concat(options.url) : [];
    const quoi = urls.length ? `Purge de ${urls.length} adresse(s)` : 'Purge COMPLÈTE du cache';
    if (!confirme(options, quoi, pretes, ecartees)) return pretes.length ? 0 : 1;
    if (!urls.length) { console.log(); note('Tout purger fait repartir le cache de zéro : pointe de charge sur l’origine,'); note('et quelques minutes plus lentes pour les visiteurs.'); }

    console.log();
    const r = await purgeMany(pretes, urls.length ? { files: urls } : { everything: true }, {
      concurrency: Number(options.concurrency ?? 6),
      onItem: (_s, fait, total) => progression(fait, total, 'domaines'),
    });
    return releve(r);
  },

  async ssl(positionnels, options) {
    const [mode, ...reste] = positionnels;
    if (!SSL_MODES.includes(String(mode))) { ko(`mode attendu parmi : ${SSL_MODES.join(', ')}`); return 1; }
    const demandes = domainesDemandes(reste, options);
    const { pretes, ecartees } = cibles({ domains: demandes, all: Boolean(options.all), limit: options.limit ?? 0 });
    if (!confirme(options, `Mode SSL/TLS → ${gras(mode)}`, pretes, ecartees)) return pretes.length ? 0 : 1;
    if (mode === 'off') { console.log(); note(orange('« off » laisse le trafic en clair entre le visiteur et Cloudflare.')); }

    console.log();
    const r = await setSslModeMany(pretes, mode, {
      concurrency: Number(options.concurrency ?? 6),
      onItem: (_s, fait, total) => progression(fait, total, 'domaines'),
    });
    return releve(r);
  },

  async https(positionnels, options) {
    const [etat, ...reste] = positionnels;
    if (!['on', 'off'].includes(String(etat))) { ko('usage : npm run cf -- https on|off <domaines…>'); return 1; }
    const demandes = domainesDemandes(reste, options);
    const { pretes, ecartees } = cibles({ domains: demandes, all: Boolean(options.all), limit: options.limit ?? 0 });
    if (!confirme(options, `Redirection HTTP → HTTPS : ${gras(etat)}`, pretes, ecartees)) return pretes.length ? 0 : 1;

    console.log();
    const r = await setAlwaysUseHttpsMany(pretes, etat === 'on', {
      concurrency: Number(options.concurrency ?? 6),
      onItem: (_s, fait, total) => progression(fait, total, 'domaines'),
    });
    return releve(r);
  },

  async settings(positionnels) {
    const [domaine] = positionnels;
    if (!domaine) { ko('usage : npm run cf -- settings <domaine>'); return 1; }
    const { pretes, ecartees } = cibles({ domains: [domaine] });
    if (!pretes.length) { ko(`${domaine} : ${ecartees[0]?.reason ?? 'introuvable'}`); return 1; }

    const cible = pretes[0];
    titre(`Réglages de ${cible.domain}`);
    const z = await getZone(cible.zoneId, cible.creds);
    info(`état : ${z.status}   offre : ${z.plan}   ${z.paused ? orange('zone en pause') : ''}`);
    note(`serveurs de noms : ${(z.nameServers ?? []).join(', ') || '—'}`);

    const s = await getSettings(cible.zoneId, cible.creds);
    console.log();
    const lignes = [
      ['Mode SSL/TLS', s.ssl],
      ['Toujours HTTPS', s.always_use_https],
      ['Mode développement', s.development_mode],
      ['Niveau de sécurité', s.security_level],
      ['Cache navigateur', s.browser_cache_ttl ? `${s.browser_cache_ttl} s` : '—'],
      ['Minification', s.minify ? Object.entries(s.minify).map(([k, v]) => `${k}:${v}`).join(' ') : '—'],
      ['HTTP/3', s.http3],
      ['TLS minimum', s.min_tls_version],
    ];
    for (const [nom, valeur] of lignes) info(`${nom.padEnd(22)} ${gras(valeur ?? '—')}`);
    return 0;
  },

  async dns(positionnels, options) {
    const [action, domaine, ...reste] = positionnels;
    if (!domaine) { ko('usage : npm run cf -- dns list|add|del <domaine> […]'); return 1; }
    const { pretes, ecartees } = cibles({ domains: [domaine] });
    if (!pretes.length) { ko(`${domaine} : ${ecartees[0]?.reason ?? 'introuvable'}`); return 1; }
    const cible = pretes[0];

    if (action === 'list' || !action) {
      titre(`DNS de ${cible.domain}`);
      const records = await listDnsRecords(cible.zoneId, cible.creds);
      if (!records.length) { note('aucun enregistrement'); return 0; }
      for (const r of records) {
        info(`${r.type.padEnd(6)} ${r.name.padEnd(36)} ${r.content.slice(0, 48).padEnd(50)} ${r.proxied ? vert('relayé') : gris('direct')}`);
      }
      note(`${records.length} enregistrement(s)`);
      return 0;
    }

    if (action === 'add') {
      const [type, nom, valeur] = reste;
      const record = { type, name: nom, content: valeur, ttl: Number(options.ttl ?? 1), proxied: Boolean(options.proxied), priority: options.priority };
      titre(`Ajout DNS sur ${cible.domain}`);
      info(`${type} ${nom} → ${valeur}${options.proxied ? ' (relayé)' : ''}`);
      if (!options.yes) { console.log(); info(`${orange('Rien n’a été créé.')} Ajoutez ${gras('--yes')}.`); return 0; }
      const r = await createDnsRecord(cible.zoneId, record, cible.creds);
      ok(`créé : ${r.id}`);
      return 0;
    }

    if (action === 'del') {
      const [recordId] = reste;
      if (!recordId) { ko('indiquez l’identifiant de l’enregistrement (voir « dns list »)'); return 1; }
      titre(`Suppression DNS sur ${cible.domain}`);
      info(`enregistrement ${recordId}`);
      if (!options.yes) { console.log(); info(`${orange('Rien n’a été supprimé.')} Ajoutez ${gras('--yes')}.`); return 0; }
      await deleteDnsRecord(cible.zoneId, recordId, cible.creds);
      ok('supprimé');
      return 0;
    }

    ko(`action inconnue : ${action}`);
    return 1;
  },

  async help() {
    console.log(`
${gras('Module Cloudflare — LKM-BO')}

  ${gras('npm run cf --')} ${vert('<commande>')} [options]

${gras('Données')}
  import [fichier]          lit un export CSV ${gris('(dataCF.csv par défaut)')} et le résume
  stats                     ce que la base contient aujourd'hui
  email --derive            déduit l'adresse du domaine ${gris('(<domaine>@linkuma.co)')}
  email <compte> <adresse>  renseigne l'adresse d'un seul compte
  verify [domaines…]        vérifie les accès ${gris('(lecture seule, 20 domaines par défaut)')}

${gras('Opérations')}
  purge <domaines…>         vide le cache ${gris('(--url pour une adresse précise)')}
  ssl <mode> <domaines…>    ${SSL_MODES.join(' | ')}
  https on|off <domaines…>  redirection HTTP vers HTTPS
  settings <domaine>        tous les réglages d'une zone
  dns list|add|del <domaine>

${gras('Options')}
  --yes                     exécute pour de bon ${orange('(sans elle, rien n’est modifié)')}
  --all                     tous les domaines de la base
  --file <liste.txt>        un domaine par ligne
  --limit <n>               borne le nombre de domaines
  --concurrency <n>         appels simultanés ${gris('(6 par défaut)')}

${gras('Exemples')}
  npm run cf -- import dataCF.csv --yes
  npm run cf -- verify 201eat.com
  npm run cf -- purge 201eat.com --yes
  npm run cf -- purge --all --limit 50 --yes
  npm run cf -- ssl strict --file prod.txt --yes
  npm run cf -- https on 201eat.com --yes

${gris(`Niveaux de sécurité : ${SECURITY_LEVELS.join(', ')}`)}
`);
    return 0;
  },
};

// ───────────────────────── Entrée ─────────────────────────

const [, , nomCommande = 'help', ...reste] = process.argv;
const { options, positionnels } = lireArguments(reste);
const commande = commandes[nomCommande] ?? commandes.help;

openDatabase(config.dbFile);
let code = 0;
try {
  code = await commande(positionnels, options);
} catch (err) {
  console.log();
  ko(redact(err.message));
  if (err.code === 9106) note('Renseignez l’e-mail du compte : npm run cf -- email <domaine> <adresse>');
  if (process.env.DEBUG) console.error(err);
  code = 1;
} finally {
  closeDatabase();
}
process.exit(code);
