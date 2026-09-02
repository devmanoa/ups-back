import 'dotenv/config';

const BASE_URLS = {
  test: 'https://wwwcie.ups.com',
  production: 'https://onlinetools.ups.com',
};

const env = (process.env.UPS_ENV || 'test').toLowerCase();

if (!BASE_URLS[env]) {
  throw new Error(`UPS_ENV invalide: "${env}". Valeurs acceptées: test | production`);
}

/**
 * Analyse API_KEYS : « antennes:cle-secrete,crm:autre-cle ».
 *
 * Le nom précède la clé pour que le journal nomme l'application appelante.
 * Une entrée sans deux-points est ignorée plutôt que traitée comme une clé
 * anonyme : mieux vaut une clé inopérante qu'une clé acceptée sans auteur.
 */
function parseApiKeys(raw) {
  return (raw || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf(':');
      if (at <= 0) {
        console.warn(`[config] API_KEYS : entrée ignorée, format attendu « nom:clé »`);
        return null;
      }
      return { name: entry.slice(0, at).trim(), key: entry.slice(at + 1).trim() };
    })
    .filter((k) => k && k.name && k.key);
}

export const config = {
  env,
  baseUrl: BASE_URLS[env],
  // trim() : un espace ou un retour-ligne collé par erreur dans l'interface de
  // déploiement casserait l'encodage Basic sans message explicite.
  clientId: (process.env.UPS_CLIENT_ID || '').trim(),
  clientSecret: (process.env.UPS_CLIENT_SECRET || '').trim(),
  accountNumber: (process.env.UPS_ACCOUNT_NUMBER || '').trim(),
  port: Number(process.env.PORT) || 3000,
  // Sans DATABASE_URL, l'application fonctionne mais sans historique d'envois.
  databaseUrl: (process.env.DATABASE_URL || '').trim(),
  // Les bases managées exigent TLS ; le réseau interne Coolify non.
  databaseSsl: process.env.DATABASE_SSL === 'true',
  // Seuils de détection d'anomalies, en jours.
  anomalies: {
    // Colis sans aucun mouvement alors qu'il devrait circuler.
    stalledDays: Number(process.env.ANOMALY_STALLED_DAYS) || 3,
    // Étiquette créée mais colis jamais scanné par UPS.
    neverPickedUpDays: Number(process.env.ANOMALY_NEVER_PICKED_UP_DAYS) || 2,
    // Repli quand UPS n'a pas fourni de date de livraison prévue.
    fallbackDelayDays: Number(process.env.ANOMALY_FALLBACK_DELAY_DAYS) || 7,
  },
  // === Authentification Keycloak ===
  // Le frontend envoie déjà un jeton Bearer ; sans KEYCLOAK_URL il est ignoré.
  // AUTH_REQUIRED=true rejette les appels non authentifiés : à n'activer
  // qu'une fois le client Keycloak vérifié, sinon toute l'application devient
  // inaccessible.
  auth: {
    keycloakUrl: (process.env.KEYCLOAK_URL || '').trim().replace(/\/$/, ''),
    realm: (process.env.KEYCLOAK_REALM || 'konitys').trim(),
    required: process.env.AUTH_REQUIRED === 'true',
  },
  // === API machine (/api/v1) ===
  // Clés des applications tierces, au format « nom:clé », séparées par des
  // virgules. Le nom sert d'auteur dans le journal : sans lui, les envois
  // d'une autre application seraient anonymes. Une clé se révoque en la
  // retirant de la variable, sans toucher au code.
  apiKeys: parseApiKeys(process.env.API_KEYS),
  // === Application Antennes ===
  // Un lien depuis Antennes ouvre la page Étiquettes avec l'adresse de
  // l'antenne préremplie. Le jeton reste ici : le transmettre dans l'URL du
  // navigateur le laisserait dans l'historique, les journaux et le Referer.
  antennes: {
    apiUrl: (process.env.ANTENNES_API_URL || '').trim().replace(/\/$/, ''),
    token: (process.env.ANTENNES_WS_TOKEN || '').trim(),
  },
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  shipper: {
    name: process.env.SHIPPER_NAME || '',
    attentionName: process.env.SHIPPER_ATTENTION_NAME || '',
    phone: process.env.SHIPPER_PHONE || '',
    addressLine: process.env.SHIPPER_ADDRESS_LINE || '',
    city: process.env.SHIPPER_CITY || '',
    postalCode: process.env.SHIPPER_POSTAL_CODE || '',
    state: process.env.SHIPPER_STATE || '',
    country: process.env.SHIPPER_COUNTRY || 'FR',
  },
};

/**
 * Versions d'API figées d'après les specs OpenAPI officielles UPS
 * (https://github.com/UPS-API/api-documentation).
 */
export const API_VERSIONS = {
  tracking: 'v1',
  rating: 'v2409',
  shipping: 'v2409',
  locator: 'v3',
  pickup: 'v2409',
  timeInTransit: 'v1',
  landedCost: 'v1',
  paperless: 'v2',
  quantumView: 'v3',
};

export function assertCredentials() {
  if (!config.clientId || !config.clientSecret) {
    throw Object.assign(
      new Error(
        'Identifiants UPS manquants. Renseignez UPS_CLIENT_ID et UPS_CLIENT_SECRET dans le fichier .env',
      ),
      { status: 500, code: 'MISSING_CREDENTIALS' },
    );
  }
}
