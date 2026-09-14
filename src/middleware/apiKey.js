import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { isDbEnabled } from '../db/pool.js';
import { findByToken, touchKey, hasActiveKeys } from '../db/apiKeysRepository.js';
import { asyncHandler } from './validate.js';

/**
 * Authentification des applications tierces par clé d'API.
 *
 * Distincte de Keycloak, qui identifie des personnes : ici l'appelant est un
 * serveur, sans navigateur pour dérouler un flux OAuth. La clé arrive dans
 * l'en-tête `X-API-Key`, jamais dans l'URL — une URL se retrouve dans les
 * journaux d'accès, l'historique et le Referer.
 *
 * L'application authentifiée devient `req.actor` : le journal d'activité la
 * nomme alors comme auteur, exactement comme un utilisateur connecté.
 */

/**
 * Comparaison à durée constante.
 *
 * Un `===` sort au premier caractère différent : en mesurant le temps de
 * réponse, un attaquant retrouverait la clé caractère par caractère. La
 * longueur est comparée d'abord car timingSafeEqual lève si elle diffère —
 * elle n'est pas secrète, contrairement au contenu.
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Application correspondant à une clé de la variable d'environnement. */
export function findApiClient(key) {
  if (!key) return null;
  return config.apiKeys.find((entry) => safeEqual(entry.key, key)) ?? null;
}

/**
 * Application correspondant à une clé, cherchée dans les deux sources.
 *
 * La variable d'environnement d'abord : elle ne dépend pas de la base, et
 * reste le moyen de rétablir un accès si celle-ci est indisponible. Les clés
 * créées depuis l'admin vivent en base et survivent au redéploiement.
 */
export async function resolveApiClient(key) {
  const fromEnv = findApiClient(key);
  if (fromEnv) return { name: fromEnv.name, source: 'env' };

  if (!isDbEnabled()) return null;

  try {
    const row = await findByToken(key);
    return row ? { name: row.name, source: 'db', id: row.id } : null;
  } catch (err) {
    // Base indisponible : une panne serveur, pas une clé fausse. Renvoyer
    // « clé invalide » ferait tourner les clés d'un partenaire pour rien, et
    // un client qui ne réessaie que sur 5xx abandonnerait pour de bon.
    console.warn(`[api] Clés en base illisibles : ${err.message}`);
    throw Object.assign(new Error('Vérification de la clé impossible : base indisponible.'), {
      status: 503,
      code: 'API_KEYS_UNAVAILABLE',
    });
  }
}

/** Au moins une clé est configurée dans la variable d'environnement. */
export function isApiKeyConfigured() {
  return config.apiKeys.length > 0;
}

/**
 * L'API peut-elle authentifier quelqu'un ?
 *
 * Vrai dès qu'une source est exploitable. La base compte même vide : une clé
 * peut y être créée depuis l'admin sans redéployer, alors qu'une variable
 * d'environnement absente exige une intervention.
 */
export function isApiUsable() {
  return isApiKeyConfigured() || isDbEnabled();
}

/**
 * Exige une clé d'API valide.
 *
 * Refuse par défaut : sans clé configurée, la route reste fermée. Ouvrir
 * l'API faute de configuration laisserait n'importe qui générer des
 * étiquettes facturées sur le compte UPS.
 */
const notConfigured = () =>
  Object.assign(
    new Error(
      'API non configurée. Créez une clé depuis l’admin panel, ou renseignez API_KEYS au format « nom:clé ».',
    ),
    { status: 503, code: 'API_KEYS_NOT_CONFIGURED' },
  );

// Enveloppé par asyncHandler : Express 4 n'attend pas un middleware async,
// et une exception y resterait une promesse rejetée sans réponse HTTP — la
// requête pendrait jusqu'au délai du client.
export const requireApiKey = asyncHandler(async (req, res, next) => {
  if (!isApiUsable()) return next(notConfigured());

  const provided = (req.headers['x-api-key'] || '').toString().trim();
  const client = await resolveApiClient(provided);

  if (!client) {
    // Aucune clé nulle part : dire « clé invalide » enverrait l'intégrateur
    // vérifier un jeton correct, alors que c'est le serveur qui n'en a pas.
    if (!isApiKeyConfigured() && !(await hasActiveKeys())) return next(notConfigured());

    return next(
      Object.assign(new Error('Clé d’API absente ou invalide.'), {
        status: 401,
        code: 'INVALID_API_KEY',
      }),
    );
  }

  // Compteur d'usage : non attendu, il ne doit pas retarder la requête.
  if (client.source === 'db') touchKey(client.id);

  // Même forme que l'acteur Keycloak : le journal et les routes existantes
  // n'ont pas à distinguer une personne d'une application.
  req.actor = {
    id: `api:${client.name}`,
    name: client.name,
    email: null,
    type: 'api',
  };
  req.apiClient = client.name;

  next();
});
