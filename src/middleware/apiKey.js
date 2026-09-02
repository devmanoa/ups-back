import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

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

/** Application correspondant à une clé, ou null. */
export function findApiClient(key) {
  if (!key) return null;
  return config.apiKeys.find((entry) => safeEqual(entry.key, key)) ?? null;
}

/** Au moins une clé est configurée. */
export function isApiKeyConfigured() {
  return config.apiKeys.length > 0;
}

/**
 * Exige une clé d'API valide.
 *
 * Refuse par défaut : sans clé configurée, la route reste fermée. Ouvrir
 * l'API faute de configuration laisserait n'importe qui générer des
 * étiquettes facturées sur le compte UPS.
 */
export function requireApiKey(req, res, next) {
  if (!isApiKeyConfigured()) {
    return next(
      Object.assign(
        new Error('API non configurée. Renseignez API_KEYS au format « nom:clé ».'),
        { status: 503, code: 'API_KEYS_NOT_CONFIGURED' },
      ),
    );
  }

  const provided = (req.headers['x-api-key'] || '').toString().trim();
  const client = findApiClient(provided);

  if (!client) {
    return next(
      Object.assign(new Error('Clé d’API absente ou invalide.'), {
        status: 401,
        code: 'INVALID_API_KEY',
      }),
    );
  }

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
}
