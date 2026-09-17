import { Router } from 'express';
import { AppError } from '../errors.js';
import { config } from '../config.js';
import { catalog, hasLang, languages } from '../i18n.js';

/** Routes publiques : liste des langues disponibles + dictionnaire d'une langue. */
export function i18nRouter() {
  const r = Router();

  r.get('/', (req, res) => {
    res.json({ default: config.defaultLang, detected: req.lang, languages: languages() });
  });

  r.get('/:lang', (req, res) => {
    if (!hasLang(req.params.lang)) throw new AppError('errors.not_found', { status: 404 });
    res.set('Cache-Control', 'no-cache');
    res.json(catalog(req.params.lang));
  });

  return r;
}
