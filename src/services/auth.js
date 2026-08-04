import { config, assertCredentials } from '../config.js';

/**
 * Cache mémoire du jeton OAuth. UPS facture/limite les appels au endpoint token,
 * et un jeton reste valide ~4h : on le réutilise jusqu'à sa marge d'expiration.
 */
let cachedToken = null; // { accessToken, expiresAt }
let inFlight = null; // Promise partagée pour éviter les requêtes concurrentes

const EXPIRY_MARGIN_MS = 60 * 1000; // renouvelle 1 min avant l'expiration réelle

function isValid(token) {
  return token && token.expiresAt > Date.now() + EXPIRY_MARGIN_MS;
}

async function requestToken() {
  assertCredentials();

  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'client_credentials' });

  const res = await fetch(`${config.baseUrl}/security/v1/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(config.accountNumber ? { 'x-merchant-id': config.accountNumber } : {}),
    },
    body,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw Object.assign(new Error(`Réponse OAuth UPS illisible: ${text.slice(0, 300)}`), {
      status: 502,
      code: 'OAUTH_BAD_RESPONSE',
    });
  }

  if (!res.ok) {
    const desc =
      data?.response?.errors?.[0]?.message ||
      data?.error_description ||
      data?.error ||
      'Échec de l’authentification UPS';
    throw Object.assign(new Error(desc), {
      status: res.status === 401 ? 401 : 502,
      code: 'OAUTH_FAILED',
      details: data,
    });
  }

  // expires_in est renvoyé en secondes sous forme de chaîne par UPS.
  const expiresInSec = Number(data.expires_in) || 14399;

  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + expiresInSec * 1000,
  };
}

/**
 * Retourne un jeton d'accès valide, en réutilisant le cache si possible.
 */
export async function getAccessToken() {
  if (isValid(cachedToken)) return cachedToken.accessToken;

  // Si un renouvellement est déjà en cours, on attend le même résultat.
  if (inFlight) return inFlight;

  inFlight = requestToken()
    .then((token) => {
      cachedToken = token;
      return token.accessToken;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Invalide le cache — utile après une 401 renvoyée par une API métier. */
export function invalidateToken() {
  cachedToken = null;
}

export function tokenStatus() {
  return {
    cached: Boolean(cachedToken),
    expiresAt: cachedToken ? new Date(cachedToken.expiresAt).toISOString() : null,
    valid: Boolean(isValid(cachedToken)),
  };
}
