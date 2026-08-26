import { API_VERSIONS, config } from '../config.js';
import { upsFetch } from './upsClient.js';

const V = API_VERSIONS.shipping;

/** Formats d'étiquette supportés. */
export const LABEL_FORMATS = {
  GIF: { code: 'GIF', mime: 'image/gif', ext: 'gif' },
  ZPL: { code: 'ZPL', mime: 'text/plain', ext: 'zpl' },
  EPL: { code: 'EPL', mime: 'text/plain', ext: 'epl' },
  SPL: { code: 'SPL', mime: 'text/plain', ext: 'spl' },
  PDF: { code: 'PDF', mime: 'application/pdf', ext: 'pdf' },
};

function buildParty(p, { withPhone = true } = {}) {
  return {
    Name: p.name || '',
    ...(p.attentionName ? { AttentionName: p.attentionName } : {}),
    ...(withPhone && p.phone ? { Phone: { Number: p.phone } } : {}),
    Address: {
      AddressLine: [p.addressLine1, p.addressLine2].filter(Boolean),
      City: p.city || '',
      ...(p.state ? { StateProvinceCode: p.state } : {}),
      PostalCode: p.postalCode || '',
      CountryCode: p.country || 'FR',
      ...(p.residential ? { ResidentialAddressIndicator: 'Y' } : {}),
    },
  };
}

function buildPackage(pkg) {
  return {
    ...(pkg.description ? { Description: pkg.description } : {}),
    Packaging: { Code: pkg.packagingType || '02' },
    ...(pkg.length && pkg.width && pkg.height
      ? {
          Dimensions: {
            UnitOfMeasurement: { Code: pkg.dimUnit || 'CM' },
            Length: String(pkg.length),
            Width: String(pkg.width),
            Height: String(pkg.height),
          },
        }
      : {}),
    PackageWeight: {
      UnitOfMeasurement: { Code: pkg.weightUnit || 'KGS' },
      Weight: String(pkg.weight),
    },
    ...(pkg.reference ? { ReferenceNumber: [{ Code: '02', Value: pkg.reference }] } : {}),
  };
}

/**
 * Crée une expédition et génère l'étiquette.
 * POST /api/shipments/v2409/ship
 */
export async function createShipment({
  shipTo,
  shipFrom,
  packages,
  serviceCode = '11',
  description = 'Marchandise',
  labelFormat = 'GIF',
  paymentAccountNumber,
  accessPointLocationId,
}) {
  if (!config.accountNumber) {
    throw Object.assign(
      new Error('UPS_ACCOUNT_NUMBER est requis pour créer une expédition. Renseignez-le dans le .env'),
      { status: 400, code: 'MISSING_ACCOUNT_NUMBER' },
    );
  }

  const shipper = shipFrom || {
    name: config.shipper.name,
    attentionName: config.shipper.attentionName,
    phone: config.shipper.phone,
    addressLine1: config.shipper.addressLine,
    city: config.shipper.city,
    state: config.shipper.state,
    postalCode: config.shipper.postalCode,
    country: config.shipper.country,
  };

  const format = LABEL_FORMATS[labelFormat] || LABEL_FORMATS.GIF;
  const billingAccount = paymentAccountNumber || config.accountNumber;

  const body = {
    ShipmentRequest: {
      Request: {
        RequestOption: 'nonvalidate',
        TransactionReference: { CustomerContext: 'ups-backend shipping' },
      },
      Shipment: {
        Description: description,
        Shipper: {
          ...buildParty(shipper),
          ShipperNumber: config.accountNumber,
        },
        ShipTo: buildParty(shipTo),
        ShipFrom: buildParty(shipper),
        PaymentInformation: {
          ShipmentCharge: {
            Type: '01', // 01 = frais de transport
            BillShipper: { AccountNumber: billingAccount },
          },
        },
        Service: { Code: serviceCode },
        Package: packages.map(buildPackage),
        // Livraison en point relais : UPS exige l'indicateur + l'ID du point.
        ...(accessPointLocationId
          ? {
              ShipmentIndicationType: [
                { Code: '01', AccessPointDetails: { AccessPointLocationID: accessPointLocationId } },
              ],
            }
          : {}),
      },
      LabelSpecification: {
        LabelImageFormat: { Code: format.code },
        ...(format.code === 'GIF' ? { HTTPUserAgent: 'Mozilla/5.0' } : {}),
      },
    },
  };

  const data = await upsFetch(`/shipments/${V}/ship`, { method: 'POST', body });

  // L'expéditeur retenu remonte avec le résultat : c'est lui qui sera figé
  // sur l'envoi, et il vient soit de la requête, soit de la configuration.
  return { ...normalizeShipment(data, format), shipper };
}

/**
 * Annule une expédition (void).
 * DELETE /api/shipments/v2409/void/cancel/{shipmentidentificationnumber}
 */
export async function voidShipment(shipmentIdentificationNumber, trackingNumbers) {
  const data = await upsFetch(
    `/shipments/${V}/void/cancel/${encodeURIComponent(shipmentIdentificationNumber)}`,
    {
      method: 'DELETE',
      query: trackingNumbers?.length ? { trackingnumber: trackingNumbers.join(',') } : undefined,
    },
  );

  const status = data?.VoidShipmentResponse?.SummaryResult?.Status;
  return {
    success: status?.Code === '1',
    message: status?.Description || 'Statut inconnu',
    raw: data,
  };
}

function normalizeShipment(data, format) {
  const result = data?.ShipmentResponse?.ShipmentResults || {};
  const pkgResults = result.PackageResults
    ? Array.isArray(result.PackageResults)
      ? result.PackageResults
      : [result.PackageResults]
    : [];

  const charges = result.ShipmentCharges || {};
  const negotiated = result.NegotiatedRateCharges?.TotalCharge;

  return {
    shipmentIdentificationNumber: result.ShipmentIdentificationNumber || '',
    totalCharges: Number(negotiated?.MonetaryValue ?? charges.TotalCharges?.MonetaryValue ?? 0),
    currency: negotiated?.CurrencyCode || charges.TotalCharges?.CurrencyCode || 'EUR',
    billingWeight: result.BillingWeight
      ? `${result.BillingWeight.Weight} ${result.BillingWeight.UnitOfMeasurement?.Code || ''}`.trim()
      : null,
    packages: pkgResults.map((p) => ({
      trackingNumber: p.TrackingNumber || '',
      // L'étiquette est renvoyée en base64 ; le front la décode pour l'afficher/télécharger.
      label: p.ShippingLabel?.GraphicImage
        ? {
            base64: p.ShippingLabel.GraphicImage,
            mime: format.mime,
            ext: format.ext,
          }
        : null,
    })),
    raw: data,
  };
}
