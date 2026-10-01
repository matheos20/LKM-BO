import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripLiterals } from '../src/dev/callCheck.js';

/**
 * Les écrans plein écran s'excluent l'un l'autre.
 *
 * Ouvrir « Actions » laissait Cloudflare affiché en dessous : le geste de fermeture
 * était recopié dans chaque gestionnaire de navigation, et chaque copie oubliait un
 * écran différent. Ces contrôles lisent le source plutôt que de rendre l'application :
 * ce qu'ils vérifient est une règle de structure, pas un comportement d'affichage.
 */
const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = stripLiterals(readFileSync(join(RACINE, 'public/js/app.js'), 'utf8'));

/** Les écrans qui occupent toute la zone de travail, et le module qui les ferme. */
const ECRANS = ['files', 'admin', 'design', 'actions', 'cloudflare'];

test('tous les écrans plein écran passent par la même fermeture', () => {
  const table = APP.match(/const ECRANS = \{([^}]*)\}/)?.[1] ?? '';
  for (const nom of ECRANS) {
    assert.match(table, new RegExp(`\\b${nom}\\s*:`), `« ${nom} » doit figurer dans la table des écrans`);
  }
});

test('aucun gestionnaire ne referme les écrans à la main', () => {
  // C'est la recopie qui avait créé le trou : un appel direct hors de la table est
  // le signe qu'un écran va être oublié.
  const lignes = APP.split('\n');
  const fautifs = [];
  lignes.forEach((ligne, i) => {
    const m = /\bclose(Files|Admin|Design|Actions|Cloudflare)\(\)/.exec(ligne);
    if (!m) return;
    // La table elle-même les nomme sans parenthèses ; seuls les APPELS comptent.
    // Deux exceptions légitimes, commentées dans le source : le retour depuis les
    // fichiers ouverts par l'écran Actions, et la fermeture d'un écran par lui-même.
    if (/isActionsSuspended/.test(ligne)) return;
    fautifs.push(`ligne ${i + 1} : ${ligne.trim().slice(0, 80)}`);
  });
  assert.deepEqual(fautifs, [], `\nCes appels devraient passer par fermerEcrans() :\n${fautifs.join('\n')}\n`);
});

test('chaque ouverture d’écran referme les autres', () => {
  // Pour chaque openX(, il doit y avoir un fermerEcrans() dans les lignes qui précèdent.
  const lignes = APP.split('\n');
  const manquants = [];
  lignes.forEach((ligne, i) => {
    const m = /\bopen(Admin|Actions|Cloudflare|Design|Files)\(\s*\{/.exec(ligne);
    if (!m) return;
    const avant = lignes.slice(Math.max(0, i - 12), i).join('\n');
    if (!/fermerEcrans\(/.test(avant)) manquants.push(`ligne ${i + 1} : open${m[1]}`);
  });
  assert.deepEqual(manquants, [], `\nCes ouvertures ne referment pas les autres écrans :\n${manquants.join('\n')}\n`);
});

test('chaque écran expose bien sa fermeture', () => {
  const modules = {
    files: 'public/js/files.js',
    admin: 'public/js/admin.js',
    design: 'public/js/design.js',
    actions: 'public/js/actions.js',
    cloudflare: 'public/js/cloudflare.js',
  };
  for (const [nom, chemin] of Object.entries(modules)) {
    const src = readFileSync(join(RACINE, chemin), 'utf8');
    const attendu = `close${nom[0].toUpperCase()}${nom.slice(1)}`;
    assert.match(src, new RegExp(`export (function|const) ${attendu}\\b`), `${chemin} doit exporter ${attendu}`);
  }
});

test('l’écran Cloudflare cache bien sa vue en se fermant', () => {
  // Un écran qui se dit fermé sans cacher sa section reste visible sous le suivant.
  const src = readFileSync(join(RACINE, 'public/js/cloudflare.js'), 'utf8');
  const corps = src.slice(src.indexOf('export function closeCloudflare'));
  const fin = corps.indexOf('\n}');
  assert.match(corps.slice(0, fin), /hidden = true/, 'closeCloudflare doit masquer sa vue');
});
