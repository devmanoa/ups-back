import { config } from '../config.js';

/**
 * Lecture des contacts de l'application Antennes.
 *
 * Un lien depuis Antennes (`/shipping?antenne=10`) ouvre la page Étiquettes
 * avec l'adresse de l'antenne déjà remplie. Le jeton d'accès vit ici, pas
 * dans l'URL du navigateur : il n'a rien à faire dans un historique ni dans
 * un en-tête Referer.
 */

/** Au-delà, on abandonne : la page doit répondre même si Antennes est lent. */
const TIMEOUT_MS = 8000;

export function isAntennesConfigured() {
  return Boolean(config.antennes.apiUrl && config.antennes.token);
}

function antennesError(message, code, status) {
  return Object.assign(new Error(message), { status, code });
}

/**
 * Convertit un contact Antennes en destinataire d'expédition.
 *
 * Les champs absents deviennent des chaînes vides plutôt que `null` : le
 * formulaire les rendrait sinon comme le texte « null ».
 */
function toRecipient(contact) {
  // `raison_sociale` d'abord : une étiquette part vers une société quand il
  // y en a une, la personne devenant le contact à l'attention duquel livrer.
  const person = [contact.prenom, contact.nom].filter(Boolean).join(' ').trim();
  const company = (contact.raison_sociale || '').trim();

  return {
    name: company || person || '',
    attentionName: company ? person : '',
    phone: (contact.tel_portable || contact.tel_fixe || '').trim(),
    email: (contact.email || '').trim(),
    addressLine1: (contact.adresse || '').trim(),
    addressLine2: (contact.adresse_complementaire || '').trim(),
    city: (contact.ville || '').trim(),
    postalCode: (contact.cp || '').trim(),
    // L'API donne le pays en toutes lettres ; UPS attend un code ISO 2.
    country: countryCode(contact.pays_nom),
    state: '',
  };
}

/**
 * Nom de pays vers code ISO 2.
 *
 * Volontairement limité aux pays où nous expédions : une table complète
 * serait du code mort, et un pays inconnu se corrige à la main dans le
 * formulaire plutôt que d'être deviné.
 */
const COUNTRIES = {
  france: 'FR',
  belgique: 'BE',
  belgium: 'BE',
  suisse: 'CH',
  luxembourg: 'LU',
  allemagne: 'DE',
  espagne: 'ES',
  italie: 'IT',
  'pays-bas': 'NL',
  portugal: 'PT',
  'royaume-uni': 'GB',
};

function countryCode(name) {
  const clean = String(name ?? '').trim().toLowerCase();
  if (!clean) return 'FR';
  // Déjà un code ISO 2 : on le garde tel quel.
  if (clean.length === 2) return clean.toUpperCase();
  return COUNTRIES[clean] ?? 'FR';
}

/**
 * Récupère un contact Antennes et le renvoie prêt à remplir le formulaire.
 *
 * Les erreurs sont traduites plutôt que relayées : l'utilisateur n'a pas à
 * lire un code HTTP d'une API dont il ignore l'existence.
 */
export async function getContact(contactId) {
  if (!isAntennesConfigured()) {
    throw antennesError(
      "L'intégration Antennes n'est pas configurée. Renseignez ANTENNES_API_URL et ANTENNES_WS_TOKEN.",
      'ANTENNES_NOT_CONFIGURED',
      503,
    );
  }

  const url = `${config.antennes.apiUrl}/ws/contacts/${encodeURIComponent(contactId)}?ws_token=${encodeURIComponent(config.antennes.token)}`;

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw antennesError(
      `L'application Antennes est injoignable : ${err.message}`,
      'ANTENNES_UNREACHABLE',
      502,
    );
  }

  if (response.status === 404) {
    throw antennesError(
      `Aucune antenne ne porte l'identifiant ${contactId}.`,
      'ANTENNE_NOT_FOUND',
      404,
    );
  }

  if (response.status === 401 || response.status === 403) {
    // Le jeton est notre configuration, pas une erreur de l'utilisateur :
    // le message doit désigner ce qu'il y a à corriger.
    throw antennesError(
      "Le jeton d'accès à Antennes est refusé. Vérifiez ANTENNES_WS_TOKEN.",
      'ANTENNES_FORBIDDEN',
      502,
    );
  }

  if (!response.ok) {
    throw antennesError(
      `Antennes a répondu ${response.status}.`,
      'ANTENNES_ERROR',
      502,
    );
  }

  const payload = await response.json().catch(() => null);
  const contact = payload?.data;

  if (!contact?.id) {
    throw antennesError('Réponse inattendue de l’application Antennes.', 'ANTENNES_ERROR', 502);
  }

  return {
    contactId: Number(contact.id),
    antenneId: contact.antenne_id != null ? Number(contact.antenne_id) : null,
    antenneVille: contact.antenne_ville || null,
    qualification: contact.qualification || null,
    etat: contact.etat || null,
    recipient: toRecipient(contact),
    // Coordonnées fournies par Antennes : évitent un géocodage sur la carte.
    coordinates:
      contact.addr_lat && contact.addr_lng
        ? { lat: Number(contact.addr_lat), lng: Number(contact.addr_lng) }
        : null,
  };
}
