import { API_VERSIONS } from '../config.js';
import { upsFetch } from './upsClient.js';

const V = API_VERSIONS.tracking;

/**
 * Suit un colis par son numéro de tracking (1Z...).
 * GET /api/track/v1/details/{inquiryNumber}
 */
export async function trackByNumber(inquiryNumber, { locale = 'fr_FR', returnSignature = false } = {}) {
  const data = await upsFetch(`/track/${V}/details/${encodeURIComponent(inquiryNumber)}`, {
    query: {
      locale,
      returnSignature: returnSignature ? 'true' : 'false',
      returnMilestones: 'true',
    },
  });
  return normalizeTracking(data);
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
        trackingNumber: pkg.trackingNumber,
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
