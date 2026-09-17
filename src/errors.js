/**
 * Erreur applicative : porte une clé i18n (ex. "errors.ssh_auth_failed"),
 * traduite au dernier moment par le middleware d'erreurs selon la langue de la requête.
 */
export class AppError extends Error {
  constructor(key, { status = 500, vars = {}, detail } = {}) {
    super(key);
    this.key = key;
    this.status = status;
    this.vars = vars;
    this.detail = detail;
  }
}
