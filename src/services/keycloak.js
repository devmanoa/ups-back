import { createPublicKey, createVerify } from 'node:crypto';
import { config } from '../config.js';

/**
 * Vérification des jetons Keycloak (JWT RS256).
 *
 * Les clés publiques du realm sont lues sur le JWKS et mises en cache, comme
 * l'est le jeton OAuth UPS : Keycloak ne doit pas être interrogé à chaque
 * requête. Aucune dépendance externe — `node:crypto` sait vérifier RS256.
 */

/** Algorithmes acceptés. RS256 est le défaut Keycloak ; `none` doit être refusé. */
const ALGORITHMS = {
  RS256: 'RSA-SHA256',
  RS384: 'RSA-SHA384',
  RS512: 'RSA-SHA512',
};

/** Tolérance d'horloge entre Keycloak et le backend. */
const CLOCK_SKEW_SEC = 60;

/** Les clés d'un realm changent rarement : une heure de cache suffit. */
const JWKS_TTL_MS = 60 * 60 * 1000;

let jwksCache = null; // { keys: Map<kid, KeyObject>, fetchedAt }
let inFlight = null;

function realmUrl() {
  return `${config.auth.keycloakUrl}/realms/${config.auth.realm}`;
}

export function isAuthConfigured() {
  return Boolean(config.auth.keycloakUrl);
}

function authError(message, code, status = 401) {
  return Object.assign(new Error(message), { status, code });
}

/** Décode un segment base64url en Buffer. */
function decodeSegment(segment) {
  return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Télécharge les clés publiques du realm et les indexe par `kid`.
 * Les appels concurrents partagent la même requête.
 */
async function fetchJwks() {
  const url = `${realmUrl()}/protocol/openid-connect/certs`;

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw authError(
      `Serveur Keycloak injoignable (${url}) : ${err.message}`,
      'KEYCLOAK_UNREACHABLE',
      503,
    );
  }

  if (!res.ok) {
    throw authError(
      `JWKS Keycloak indisponible (HTTP ${res.status}). Vérifiez KEYCLOAK_URL et KEYCLOAK_REALM.`,
      'KEYCLOAK_JWKS_ERROR',
      503,
    );
  }

  const body = await res.json();
  const keys = new Map();

  for (const jwk of body.keys ?? []) {
    // Seules les clés de signature RSA nous intéressent ; Keycloak publie
    // aussi des clés de chiffrement (use: 'enc').
    if (jwk.kty !== 'RSA' || (jwk.use && jwk.use !== 'sig')) continue;
    try {
      keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    } catch {
      // Une clé illisible ne doit pas invalider tout le trousseau.
    }
  }

  if (keys.size === 0) {
    throw authError('Aucune clé de signature exploitable dans le JWKS.', 'KEYCLOAK_NO_KEYS', 503);
  }

  return { keys, fetchedAt: Date.now() };
}

/**
 * Retourne la clé publique correspondant au `kid`.
 * Un `kid` inconnu force un rechargement : Keycloak a pu tourner ses clés.
 */
async function getKey(kid) {
  const expired = !jwksCache || Date.now() - jwksCache.fetchedAt > JWKS_TTL_MS;

  if (!expired && jwksCache.keys.has(kid)) return jwksCache.keys.get(kid);

  if (!inFlight) {
    inFlight = fetchJwks()
      .then((fresh) => {
        jwksCache = fresh;
        return fresh;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  const { keys } = await inFlight;
  const key = keys.get(kid);
  if (!key) {
    throw authError('Jeton signé par une clé inconnue du realm.', 'TOKEN_UNKNOWN_KEY');
  }
  return key;
}

/**
 * Vérifie signature, expiration et émetteur d'un jeton, puis retourne ses
 * claims. Lève une erreur explicite en cas de rejet.
 */
export async function verifyToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw authError('Jeton malformé.', 'TOKEN_MALFORMED');

  const [rawHeader, rawPayload, rawSignature] = parts;

  let header;
  let claims;
  try {
    header = JSON.parse(decodeSegment(rawHeader).toString('utf8'));
    claims = JSON.parse(decodeSegment(rawPayload).toString('utf8'));
  } catch {
    throw authError('Jeton illisible.', 'TOKEN_MALFORMED');
  }

  const algorithm = ALGORITHMS[header.alg];
  // Refuser explicitement `none` et les algorithmes non prévus : accepter
  // l'algorithme annoncé par le jeton lui-même serait une faille classique.
  if (!algorithm) {
    throw authError(`Algorithme de signature non accepté : ${header.alg}.`, 'TOKEN_BAD_ALG');
  }
  if (!header.kid) throw authError('Jeton sans identifiant de clé (kid).', 'TOKEN_NO_KID');

  const key = await getKey(header.kid);

  const verifier = createVerify(algorithm);
  verifier.update(`${rawHeader}.${rawPayload}`);
  verifier.end();

  if (!verifier.verify(key, decodeSegment(rawSignature))) {
    throw authError('Signature du jeton invalide.', 'TOKEN_BAD_SIGNATURE');
  }

  const now = Math.floor(Date.now() / 1000);

  if (typeof claims.exp === 'number' && claims.exp + CLOCK_SKEW_SEC < now) {
    throw authError('Jeton expiré.', 'TOKEN_EXPIRED');
  }
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SEC > now) {
    throw authError('Jeton pas encore valide.', 'TOKEN_NOT_YET_VALID');
  }

  // L'émetteur doit être le realm attendu : un jeton valide d'un autre realm
  // ne doit pas ouvrir l'application.
  if (claims.iss && claims.iss.replace(/\/$/, '') !== realmUrl()) {
    throw authError('Jeton émis par un autre realm.', 'TOKEN_BAD_ISSUER');
  }

  return claims;
}

/**
 * Projette les claims en identité applicative.
 * Même ordre de préférence que le frontend pour le nom affiché, afin que le
 * journal et l'interface désignent une personne de la même façon.
 */
export function toActor(claims) {
  const composed = [claims.given_name, claims.family_name]
    .filter((v) => typeof v === 'string' && v.trim())
    .join(' ')
    .trim();

  const username =
    typeof claims.preferred_username === 'string' &&
    !/^f:[\w-]+:\d+$/.test(claims.preferred_username)
      ? claims.preferred_username
      : '';

  const name =
    (typeof claims.name === 'string' && claims.name.trim()) ||
    composed ||
    (typeof claims.email === 'string' && claims.email.includes('@')
      ? claims.email.split('@')[0]
      : '') ||
    username ||
    'Utilisateur';

  return {
    id: claims.sub ?? null,
    name,
    email: typeof claims.email === 'string' ? claims.email : null,
    roles: claims.realm_access?.roles ?? [],
  };
}

/** Vide le cache des clés — utilisé par les tests. */
export function resetJwksCache() {
  jwksCache = null;
  inFlight = null;
}

export function jwksStatus() {
  return {
    configured: isAuthConfigured(),
    required: config.auth.required,
    realm: isAuthConfigured() ? realmUrl() : null,
    keysCached: jwksCache ? jwksCache.keys.size : 0,
  };
}
