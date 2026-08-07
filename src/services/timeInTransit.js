import { API_VERSIONS, config } from '../config.js';
import { upsFetch } from './upsClient.js';

const V = API_VERSIONS.timeInTransit;

/** Formate une date ISO (YYYY-MM-DD) telle qu'attendue par l'API. */
function toApiDate(value) {
  if (!value) {
    // Par défaut : aujourd'hui, date d'expédition la plus courante.
    return new Date().toISOString().slice(0, 10);
  }
  return value.slice(0, 10);
}

/**
 * Estime les délais de livraison entre deux adresses.
 * POST /api/shipments/v1/transittimes
 */
export async function getTransitTimes({
  shipFrom,
  shipTo,
  weight,
  weightUnit = 'KGS',
  shipDate,
  numberOfPackages = 1,
  shipmentValue,
  currency = 'EUR',
  residential = false,
}) {
  const from = shipFrom || {
    city: config.shipper.city,
    state: config.shipper.state,
    postalCode: config.shipper.postalCode,
    country: config.shipper.country,
  };

  const body = {
    originCountryCode: from.country || 'FR',
    originStateProvince: from.state || '',
    originCityName: from.city || '',
    originTownName: '',
    originPostalCode: from.postalCode || '',
    destinationCountryCode: shipTo.country || 'FR',
    destinationStateProvince: shipTo.state || '',
    destinationCityName: shipTo.city || '',
    destinationTownName: '',
    destinationPostalCode: shipTo.postalCode || '',
    weight: String(weight ?? 1),
    weightUnitOfMeasure: weightUnit,
    shipmentContentsValue: String(shipmentValue ?? 0),
    shipmentContentsCurrencyCode: currency,
    billType: '03', // 03 = envoi non documentaire (marchandise)
    shipDate: toApiDate(shipDate),
    shipTime: '',
    residentialIndicator: residential ? '01' : '',
    avvFlag: true,
    numberOfPackages: String(numberOfPackages),
  };

  const data = await upsFetch(`/shipments/${V}/transittimes`, { method: 'POST', body });
  return normalizeTransit(data);
}

/** Convertit une date UPS (YYYY-MM-DD ou YYYYMMDD) en ISO. */
function toIsoDate(value) {
  if (!value) return null;
  if (value.includes('-')) return value;
  if (value.length === 8) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  return value;
}

function toIsoTime(value) {
  if (!value) return null;
  // UPS renvoie soit HH:mm:ss soit HHmmss selon le service.
  if (value.includes(':')) return value.slice(0, 5);
  if (value.length >= 4) return `${value.slice(0, 2)}:${value.slice(2, 4)}`;
  return value;
}

function normalizeTransit(data) {
  const services = data?.emsResponse?.services || [];

  const results = services.map((s) => ({
    serviceCode: s.serviceLevel || '',
    serviceName: s.serviceLevelDescription || s.serviceLevel || 'Service UPS',
    businessDaysInTransit: s.businessTransitDays ? Number(s.businessTransitDays) : null,
    deliveryDate: toIsoDate(s.deliveryDate),
    deliveryTime: toIsoTime(s.deliveryTime),
    // UPS marque d'un indicateur les services dont le délai est garanti.
    guaranteed: s.guaranteeIndicator === '1' || s.guaranteeIndicator === 'Y',
    pickupDate: toIsoDate(s.pickupDate),
    totalTransitDays: s.totalTransitDays ? Number(s.totalTransitDays) : null,
  }));

  // Le service le plus rapide en premier ; ceux sans délai connu à la fin.
  results.sort((a, b) => {
    const da = a.businessDaysInTransit ?? Number.MAX_SAFE_INTEGER;
    const db = b.businessDaysInTransit ?? Number.MAX_SAFE_INTEGER;
    return da - db;
  });

  return { services: results, raw: data };
}
