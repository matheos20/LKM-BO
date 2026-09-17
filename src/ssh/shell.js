import { AppError } from '../errors.js';

/**
 * Protection contre l'injection de commandes.
 * 1) Validation stricte : un domaine ne contient QUE [a-z0-9.-] (même règle que add-site).
 * 2) Échappement systématique en quotes simples lors de l'insertion dans une commande.
 */
export const DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const isValidDomain = (d) => typeof d === 'string' && DOMAIN_RE.test(d);

/** Valide un domaine reçu dans l'URL (pas de normalisation : il doit déjà être exact). */
export function assertDomain(domain) {
  if (!isValidDomain(domain)) throw new AppError('errors.domain_invalid', { status: 400, vars: { domain: String(domain).slice(0, 80) } });
  return domain;
}

/** Normalise une saisie utilisateur ("  Exemple.COM. " → "exemple.com") puis la valide. */
export function normalizeDomain(input) {
  const d = String(input ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (/^[a-z]+:\/\//.test(d) || d.includes('/')) throw new AppError('errors.domain_invalid', { status: 400, vars: { domain: d.slice(0, 80) } });
  if (d.startsWith('www.')) throw new AppError('errors.domain_www', { status: 400 });
  return assertDomain(d);
}

/** Quote POSIX : 'abc' ; les ' internes deviennent '\'' . */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Remplit un modèle de commande issu de la config (source de confiance).
 * {domain} est inséré quoté. Avec quote:false (commandes forcées type lockop, qui lisent
 * $SSH_ORIGINAL_COMMAND brut), la valeur est insérée telle quelle — sûr UNIQUEMENT parce
 * que le domaine a été validé par DOMAIN_RE (aucun métacaractère shell possible).
 */
export function renderTemplate(template, vars, { quote = true } = {}) {
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`Variable de modèle inconnue : {${k}}`);
    if (!quote && !isValidDomain(vars[k])) throw new Error(`Valeur non sûre pour insertion brute : ${k}`);
    return quote ? shq(vars[k]) : vars[k];
  });
}
