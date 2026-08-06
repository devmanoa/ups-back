import { API_VERSIONS, config } from '../config.js';
import { upsFetch } from './upsClient.js';

const V = API_VERSIONS.rating;

/** Codes service UPS les plus courants (dépend du pays d'origine). */
export const SERVICE_CODES = {
  '01': 'UPS Next Day Air',
  '02': 'UPS 2nd Day Air',
  '03': 'UPS Ground',
  '07': 'UPS Worldwide Express',
  '08': 'UPS Worldwide Expedited',
  '11': 'UPS Standard',
  '12': 'UPS 3 Day Select',
  '13': 'UPS Next Day Air Saver',
  '14': 'UPS Next Day Air Early',
  '54': 'UPS Worldwide Express Plus',
  '59': 'UPS 2nd Day Air A.M.',
  '65': 'UPS Worldwide Saver',
};

function buildAddress(a = {}) {
  return {
    AddressLine: [a.addressLine1, a.addressLine2].filter(Boolean),
    City: a.city || '',
    ...(a.state ? { StateProvinceCode: a.state } : {}),
    PostalCode: a.postalCode || '',
    CountryCode: a.country || 'FR',
    ...(a.residential ? { ResidentialAddressIndicator: 'Y' } : {}),
  };
}

function buildPackage(pkg) {
  const weightUnit = pkg.weightUnit || 'KGS';
  const dimUnit = pkg.dimUnit || 'CM';

  return {
    PackagingType: { Code: pkg.packagingType || '02' }, // 02 = colis client
    ...(pkg.length && pkg.width && pkg.height
      ? {
          Dimensions: {
            UnitOfMeasurement: { Code: dimUnit },
            Length: String(pkg.length),
            Width: String(pkg.width),
            Height: String(pkg.height),
          },
        }
      : {}),
    PackageWeight: {
      UnitOfMeasurement: { Code: weightUnit },
      Weight: String(pkg.weight),
    },
  };
}

/**
 * Calcule les tarifs d'expédition.
 * POST /api/rating/v2409/{requestoption}
 *
 * @param {object} params
 * @param {'Rate'|'Shop'|'Ratetimeintransit'|'Shoptimeintransit'} params.requestOption
 *        Rate = un service précis, Shop = tous les services disponibles.
 */
export async function getRates({
  shipFrom,
  shipTo,
  packages,
  requestOption = 'Shop',
  serviceCode,
  negotiatedRates = true,
  accessPoint,
}) {
  const from = shipFrom || {
    addressLine1: config.shipper.addressLine,
    city: config.shipper.city,
    state: config.shipper.state,
    postalCode: config.shipper.postalCode,
    country: config.shipper.country,
  };

  const useNegotiated = negotiatedRates && Boolean(config.accountNumber);

  const body = {
    RateRequest: {
      Request: {
        RequestOption: requestOption,
        TransactionReference: { CustomerContext: 'ups-backend rating' },
      },
      Shipment: {
        Shipper: {
          Name: config.shipper.name || 'Shipper',
          ...(config.accountNumber ? { ShipperNumber: config.accountNumber } : {}),
          Address: buildAddress(from),
        },
        ShipTo: {
          Name: shipTo.name || 'Destinataire',
          Address: buildAddress(shipTo),
        },
        ShipFrom: {
          Name: config.shipper.name || 'Shipper',
          Address: buildAddress(from),
        },
        // En mode "Rate" UPS exige un service précis ; en "Shop" il est ignoré.
        ...(requestOption === 'Rate' || requestOption === 'Ratetimeintransit'
          ? { Service: { Code: serviceCode || '11' } }
          : {}),
        Package: packages.map(buildPackage),
        ...(useNegotiated
          ? { ShipmentRatingOptions: { NegotiatedRatesIndicator: 'Y' } }
          : {}),
        // Tarification vers un point relais. UPS impose que l'indicateur soit
        // accompagné de l'adresse du point (AlternateDeliveryAddress) : sans
        // elle, les services Access Point sont rejetés.
        ...(accessPoint
          ? {
              ShipmentIndicationType: [{ Code: accessPoint.indicationType || '02' }],
              AlternateDeliveryAddress: {
                Name: accessPoint.name || 'Point relais',
                Address: buildAddress(accessPoint),
              },
            }
          : {}),
      },
    },
  };

  const data = await upsFetch(`/rating/${V}/${requestOption}`, { method: 'POST', body });
  return normalizeRates(data);
}

function normalizeRates(data) {
  // En mode Shop, UPS tarife tous les services et signale par une alerte ceux
  // qui ne s'appliquent pas (ex. Access Point Economy sans point relais).
  // Ces alertes ne doivent pas masquer les tarifs valides.
  const alertsRaw = data?.RateResponse?.Response?.Alert;
  const warnings = (Array.isArray(alertsRaw) ? alertsRaw : alertsRaw ? [alertsRaw] : []).map(
    (a) => ({ code: a.Code || '', message: a.Description || '' }),
  );

  const rated = data?.RateResponse?.RatedShipment;
  if (!rated) return { rates: [], warnings, raw: data };

  const list = Array.isArray(rated) ? rated : [rated];

  const rates = list.map((r) => {
    const negotiated = r.NegotiatedRateCharges?.TotalCharge;
    const published = r.TotalCharges;
    const serviceCode = r.Service?.Code || '';

    return {
      serviceCode,
      serviceName: SERVICE_CODES[serviceCode] || r.Service?.Description || `Service ${serviceCode}`,
      // Le tarif négocié, quand il existe, est celui réellement facturé.
      totalCharges: Number(negotiated?.MonetaryValue ?? published?.MonetaryValue ?? 0),
      currency: negotiated?.CurrencyCode || published?.CurrencyCode || 'EUR',
      publishedCharges: published ? Number(published.MonetaryValue) : null,
      isNegotiated: Boolean(negotiated),
      billingWeight: r.BillingWeight
        ? `${r.BillingWeight.Weight} ${r.BillingWeight.UnitOfMeasurement?.Code || ''}`.trim()
        : null,
      guaranteedDays: r.GuaranteedDelivery?.BusinessDaysInTransit || null,
      deliveryTime: r.GuaranteedDelivery?.DeliveryByTime || null,
    };
  });

  rates.sort((a, b) => a.totalCharges - b.totalCharges);
  return { rates, warnings, raw: data };
}
