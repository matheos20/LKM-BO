import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PERMISSIONS, PERMISSION_GROUPS, PERMISSION_KEYS, PROTECTED_ROLE, SYSTEM_ROLES } from '../src/auth/permissions.js';
import { peutAppliquerEnMasse } from '../public/js/ui.js';

/**
 * Les droits : leur catalogue, leurs libellés, et les routes qui les font respecter.
 *
 * Deux choses se vérifient ici, et aucune ne se voit en lisant le code :
 *
 *   - CHAQUE DROIT A UN LIBELLÉ, DANS LES SIX LANGUES. Les trois droits Cloudflare
 *     avaient été ajoutés en clés plates — « perm.cloudflare.read » — là où `t()`
 *     découpe sur les points et attend un objet. L'écran des rôles affichait donc
 *     « perm.cloudflare.read » à l'administrateur, qui devait deviner.
 *   - LES TRAITEMENTS DE MASSE DEMANDENT LEUR PROPRE DROIT. L'écran « Actions » agit
 *     sur des milliers de sites ; il s'ouvrait avec le droit de lire le design et
 *     s'exécutait avec celui de publier. Un rédacteur de contenu pouvait lancer une
 *     tournée sur tout un VPS.
 */
const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = join(RACINE, 'locales');
const LANGUES = readdirSync(LOCALES).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));

/** La même traversée que `t()` côté navigateur : on découpe sur les points. */
const lire = (obj, cle) => cle.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

const textes = Object.fromEntries(LANGUES.map((l) => [l, JSON.parse(readFileSync(join(LOCALES, `${l}.json`), 'utf8'))]));

test('droits : chaque permission porte un libellé dans TOUTES les langues', () => {
  assert.ok(LANGUES.length >= 6, `six langues attendues, ${LANGUES.length} trouvée(s)`);
  for (const langue of LANGUES) {
    for (const cle of PERMISSION_KEYS) {
      const libelle = lire(textes[langue], `perm.${cle}`);
      assert.equal(typeof libelle, 'string', `${langue} : « perm.${cle} » doit être une chaîne, pas ${JSON.stringify(libelle)}`);
      assert.ok(libelle.trim().length > 0, `${langue} : « perm.${cle} » est vide`);
      // Un libellé qui ressemble à sa clé n'en est pas un : c'est le repli de `t()`.
      assert.ok(!libelle.startsWith('perm.'), `${langue} : « perm.${cle} » n'est pas traduit`);
    }
    for (const groupe of PERMISSION_GROUPS) {
      const libelle = lire(textes[langue], `perm_group.${groupe}`);
      assert.equal(typeof libelle, 'string', `${langue} : « perm_group.${groupe} » manque`);
    }
  }
});

test('droits : aucun libellé n’est écrit en clé plate', () => {
  // C'EST LA FORME EXACTE DU BUG. « perm: { "cloudflare.read": "…" } » se lit très bien
  // dans le fichier et ne fonctionne pas : `t()` cherche perm.cloudflare puis .read.
  for (const langue of LANGUES) {
    const plates = Object.keys(textes[langue].perm ?? {}).filter((k) => k.includes('.'));
    assert.deepEqual(plates, [], `${langue} : clés plates sous « perm » — ${plates.join(', ')}`);
  }
});

test('droits : le catalogue est cohérent avec lui-même', () => {
  for (const p of PERMISSIONS) {
    assert.ok(PERMISSION_GROUPS.includes(p.group), `groupe inconnu pour ${p.key} : ${p.group}`);
    assert.match(p.key, /^[a-z_]+\.[a-z_]+$/, `clé mal formée : ${p.key}`);
    assert.ok(p.key.startsWith(`${p.group}.`) || p.group === 'admin', `${p.key} devrait commencer par son groupe`);
  }
  assert.equal(new Set(PERMISSION_KEYS).size, PERMISSION_KEYS.length, 'aucune clé en double');
  // Un groupe sans permission ne ferait qu'un titre vide à l'écran.
  for (const g of PERMISSION_GROUPS) {
    assert.ok(PERMISSIONS.some((p) => p.group === g), `le groupe « ${g} » ne porte aucune permission`);
  }
});

