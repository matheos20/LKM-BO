import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { requirePasswordChanged } from '../src/middleware/index.js';
import { stripLiterals } from '../src/dev/callCheck.js';

/**
 * Un mot de passe provisoire ne donne accès à rien.
 *
 * L'obligation n'existait que dans le navigateur : une fenêtre s'ouvrait par-dessus
 * l'application déjà chargée, et un clic à côté la fermait. Le compte travaillait alors
 * avec le mot de passe que son administrateur avait tapé pour lui.
 *
 * Elle est maintenant tenue par l'API. Et comme toute la garantie repose sur l'ORDRE des
 * gardes dans server.js — un garde monté trop tôt fermerait le changement de mot de
 * passe lui-même, monté trop tard ne fermerait rien — cet ordre est contrôlé ici, sur le
 * source. C'est une règle de structure, pas un comportement d'affichage.
 */
const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
// Le source TEL QUEL : ce qu'on cherche ici, ce sont justement les chemins montés, que
// « stripLiterals » viderait. Les commentaires de ce fichier ne contiennent aucun
// « app.use('…') », et une ligne mise en commentaire se verrait au premier contrôle.
const SERVEUR = readFileSync(join(RACINE, 'src/server.js'), 'utf8');
const AUTH = readFileSync(join(RACINE, 'src/routes/auth.js'), 'utf8');

/** Un faux appel, réduit à ce que le garde regarde. */
const appel = (user) => ({ user });
const suite = () => {
  const vu = { appele: false, erreur: undefined };
  return [(err) => { vu.appele = true; vu.erreur = err; }, vu];
};

test('mot de passe provisoire : le garde laisse passer un compte en règle', () => {
  for (const user of [{ mustChangePassword: false }, { mustChangePassword: undefined }, undefined]) {
    const [next, vu] = suite();
    requirePasswordChanged(appel(user), {}, next);
    assert.ok(vu.appele, 'la requête doit continuer');
    assert.equal(vu.erreur, undefined, `aucune erreur attendue pour ${JSON.stringify(user)}`);
  }
});

test('mot de passe provisoire : le garde ferme tout le reste', () => {
  const [next, vu] = suite();
  requirePasswordChanged(appel({ mustChangePassword: true }), {}, next);
  assert.ok(vu.erreur, 'la requête doit être arrêtée');
  assert.equal(vu.erreur.status, 403);
  assert.equal(vu.erreur.key, 'errors.password_change_required');
});

test('mot de passe provisoire : le garde vient APRÈS l’authentification', () => {
  // Avant elle, il regarderait un compte qui n'est pas encore chargé, et ne verrait
  // jamais le drapeau : l'obligation ne s'appliquerait à personne.
  const auth = SERVEUR.indexOf("app.use('/api', requireAuth)");
  const garde = SERVEUR.indexOf("app.use('/api', requirePasswordChanged)");
  assert.ok(auth >= 0, 'requireAuth doit être monté sur /api');
  assert.ok(garde >= 0, 'requirePasswordChanged doit être monté sur /api');
  assert.ok(garde > auth, 'le garde doit suivre l’authentification');
});

test('mot de passe provisoire : la connexion et le changement restent accessibles', () => {
  // S'ils passaient APRÈS le garde, le compte serait enfermé : plus moyen de changer son
  // mot de passe, donc plus moyen d'entrer. Un écran sans issue.
  const garde = SERVEUR.indexOf("app.use('/api', requirePasswordChanged)");
  for (const monture of ["app.use('/api/auth'", "app.use('/api/i18n'"]) {
    const ou = SERVEUR.indexOf(monture);
    assert.ok(ou >= 0, `${monture} doit être monté`);
    assert.ok(ou < garde, `${monture} doit être monté AVANT le garde, sinon le compte ne peut plus se mettre en règle`);
  }
});

test('mot de passe provisoire : tous les écrans sont montés après le garde', () => {
  // Un routeur monté avant lui lui échapperait en silence. On vérifie donc chacun.
  const garde = SERVEUR.indexOf("app.use('/api', requirePasswordChanged)");
  for (const monture of [
    "app.use('/api/admin'", "app.use('/api/design'", "app.use('/api/search'",
    "app.use('/api/cloudflare'", "app.use('/api/servers'", "app.use('/api/domains'",
  ]) {
    const ou = SERVEUR.indexOf(monture);
    assert.ok(ou >= 0, `${monture} doit être monté`);
    assert.ok(ou > garde, `${monture} doit être monté APRÈS le garde`);
  }
});

test('changement de mot de passe : l’actuel n’est exigé que s’il n’est pas imposé', () => {
  // La règle vit dans une seule condition. Si elle disparaissait, deux choses tomberaient
  // d'un coup : l'agent devrait recopier douze caractères aléatoires, et une session
  // laissée ouverte permettrait de verrouiller le compte sans rien connaître.
  const bloc = AUTH.slice(AUTH.indexOf("r.post('/password'"));
  assert.match(bloc, /const impose = req\.user\.mustChangePassword/, 'le cas imposé doit être nommé');
  assert.match(bloc, /if \(!impose\)[\s\S]{0,200}verifyPassword/, 'le mot de passe actuel n’est vérifié que hors de ce cas');
  assert.match(bloc, /revokeUserSessions\(req\.user\.id/, 'les autres sessions du compte sont fermées dans les deux cas');
});

test('comptes : aucune route n’oublie d’attendre sa réponse', () => {
  // UNE RÉGRESSION RÉELLE, et invisible : « const out = audited(...) » sans await renvoyait
  // une promesse au navigateur. La création répondait 201 avec un objet vide — l'écran
  // affichait « Compte "undefined" créé » — et une erreur, identifiant déjà pris ou mot de
  // passe trop court, disparaissait sans laisser de trace.
  const admin = stripLiterals(readFileSync(join(RACINE, 'src/routes/admin.js'), 'utf8'));
  const oublis = [...admin.matchAll(/=\s*audited\(/g)];
  assert.equal(oublis.length, 0, 'chaque appel à « audited » doit être précédé de « await »');
  assert.ok(admin.includes('await audited('), 'et il doit bien y en avoir');
});
