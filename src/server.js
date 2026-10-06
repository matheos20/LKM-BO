import path from 'node:path';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { ROOT, assertStartupConfig, config, loadServers } from './config.js';
import { AppError } from './errors.js';
import { loadLocales, watchLocales } from './i18n.js';
import { closeMysql, exec as mysqlExec, openMysql, prepare as mysqlPrepare } from './db/mysql.js';
import { migrateMysql, seedSystemRolesMysql } from './db/mysqlSchema.js';
import { PERMISSION_KEYS, SYSTEM_ROLES } from './auth/permissions.js';
import { MysqlSessionStore } from './db/sessionStore.js';
import { bootstrapAdmin } from './auth/authService.js';
import { KnownHosts } from './ssh/knownHosts.js';
import { SshManager } from './ssh/SshManager.js';
import { DomainService } from './services/domainService.js';
import { FileService } from './services/fileService.js';
import { SiteService } from './services/siteService.js';
import { TranslationService } from './services/translationService.js';
import { CategoryService } from './services/categoryService.js';
import { RedirectService } from './services/redirectService.js';
import { SearchService } from './services/searchService.js';
import { CloudflareService } from './services/cloudflareService.js';
import { createAudit } from './services/audit.js';
import { startBackupSchedule } from './services/backupSchedule.js';
import { HealthService } from './services/healthService.js';
import { ServerLoad } from './services/serverLoad.js';
import { ReputationService } from './services/reputationService.js';
import { ServerStateService } from './services/serverStateService.js';
import { UrlCheckService } from './services/urlCheckService.js';
import { ThemeService } from './services/themeService.js';
import { DuplicateService } from './services/duplicateService.js';
import { buildJobKinds } from './services/jobKinds.js';
import { startJobRunner } from './services/jobRunner.js';
import { purgeOlderThan } from './db/audit.js';
import { attachUser, csrfGuard, errorHandler, langMiddleware, requireAuth, requirePasswordChanged } from './middleware/index.js';
import { authRouter } from './routes/auth.js';
import { i18nRouter } from './routes/i18n.js';
import { healthRouter } from './routes/health.js';
import { adminRouter } from './routes/admin.js';
import { serversRouter } from './routes/servers.js';
import { thematiquesRouter } from './routes/thematiques.js';
import { domainsRouter } from './routes/domains.js';
import { filesRouter } from './routes/files.js';
import { designCatalogRouter, designRouter } from './routes/design.js';
import { translationRouter } from './routes/translation.js';
import { categoriesRouter } from './routes/categories.js';
import { redirectsRouter } from './routes/redirects.js';
import { searchRouter } from './routes/search.js';
import { cloudflareRouter } from './routes/cloudflare.js';
import { jobsRouter } from './routes/jobs.js';

let servers;
try {
  assertStartupConfig();
  loadLocales();
  servers = loadServers();
  // MySQL porte TOUTES les données de l'application. SQLite n'est plus lu ni écrit par
  // aucune couche ; le fichier reste ouvert le temps de la dernière étape, qui retirera
  // la dépendance et fera passer la sauvegarde à mysqldump.
  openMysql(config.mysql);
  await migrateMysql({ prepare: mysqlPrepare, exec: mysqlExec });
  await seedSystemRolesMysql(null, { SYSTEM_ROLES, PERMISSION_KEYS });
  await bootstrapAdmin();
} catch (err) {
  console.error(`\n✖ ${err.message}\n`);
  process.exit(1);
}
watchLocales();

const ssh = new SshManager(servers, { knownHosts: new KnownHosts(config.knownHostsFile), settings: config.ssh });
const domains = new DomainService(ssh, { cacheTtl: config.cacheTtl });
const files = new FileService(ssh, { limits: config.files });
const sites = new SiteService(ssh);
const translation = new TranslationService(ssh, sites, config.translate);
const categories = new CategoryService(ssh, sites);
const redirects = new RedirectService(ssh, sites);
// UN SEUL frein pour toutes les analyses de masse : c'est lui qui retient le train de vie
// de chaque machine, et deux exemplaires l'apprendraient deux fois.
const serverLoad = new ServerLoad(ssh);
const serverState = new ServerStateService(ssh);
// La reputation se lit chez Google, jamais sur une machine du parc : un site peut
// repondre parfaitement et etre refuse par le navigateur du visiteur.
const reputation = new ReputationService({ enabled: config.reputationCheck });
const health = new HealthService(ssh, serverLoad, reputation);
const urls = new UrlCheckService(ssh, serverLoad);
const themes = new ThemeService(ssh, sites, serverLoad);
const duplicates = new DuplicateService(ssh, sites, serverLoad);
const search = new SearchService(ssh, domains, sites);
// Cloudflare : la base porte les comptes et les zones ; aucun acces SSH n'intervient ici.
const cloudflare = new CloudflareService();
const audit = createAudit(config.auditLog, { maxBytes: config.auditLogMaxBytes, keep: config.auditLogKeep });

// Un journal qui grossit sans fin finit par ne plus être consulté : on efface au
// démarrage ce qui dépasse la durée de conservation. Le fichier, lui, garde tout.
// La base porte TOUT ce que l'application sait, et n'existe qu'en un exemplaire. La
// sauvegarde part donc d'elle-meme pendant que le serveur tourne, et une restauration
// est reellement eprouvee de temps en temps : une sauvegarde jamais rejouee est un
// fichier dont on espere quelque chose.
const sauvegardes = startBackupSchedule({ config, audit });

