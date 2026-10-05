import { splitCsvLine, splitCsvRecords } from './csv.js';

/**
 * La lecture des sept fichiers de `thematiques/`.
 *
 * Elle vit ici, et non dans le script d'import, pour une raison simple : un script en
 * ligne de commande s'exécute dès qu'on l'importe — il lit `process.argv`, ouvre la base
 * et appelle `process.exit`. Un contrôle qui voulait seulement éprouver la lecture d'un
 * CSV arrêtait donc la suite entière.
 *
 * DEUX PIÈGES DANS CES FICHIERS, tous deux rencontrés le 05/10/2026 :
 *
 *   1. le fichier anglais commence par un champ entre guillemets QUI CONTIENT UN RETOUR
 *      À LA LIGNE (« "ANIMALS \n",NEWS »). C'est `splitCsvRecords` qui s'en occupe ;
 *   2. LES SEPT FICHIERS NE NOMMENT PAS LEURS COLONNES PAREIL : « THEMATIQUE FR » ici,
 *      « THEMATIQUE » tout court en néerlandais et en portugais, un espace de trop en
 *      allemand. Les colonnes sont donc prises par POSITION — la première est le sujet,
 *      la seconde une entrée de menu. Se fier au nom vidait deux langues sur sept, sans
 *      un mot.
 *
 * La forme du fichier : une première colonne remplie ouvre un sujet, la seconde ajoute
 * une rubrique au sujet courant.
 */
export function lireCsvThematiques(texte) {
  const sujets = [];
  let courant = null;
  let premier = true;

  for (const { raw } of splitCsvRecords(texte)) {
    if (!raw.trim()) continue;
    const cells = splitCsvLine(raw).map((c) => c.replace(/^﻿/, '').replace(/\s+/g, ' ').trim());
    if (premier) {
      premier = false;
      continue; // l'en-tête
    }
    const [sujet, rubrique] = cells;
    if (sujet) {
      courant = { label: sujet, rubriques: [] };
      sujets.push(courant);
    }
    if (rubrique && courant) courant.rubriques.push(rubrique);
  }
  return sujets.filter((s) => s.rubriques.length);
}

/**
 * Le nom d'une rubrique, tel qu'il s'écrira au menu.
 *
 * Les fichiers sont en capitales : « AUTRES ANIMAUX » devient « Autres animaux ». Les
 * accents, eux, manquent à la source — « CROISIERE » donne « Croisiere ». C'est la
 * moisson sur le parc qui les rétablit, puisque les sites en service les portent déjà.
 */
export function nomRubrique(brut) {
  const t = String(brut ?? '').trim().toLowerCase();
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
}