test('droits : les rôles fournis ne citent que des permissions qui existent', () => {
  for (const role of SYSTEM_ROLES) {
    for (const p of role.permissions) {
      assert.ok(PERMISSION_KEYS.includes(p), `le rôle « ${role.key} » cite « ${p} », qui n'existe pas`);
    }
  }
  const admin = SYSTEM_ROLES.find((r) => r.key === PROTECTED_ROLE);
  assert.deepEqual([...admin.permissions].sort(), [...PERMISSION_KEYS].sort(), 'l’administrateur doit tout avoir : c’est la porte de sortie');
});

test('droits : seuls l’opérateur et l’administrateur appliquent en masse', () => {
  // Un traitement de masse écrit sur des milliers de sites en production. Le rédacteur,
  // le lecteur et l'éditeur ne doivent pas pouvoir le lancer.
  const porte = (cle, perm) => SYSTEM_ROLES.find((r) => r.key === cle).permissions.includes(perm);
  assert.equal(porte('operator', 'bulk.apply'), true, 'l’opérateur fait les tournées : c’est son métier');
  assert.equal(porte('admin', 'bulk.apply'), true);
  for (const role of ['editor', 'contributor', 'viewer']) {
    assert.equal(porte(role, 'bulk.apply'), false, `« ${role} » ne doit pas appliquer en masse`);
  }
  // L'éditeur peut REGARDER ce qui serait fait : « montre-moi » ne coûte rien.
  assert.equal(porte('editor', 'bulk.read'), true);
  assert.equal(porte('viewer', 'bulk.read'), false);
  assert.equal(porte('contributor', 'bulk.read'), false);
});

test('droits : toutes les routes de masse exigent le droit de masse', () => {
  // La règle doit tenir sur le SERVEUR. Si une seule route l'oubliait, l'écran pourrait
  // être caché et le traitement resterait lançable par un appel direct.
  for (const fichier of ['translation.js', 'categories.js', 'redirects.js']) {
    const source = readFileSync(join(RACINE, 'src/routes', fichier), 'utf8');
    const routes = [...source.matchAll(/r\.(get|post|put|delete)\('([^']+)'([^\n]*)/g)];
    assert.ok(routes.length >= 3, `${fichier} : routes introuvables`);
    for (const [, verbe, chemin, suite] of routes) {
      assert.match(
        suite,
        /requirePermission\('bulk\.(read|apply)'\)/,
        `${fichier} : ${verbe.toUpperCase()} ${chemin} n'exige aucun droit de traitement de masse`,
      );
      // Ce qui écrit demande « apply », et rien d'autre ne le demande.
      const ecrit = /requirePermission\('design\.publish'\)/.test(suite);
      assert.equal(
        /requirePermission\('bulk\.apply'\)/.test(suite),
        ecrit,
        `${fichier} : ${verbe.toUpperCase()} ${chemin} — « bulk.apply » doit accompagner « design.publish », et seulement lui`,
      );
    }
  }
});

test('droits : l’écran des Actions ne s’ouvre que sur son propre droit', () => {
  const app = readFileSync(join(RACINE, 'public/js/app.js'), 'utf8');
  assert.match(app, /#nav-actions'\)\.hidden = !can\('bulk\.read'\)/, 'l’entrée « Actions » doit demander « bulk.read »');
});

test('droits : appliquer en masse demande les DEUX droits', () => {
  // L'écran doit dire exactement ce que le serveur exige. Un bouton actif que le serveur
  // refuserait ferait lancer une tournée pour récolter une erreur à la première écriture.
  assert.equal(peutAppliquerEnMasse(['bulk.apply', 'design.publish']), true);
  assert.equal(peutAppliquerEnMasse(['bulk.apply']), false, 'savoir publier en masse sans savoir publier n’a pas de sens');
  assert.equal(peutAppliquerEnMasse(['design.publish']), false, 'publier un site ne donne pas le parc entier');
  assert.equal(peutAppliquerEnMasse([]), false);
  assert.equal(peutAppliquerEnMasse(), false);
});
