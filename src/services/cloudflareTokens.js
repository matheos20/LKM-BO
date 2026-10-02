import { CloudflareError, cfRequest } from './cloudflareClient.js';

/**
 * Remplacer une clé globale par un jeton à portée limitée.
 *
 * LE PROBLÈME. La base porte 38 195 clés GLOBALES. Une clé globale ouvre la totalité
 * d'un compte Cloudflare : la facturation, les membres de l'équipe, les Workers, la
 * suppression de zones, et jusqu'à la création d'autres clés. Le back-office, lui, a
 * besoin de six choses : lire une zone, lire et changer ses réglages, lire et écrire son
 * DNS, vider son cache. Rien d'autre. Confier tout le compte pour faire cela, c'est
 * laisser la clé de l'immeuble à qui vient relever le compteur.
 *
 * CE QU'UN JETON CHANGE. Un jeton ne porte que les permissions qu'on lui donne, ne vaut
 * que pour le compte désigné, se révoque d'un geste sans toucher au reste, et peut être
 * limité à une adresse IP. S'il fuite, ce qui est perdu tient dans ces six permissions.
 *
 * LA RÈGLE DE PRUDENCE : on n'efface la clé globale qu'APRÈS avoir vérifié que le jeton
 * fonctionne. Un jeton créé mais inutilisable, avec la clé déjà effacée, laisserait le
 * domaine injoignable — et il faudrait tout réimporter pour s'en sortir.
 */

/**
 * Les six permissions dont le back-office a besoin, et leurs identifiants Cloudflare.
 *
 * Relevés sur l'API le 02/10/2026 parmi 413 groupes disponibles. Ils sont stables : un
 * identifiant de groupe ne change pas, c'est le nom affiché qui peut bouger. Ils sont
 * écrits ici plutôt que redemandés à chaque fois — une tournée sur 38 195 comptes ne
 * doit pas faire 38 195 appels de plus pour relire le même catalogue.
 */
export const PERMISSIONS = [
  { id: 'c8fed203ed3043cba015a93ad1616f1f', nom: 'Zone Read', pourquoi: 'lire l’état d’une zone, et la retrouver par son nom' },
  { id: '517b21aee92c4d89936c976ba6e4be55', nom: 'Zone Settings Read', pourquoi: 'lire SSL, HTTPS, niveau de sécurité…' },
  { id: '3030687196b94b638145a3953da2b699', nom: 'Zone Settings Write', pourquoi: 'changer ces mêmes réglages' },
  { id: '82e64a83756745bbbb1c9c2701bf816b', nom: 'DNS Read', pourquoi: 'afficher les enregistrements DNS' },
  { id: '4755a26eedb94da69e1066d98aa820be', nom: 'DNS Write', pourquoi: 'créer, modifier, supprimer un enregistrement' },
  { id: 'e17beae8b8cb423a99b1730f21238bed', nom: 'Cache Purge', pourquoi: 'vider le cache d’une zone' },
];

/**
 * Ce qu'un jeton N'A PAS, et qu'une clé globale donnait.
 * Écrit pour être affiché à l'agent : c'est la mesure de ce qu'on gagne.
 */
export const HORS_PORTEE = [
  'la facturation et les abonnements',
  'les membres du compte et leurs droits',
  'la création et la suppression de zones',
  'les Workers, R2, les tunnels',
  'la création d’autres clés et jetons',
];

export const NOM_PAR_DEFAUT = 'LKM Back-Office';

/** Une adresse IPv4 ou IPv6, pour restreindre l'usage du jeton. */
const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?|[0-9a-f:]+(?:\/\d{1,3})?)$/i;

/**
 * Compose la demande de création.
 *
 * Séparée de l'appel pour être vérifiable sans réseau : c'est ici que se décide
 * l'étendue de ce qu'on accorde, et c'est elle qu'on veut contrôler.
 */
export function buildTokenRequest(accountId, { name = NOM_PAR_DEFAUT, ip = '', expiresInDays = 0 } = {}) {
  if (!/^[0-9a-f]{32}$/i.test(String(accountId ?? ''))) {
    throw new CloudflareError('identifiant de compte invalide', { status: 400 });
  }
  const demande = {
    name: String(name).slice(0, 120),
    policies: [{
      effect: 'allow',
      // LA PORTÉE EST LE COMPTE, et lui seul. Sans cette restriction, le jeton
      // vaudrait pour tous les comptes auxquels le titulaire a accès.
      resources: { [`com.cloudflare.api.account.${accountId}`]: '*' },
      permission_groups: PERMISSIONS.map((p) => ({ id: p.id })),
    }],
  };

  if (ip) {
    const liste = [].concat(ip).map((x) => String(x).trim()).filter(Boolean);
    for (const adresse of liste) {
      if (!IP_RE.test(adresse)) throw new CloudflareError(`adresse IP invalide : ${adresse}`, { status: 400 });
    }
    // Un jeton qui ne vaut que depuis la machine du back-office ne sert à rien ailleurs,
    // même copié. C'est la protection la plus forte, et la plus fragile : elle se brise
    // le jour où l'adresse change.
    demande.condition = { 'request.ip': { in: liste } };
  }

  const jours = Number(expiresInDays) || 0;
  if (jours > 0) {
    // Un jeton qui expire force la rotation. C'est une bonne pratique — et un piège
    // d'exploitation : tout s'arrête un matin si personne n'y a pensé. D'où le choix de
    // ne rien imposer par défaut.
    demande.expires_on = new Date(Date.now() + jours * 86_400_000).toISOString();
  }
  return demande;
}

/**
 * Crée le jeton et rend sa VALEUR, qui n'est montrée qu'une fois.
 *
 * Cloudflare ne redonne jamais la valeur d'un jeton après sa création. Ne pas
 * l'enregistrer tout de suite, c'est la perdre — et devoir en créer un autre.
 */
export async function createScopedToken(accountId, creds, options = {}) {
  const out = await cfRequest('/user/tokens', creds, { method: 'POST', body: buildTokenRequest(accountId, options), ...options.request });
  const jeton = out?.result ?? out;
  if (!jeton?.value) throw new CloudflareError('Cloudflare n’a pas rendu la valeur du jeton', { status: 502 });
  return { id: jeton.id, value: jeton.value, name: jeton.name, status: jeton.status, expiresOn: jeton.expires_on ?? null };
}

/**
 * Le jeton fonctionne-t-il ?
 *
 * On interroge avec LE JETON, pas avec la clé qui l'a créé : c'est la seule façon de
 * savoir qu'il est réellement utilisable. Un jeton créé mais inactif existe.
 */
export async function verifyToken(token, options = {}) {
  const out = await cfRequest('/user/tokens/verify', { apiToken: token }, { retries: 1, ...options });
  const etat = (out?.result ?? out)?.status;
  return { ok: etat === 'active', status: etat ?? 'inconnu' };
}

/** Les jetons déjà créés par ce titulaire. Sert à ne pas en empiler un par tentative. */
export async function listTokens(creds, options = {}) {
  const out = await cfRequest('/user/tokens', creds, options);
  const liste = out?.result ?? out;
  return Array.isArray(liste) ? liste.map((j) => ({ id: j.id, name: j.name, status: j.status })) : [];
}

export async function revokeToken(tokenId, creds, options = {}) {
  if (!/^[0-9a-f]{32}$/i.test(String(tokenId ?? ''))) throw new CloudflareError('identifiant de jeton invalide', { status: 400 });
  await cfRequest(`/user/tokens/${tokenId}`, creds, { method: 'DELETE', ...options });
  return { revoked: tokenId };
}
