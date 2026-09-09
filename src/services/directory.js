import { config } from '../config.js';

/**
 * Annuaire des utilisateurs, lu via l'API Admin de Keycloak.
 *
 * Sert les mentions « @Julie » : le journal ne connaît que les personnes
 * ayant déjà agi dans l'application, et ne permettrait pas de mentionner un
 * collègue qui n'a jamais créé d'étiquette.
 *
 * Le compte de service est distinct du client navigateur. Son secret reste
 * ici : exposé au front, il permettrait à quiconque de lister tout le realm.
 */

/** Jetons Keycloak : durée courte, on garde une marge avant expiration. */
const TOKEN_SKEW_MS = 30_000;

/** Un annuaire change rarement ; la frappe d'une mention ne doit pas
 *  déclencher un appel par caractère. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Plafond Keycloak : au-delà, l'utilisateur affine sa recherche. */
const MAX_RESULTS = 20;

let tokenCache = null; // { token, expiresAt }
let inFlightToken = null;
const searchCache = new Map(); // terme → { users, fetchedAt }

export function isDirectoryConfigured() {
  return Boolean(
    config.auth.keycloakUrl && config.auth.adminClientId && config.auth.adminClientSecret,
  );
}

function directoryError(message, code, status = 502) {
  return Object.assign(new Error(message), { status, code });
}

/**
 * Jeton du compte de service, mis en cache jusqu'à son expiration.
 * Les appels concurrents partagent la même requête.
 */
async function getToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  if (inFlightToken) return inFlightToken;

  const url = `${config.auth.keycloakUrl}/realms/${config.auth.realm}/protocol/openid-connect/token`;

  inFlightToken = (async () => {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: config.auth.adminClientId,
          client_secret: config.auth.adminClientSecret,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw directoryError(`Keycloak injoignable : ${err.message}`, 'KEYCLOAK_UNREACHABLE', 503);
    }

    if (!res.ok) {
      // 401 ici vient de notre configuration, pas de l'utilisateur : le
      // secret du compte de service est faux ou le client n'existe pas.
      throw directoryError(
        `Compte de service Keycloak refusé (HTTP ${res.status}). Vérifiez KEYCLOAK_ADMIN_CLIENT_ID et son secret.`,
        'DIRECTORY_FORBIDDEN',
      );
    }

    const data = await res.json();
    tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 60) * 1000 - TOKEN_SKEW_MS,
    };
    return tokenCache.token;
  })().finally(() => {
    inFlightToken = null;
  });

  return inFlightToken;
}

/** Nom affichable, avec repli sur le nom d'utilisateur. */
function displayName(user) {
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return full || user.username || user.email || 'Utilisateur';
}

function toUser(user) {
  return {
    id: user.id,
    username: user.username ?? null,
    name: displayName(user),
    email: user.email ?? null,
  };
}

/**
 * Cherche des utilisateurs par nom, prénom, identifiant ou courriel.
 *
 * Un terme vide renvoie les premiers utilisateurs du realm : c'est ce qui
 * s'affiche à l'ouverture du menu de mention, avant toute frappe.
 */
export async function searchUsers(term = '', { limit = MAX_RESULTS } = {}) {
  if (!isDirectoryConfigured()) return [];

  const key = `${term.trim().toLowerCase()}|${limit}`;
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.users;

  const token = await getToken();
  const params = new URLSearchParams({
    max: String(Math.min(limit, MAX_RESULTS)),
    // Exclut les comptes désactivés : mentionner quelqu'un qui ne peut plus
    // se connecter enverrait une notification que personne ne lira.
    enabled: 'true',
  });
  if (term.trim()) params.set('search', term.trim());

  const url = `${config.auth.keycloakUrl}/admin/realms/${config.auth.realm}/users?${params}`;

  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw directoryError(`Keycloak injoignable : ${err.message}`, 'KEYCLOAK_UNREACHABLE', 503);
  }

  if (res.status === 403) {
    throw directoryError(
      "Le compte de service n'a pas le rôle « view-users » sur le realm.",
      'DIRECTORY_FORBIDDEN',
    );
  }
  if (!res.ok) {
    throw directoryError(`Annuaire Keycloak indisponible (HTTP ${res.status}).`, 'DIRECTORY_ERROR');
  }

  const users = (await res.json()).map(toUser);
  searchCache.set(key, { users, fetchedAt: Date.now() });
  return users;
}

/**
 * Retrouve des utilisateurs par identifiant, pour résoudre des mentions.
 * Les identifiants inconnus sont simplement absents du résultat.
 */
export async function findUsersByIds(ids = []) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length || !isDirectoryConfigured()) return [];

  const token = await getToken();

  const found = await Promise.all(
    unique.map(async (id) => {
      try {
        const res = await fetch(
          `${config.auth.keycloakUrl}/admin/realms/${config.auth.realm}/users/${encodeURIComponent(id)}`,
          { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
        );
        return res.ok ? toUser(await res.json()) : null;
      } catch {
        // Un utilisateur illisible ne doit pas faire échouer les autres.
        return null;
      }
    }),
  );

  return found.filter(Boolean);
}

/** Vide les caches. Réservé aux tests. */
export function resetDirectoryCache() {
  tokenCache = null;
  searchCache.clear();
}

/** État de l'annuaire, pour /health. */
export function directoryStatus() {
  return {
    configured: isDirectoryConfigured(),
    tokenCached: Boolean(tokenCache && Date.now() < tokenCache.expiresAt),
    cachedSearches: searchCache.size,
  };
}
