import path from 'node:path';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { ROOT, assertStartupConfig, config, loadServers } from './config.js';
import { AppError } from './errors.js';
import { loadLocales, watchLocales } from './i18n.js';
import { closeDatabase, openDatabase } from './db/database.js';
import { SqliteSessionStore } from './db/sessionStore.js';
import { bootstrapAdmin } from './auth/authService.js';
import { KnownHosts } from './ssh/knownHosts.js';
import { SshManager } from './ssh/SshManager.js';
import { DomainService } from './services/domainService.js';
import { FileService } from './services/fileService.js';
import { SiteService } from './services/siteService.js';
import { TranslationService } from './services/translationService.js';
import { CategoryService } from './services/categoryService.js';
import { createAudit } from './services/audit.js';
import { attachUser, csrfGuard, errorHandler, langMiddleware, requireAuth } from './middleware/index.js';
import { authRouter } from './routes/auth.js';
import { i18nRouter } from './routes/i18n.js';
import { adminRouter } from './routes/admin.js';
import { serversRouter } from './routes/servers.js';
import { domainsRouter } from './routes/domains.js';
import { filesRouter } from './routes/files.js';
import { designCatalogRouter, designRouter } from './routes/design.js';
import { translationRouter } from './routes/translation.js';
import { categoriesRouter } from './routes/categories.js';

let servers;
try {
  assertStartupConfig();
  loadLocales();
  servers = loadServers();
  openDatabase(config.dbFile);
  bootstrapAdmin();
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
const audit = createAudit(config.auditLog);
const SESSION_TTL = 8 * 3600 * 1000;

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
    store: new SqliteSessionStore({ ttlMs: SESSION_TTL }),
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
app.use('/api/i18n', i18nRouter());
app.use('/api/auth', authRouter({ audit }));
app.use('/api', requireAuth);
app.use('/api/admin', adminRouter({ audit, ssh }));
app.use('/api/design', designCatalogRouter({ audit }));
app.use('/api/servers/:id/domains/:domain/design', designRouter({ ssh, sites, audit, uploadLimit: config.files.maxUploadBytes }));
app.use('/api/servers/:id/translation', translationRouter({ ssh, translation, audit }));
app.use('/api/servers/:id/categories', categoriesRouter({ ssh, categories, audit }));
app.use('/api/servers/:id/domains/:domain/files', filesRouter({ ssh, files, audit, uploadLimit: config.files.maxUploadBytes }));
app.use('/api/servers', serversRouter({ ssh, domains, audit }));
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
  closeDatabase();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
