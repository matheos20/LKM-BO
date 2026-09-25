import { AppError } from '../errors.js';
import { HTACCESS_REDIRECTS } from './phpScripts.js';

/**
 * Redirections 301 dans le `.htaccess` des sites du parc.
 *
 * La règle écrite est celle demandée, au format exact :
 *
 *     Redirect 301 /ancienne-url.php /nouvelle-url
 *
 * Elle est posée dans un bloc délimité, JUSTE APRÈS la ligne de repère du moteur
 * (« # Direct access to .php files redirects 301 to the old URL. »). Le bloc permet
 * de distinguer ce que le back-office a écrit de ce qui était là avant : rien de ce
 * qui vit hors du bloc n'est touché, ni compté comme nôtre.
 *
 * CE QUI A ÉTÉ MESURÉ SUR LE PARC, et qu'il faut savoir avant de lire la suite :
 *
 *   - la ligne de repère est présente, une seule fois, sur 395 sites sur 400 ;
 *   - 1 138 `.htaccess` sur 5 273 (21,6 %) sont modifiables par le compte SSH ; les
 *     autres n'ont pas l'ACL « editors » et demandent un « Réparer les droits » ;
 *   - les 12 `Redirect 301` déjà posés sur le parc renvoient tous 404 : la dernière
 *     règle du fichier, « RewriteRule ^.*\.php$ /404.php [L] », s'applique avant,
 *     parce que mod_rewrite passe avant mod_alias. Une `RewriteRule … [R=301,L]` au
 *     même endroit fonctionne, elle (12 sur 12 vérifiées en direct).
 *
 * Le format reste celui demandé ; changer d'avis ne touche qu'une fonction, `ligne()`.
 */

const MAX_DOMAINS = 150;
const MAX_RULES = 50;
const TIMEOUT = 180000;

/** La ligne écrite dans le fichier, et le seul endroit où le format est décidé. */
export const ligne = ({ from, to }) => `Redirect 301 ${from} ${to}`;

/**
 * Une URL acceptable.
 *
 * Le refus des blancs et des guillemets n'est pas cosmétique : un saut de ligne dans
 * une URL laisserait écrire n'importe quelle directive Apache dans le `.htaccess`.
 * C'est la seule injection possible par cette fonctionnalité, et elle est fermée ici
 * comme côté serveur, dans le script PHP.
 */
export function urlValide(u, { destination = false } = {}) {
  const v = String(u ?? '');
  if (!v || v.length > 512) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f"]/.test(v)) return false;
  if (v.startsWith('/')) return true;
  // Une destination hors du site est légitime (un article déplacé ailleurs) ; une
  // source, non : elle désigne un chemin de CE site.
  return destination && /^https?:\/\/[^/\s]+/i.test(v);
}

/** Nettoie ce que l'écran envoie : URL vides, doublons de source, limites. */
export function normalizeRequest(request) {
  const out = {};
  for (const [rawDomain, entree] of Object.entries(request ?? {})) {
    const domain = String(rawDomain ?? '').trim().toLowerCase();
    if (!domain) continue;
    const brut = Array.isArray(entree) ? { rules: entree } : (entree ?? {});
    const vues = new Set();
    const rules = [];
    for (const r of Array.isArray(brut.rules) ? brut.rules : []) {
      const from = String(r?.from ?? '').trim();
      const to = String(r?.to ?? '').trim();
      // Une même source deux fois dans la même demande : la seconde ne veut rien dire.
      if (!from || vues.has(from) || rules.length >= MAX_RULES) continue;
      vues.add(from);
      rules.push({ from, to });
    }
    if (rules.length) out[domain] = { md5: String(brut.md5 ?? ''), rules };
  }
  return out;
}

export class RedirectService {
  constructor(ssh, sites) {
    this.ssh = ssh;
    this.sites = sites;
  }

  /** Lecture seule : ce qui est en place, et ce que la demande changerait. */
  plan(serverId, request, { operation = 'add' } = {}) {
    return this.#run(serverId, request, 'scan', operation);
  }

  /**
   * Écriture. Le script serveur sauvegarde, écrit sur place, relit et compare octet
   * à octet ; au moindre écart il remet la sauvegarde. Rien ici ne suppose que
   * l'écriture a réussi : c'est le fichier relu qui le dit.
   */
  apply(serverId, request, { operation = 'add' } = {}) {
    return this.#run(serverId, request, 'apply', operation);
  }

  /** Les redirections en place sur des sites donnés, sans rien demander de neuf. */
  existing(serverId, domains) {
    const liste = (Array.isArray(domains) ? domains : []).map((d) => String(d ?? '').trim().toLowerCase()).filter(Boolean);
    if (!liste.length) throw new AppError('errors.redirect_none', { status: 400 });
    // Une règle bidon par site : le script a besoin d'une entrée pour visiter le
    // domaine, et en mode « scan » elle n'écrit rien.
    const demande = Object.fromEntries(liste.slice(0, MAX_DOMAINS).map((d) => [d, { rules: [{ from: '/', to: '/' }] }]));
    return this.#run(serverId, demande, 'scan', 'add');
  }

  async #run(serverId, request, mode, operation) {
    const server = this.ssh.server(serverId);
    const demande = normalizeRequest(request);
    const domaines = Object.keys(demande);
    if (!domaines.length) throw new AppError('errors.redirect_none', { status: 400 });
    if (domaines.length > MAX_DOMAINS) throw new AppError('errors.translate_batch_too_big', { status: 400, vars: { max: MAX_DOMAINS } });

    // La validation est refaite côté serveur, sur des données qui n'ont pas transité
    // par le navigateur de l'agent — et une troisième fois dans le script PHP.
    for (const [domain, { rules }] of Object.entries(demande)) {
      for (const r of rules) {
        if (!urlValide(r.from)) throw new AppError('errors.redirect_url_invalid', { status: 400, vars: { url: r.from.slice(0, 80), domain } });
        if (operation === 'add' && !urlValide(r.to, { destination: true })) {
          throw new AppError('errors.redirect_url_invalid', { status: 400, vars: { url: r.to.slice(0, 80), domain } });
        }
        if (operation === 'add' && r.from === r.to) throw new AppError('errors.redirect_loop', { status: 400, vars: { url: r.from.slice(0, 80), domain } });
      }
    }

    const raw = await this.sites.runPhp(
      serverId,
      server.wwwRoot,
      HTACCESS_REDIRECTS,
      {
        LKM_ROOT: server.wwwRoot,
        LKM_MODE: mode,
        LKM_OP: operation === 'remove' ? 'remove' : 'add',
        LKM_B64: Buffer.from(JSON.stringify(demande), 'utf8').toString('base64'),
      },
      { timeout: TIMEOUT },
    );

    return {
      mode,
      operation,
      sites: (raw.sites ?? []).map((s) => ({
        domain: s.domain,
        error: s.error ?? null,
        md5: s.md5 ?? null,
        bytes: s.bytes ?? 0,
        markerAt: s.markerAt ?? null,
        writable: Boolean(s.writable),
        // Les règles du bloc du back-office…
        existing: s.existing ?? [],
        // …et celles posées ailleurs dans le fichier, qu'on ne touche pas.
        foreign: s.foreign ?? 0,
        stamp: s.stamp ?? null,
        items: s.items ?? [],
      })),
    };
  }
}
