import { API_VERSIONS } from '../config.js';
import { upsFetch } from './upsClient.js';

const V = API_VERSIONS.tracking;

/**
 * Forme canonique d'un numéro de suivi pour comparaison : seuls les
 * caractères alphanumériques identifient un colis, les séparateurs
 * (espaces, tirets, points) collés depuis un e-mail ou une facture
 * ne doivent pas faire échouer la correspondance.
 */
export function normalizeTrackingNumber(value) {
  return String(value ?? '').replace(/[^0-9a-z]/gi, '').toUpperCase();
}

/**
 * Retrouve, parmi les colis d'une réponse, celui qui correspond au numéro
 * interrogé. La correspondance accepte deux formes :
 * - le numéro du colis lui-même ;
 * - l'inquiryNumber de son envoi — UPS y renvoie le numéro interrogé quand
 *   le colis porte un alias (Mail Innovations) ou aucun numéro propre.
 *
 * Les réponses de démonstration (renvoyées pour un numéro inexistant)
 * portent leur propre numéro aux deux niveaux — vérifié sur l'API réelle —
 * et ne correspondent donc jamais.
 */
export function findMatchingPackage(packages, inquiryNumber) {
  const wanted = normalizeTrackingNumber(inquiryNumber);
  if (!wanted) return undefined;
  return packages.find(
    (p) =>
      normalizeTrackingNumber(p.trackingNumber) === wanted ||
      normalizeTrackingNumber(p.shipmentInquiryNumber) === wanted,
  );
}

/**
 * Suit un colis par son numéro de tracking (1Z...).
 * GET /api/track/v1/details/{inquiryNumber}
 *
 * En plus des colis, la réponse porte `matched` : faux quand UPS a répondu
 * pour un autre numéro (colis de démonstration) — chaque consommateur n'a
 * ainsi pas à redécouvrir ce piège.
 */
export async function trackByNumber(inquiryNumber, { locale = 'fr_FR', returnSignature = false } = {}) {
  const data = await upsFetch(`/track/${V}/details/${encodeURIComponent(inquiryNumber)}`, {
    query: {
      locale,
      returnSignature: returnSignature ? 'true' : 'false',
      returnMilestones: 'true',
    },
  });

  const result = normalizeTracking(data);
  return {
    ...result,
    queriedNumber: inquiryNumber,
    matched: Boolean(findMatchingPackage(result.packages, inquiryNumber)),
  };
}

/**
 * Suit des colis via une référence expéditeur.
 * GET /api/track/v1/reference/details/{referenceNumber}
 */
export async function trackByReference(referenceNumber, { locale = 'fr_FR', fromPickUpDate, toPickUpDate } = {}) {
  const data = await upsFetch(
    `/track/${V}/reference/details/${encodeURIComponent(referenceNumber)}`,
    { query: { locale, fromPickUpDate, toPickUpDate } },
  );
  return normalizeTracking(data);
}

/** Formate une date UPS (YYYYMMDD) + heure (HHmmss) en ISO 8601. */
function toIso(date, time) {
  if (!date || date.length !== 8) return null;
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  if (!time || time.length < 6) return iso;
  return `${iso}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
}

function formatAddress(addr = {}) {
  const parts = [
    addr.addressLine1,
    addr.city,
    addr.stateProvince,
    addr.postalCode,
    addr.country || addr.countryCode,
  ].filter(Boolean);
  return parts.join(', ');
}

/**
 * Aplatit la réponse UPS (très imbriquée) en une structure exploitable par le front.
 */
function normalizeTracking(data) {
  const shipments = data?.trackResponse?.shipment || [];

  const packages = shipments.flatMap((shipment) =>
    (shipment.package || []).map((pkg) => {
      const activities = (pkg.activity || []).map((act) => ({
        date: toIso(act.date, act.time),
        status: act.status?.description || '',
        statusCode: act.status?.code || '',
        statusType: act.status?.type || '',
        location: formatAddress(act.location?.address),
      }));

      const delivery = (pkg.deliveryDate || []).find((d) => d.type === 'DEL') || pkg.deliveryDate?.[0];

      return {
        // Repli sur le numéro d'envoi : UPS omet parfois le numéro par-colis
        // (Mail Innovations, réponses par référence).
        trackingNumber: pkg.trackingNumber || shipment.inquiryNumber || '',
        // Conservé pour la correspondance par alias (cf. findMatchingPackage).
        shipmentInquiryNumber: shipment.inquiryNumber || '',
        currentStatus: pkg.currentStatus?.description || activities[0]?.status || 'Inconnu',
        currentStatusCode: pkg.currentStatus?.code || '',
        service: pkg.service?.description || '',
        weight: pkg.weight ? `${pkg.weight.weight} ${pkg.weight.unitOfMeasurement}` : null,
        deliveryDate: delivery ? toIso(delivery.date) : null,
        deliveryTime: pkg.deliveryTime?.endTime || null,
        deliveredTo: pkg.deliveryInformation?.receivedBy || null,
        deliveryLocation: pkg.deliveryInformation?.location || null,
        referenceNumbers: (pkg.referenceNumber || []).map((r) => r.number),
        activities,
      };
    }),
  );

  return { packages, raw: data };
}