// LES TOURNEES. La boucle d'un traitement de masse vivait dans l'onglet du navigateur :
// le fermer arretait une tournee de 7 733 sites en plein milieu, sans rien pour dire ou
// elle en etait. Elle est desormais menee ici, ecrite apres chaque lot, et reprise au
// bon endroit si le serveur redemarre.
const jobKinds = buildJobKinds({ translation, categories, redirects, cloudflare, health, urls, themes, duplicates });
const jobs = startJobRunner({ kinds: jobKinds, audit, retentionDays: config.jobRetentionDays });

const purges = await purgeOlderThan(config.auditRetentionDays);
if (purges) console.log(`[audit] ${purges} événement(s) de plus de ${config.auditRetentionDays} jours effacés`);
const SESSION_TTL = 8 * 3600 * 1000;
// L'instant du demarrage : c'est lui qui donne la duree de fonctionnement annoncee par
// le releve de sante, et qui permet de voir qu'un redemarrage a eu lieu.
const DEMARRE_A = Date.now();

const app = express();
app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        'script-src': ["'self'"],
        // Aucune feuille de style extérieure, et aucune balise <style> écrite dans la page…
        'style-src-elem': ["'self'"],
        // …mais l'éditeur colore du texte : une couleur choisie ne peut vivre que dans un
        // attribut `style`. Cette ouverture ne concerne que les attributs, jamais un script.
        'style-src-attr': ["'unsafe-inline'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        // Les vignettes de l'éditeur proviennent des sites gérés : seules les IMAGES
        // sont autorisées depuis l'extérieur, jamais de script ni de feuille de style.
        'img-src': ["'self'", 'data:', 'https:'],
        'connect-src': ["'self'"],
        'upgrade-insecure-requests': null,
      },
    },
    strictTransportSecurity: config.secureCookies ? undefined : false,
  }),
);
app.use(express.static(path.join(ROOT, 'public')));
app.use(express.json({ limit: '1mb' }));
app.use(
  session({
    name: 'lkm.sid',
    store: new MysqlSessionStore({ ttlMs: SESSION_TTL }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'strict', secure: config.secureCookies, maxAge: SESSION_TTL },
  }),
);
app.use(langMiddleware);
app.use(attachUser); // recharge le compte et ses droits à chaque requête

app.use('/api', csrfGuard);
// LA SANTE AVANT TOUT LE RESTE, et sans authentification : ce qui surveille une
// application ne peut pas se connecter avec un compte. La reponse ne dit rien d'utile a
// un curieux, et son code HTTP suffit a decider (200 ou 503).
app.use('/api/health', healthRouter({ ssh, startedAt: DEMARRE_A }));
app.use('/api/i18n', i18nRouter());
app.use('/api/auth', authRouter({ audit }));
app.use('/api', requireAuth);
// L'ORDRE COMPTE. /api/i18n et /api/auth sont montés au-dessus : ils échappent donc à ce
// garde, et c'est voulu — un compte au mot de passe provisoire doit pouvoir lire son
// profil, changer son mot de passe et se déconnecter. Tout ce qui suit lui est fermé.
app.use('/api', requirePasswordChanged);
app.use('/api/admin', adminRouter({ audit, ssh }));
app.use('/api/design', designCatalogRouter({ audit }));
app.use('/api/servers/:id/domains/:domain/design', designRouter({ ssh, sites, audit, uploadLimit: config.files.maxUploadBytes }));
app.use('/api/servers/:id/translation', translationRouter({ ssh, translation, audit }));
app.use('/api/servers/:id/categories', categoriesRouter({ ssh, categories, audit }));
app.use('/api/servers/:id/redirects', redirectsRouter({ ssh, redirects, audit }));
app.use('/api/search', searchRouter({ ssh, search }));
app.use('/api/cloudflare', cloudflareRouter({ cloudflare, audit }));
app.use('/api/jobs', jobsRouter({ kinds: jobKinds, runner: jobs, audit }));
app.use('/api/thematiques', thematiquesRouter({ ssh, themes, audit }));
app.use('/api/servers/:id/domains/:domain/files', filesRouter({ ssh, files, audit, uploadLimit: config.files.maxUploadBytes }));
app.use('/api/servers', serversRouter({ ssh, domains, serverState, audit }));
app.use('/api/domains', domainsRouter({ ssh, domains }));
app.use('/api', () => {
  throw new AppError('errors.not_found', { status: 404 });
});
app.use(errorHandler);

const server = app.listen(config.port, config.host, () => {
  console.log(`LKM-BO prêt → http://${config.host}:${config.port}  (${servers.length} serveur(s) configuré(s))`);
});

function shutdown() {
  console.log('\nArrêt : fermeture des sessions SSH…');
  ssh.closeAll();
  sauvegardes.stop();
  // Le moteur s'arrete entre deux lots : la tournee reprendra au redemarrage.
  jobs.stop();
  // Le groupe de connexions MySQL se ferme : sinon le processus s'attarde.
  closeMysql().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
