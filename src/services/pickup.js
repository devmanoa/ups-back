import { API_VERSIONS, config } from '../config.js';
import { upsFetch } from './upsClient.js';

const V = API_VERSIONS.pickup;

/** Codes conteneur acceptés par l'API Pickup. */
export const CONTAINER_CODES = {
  '01': 'Colis',
  '02': 'Palette',
  '03': 'Enveloppe',
};

/**
 * Nombre maximum de numéros de suivi rattachables à un enlèvement.
 * Limite imposée par la spec UPS (TrackingData : 30 entrées).
 */
export const MAX_TRACKING_NUMBERS = 30;

/** Convertit une date ISO (YYYY-MM-DD) au format UPS (YYYYMMDD). */
function toUpsDate(value) {
  if (!value) return '';
  return value.replace(/-/g, '').slice(0, 8);
}

/** Normalise une heure HH:mm en HHmm. */
function toUpsTime(value, fallback) {
  if (!value) return fallback;
  return value.replace(':', '').slice(0, 4);
}

/**
 * Planifie un enlèvement de colis par UPS.
 * POST /api/pickupcreation/v2409/pickup
 */
export async function createPickup({
  address,
  pickupDate,
  readyTime = '09:00',
  closeTime = '18:00',
  pieces,
  rateePickup = false,
  contactName,
  companyName,
  phone,
  pickupPoint = '',
  residential = false,
  trackingNumbers = [],
}) {
  if (!config.accountNumber) {
    throw Object.assign(
      new Error('UPS_ACCOUNT_NUMBER est requis pour planifier un enlèvement.'),
      { status: 400, code: 'MISSING_ACCOUNT_NUMBER' },
    );
  }

  // Rattache l'enlèvement aux colis concernés. Le champ est optionnel côté
  // UPS, mais sans lui rien ne relie l'enlèvement aux étiquettes créées.
  const tracked = [...new Set(trackingNumbers.filter(Boolean).map((n) => String(n).trim()))].slice(
    0,
    MAX_TRACKING_NUMBERS,
  );

  const body = {
    PickupCreationRequest: {
      RatePickupIndicator: rateePickup ? 'Y' : 'N',
      // Champ requis par la spec, absent jusqu'ici : 'N' = enlèvement à
      // l'adresse fournie, sans adresse alternative.
      AlternateAddressIndicator: 'N',
      Shipper: {
        Account: {
          AccountNumber: config.accountNumber,
          AccountCountryCode: address.country || config.shipper.country || 'FR',
        },
      },
      PickupDateInfo: {
        PickupDate: toUpsDate(pickupDate),
        ReadyTime: toUpsTime(readyTime, '0900'),
        CloseTime: toUpsTime(closeTime, '1800'),
      },
      PickupAddress: {
        CompanyName: companyName || config.shipper.name || '',
        ContactName: contactName || config.shipper.attentionName || '',
        AddressLine: address.addressLine1 || '',
        City: address.city || '',
        ...(address.state ? { StateProvince: address.state } : {}),
        PostalCode: address.postalCode || '',
        CountryCode: address.country || 'FR',
        ResidentialIndicator: residential ? 'Y' : 'N',
        ...(pickupPoint ? { PickupPoint: pickupPoint } : {}),
        Phone: { Number: phone || config.shipper.phone || '' },
      },
      PickupPiece: pieces.map((p) => ({
        ServiceCode: p.serviceCode || '001',
        Quantity: String(p.quantity || 1),
        DestinationCountryCode: p.destinationCountry || address.country || 'FR',
        ContainerCode: p.containerCode || '01',
      })),
      ...(tracked.length
        ? { TrackingData: tracked.map((TrackingNumber) => ({ TrackingNumber })) }
        : {}),
    },
  };

  const data = await upsFetch(`/pickupcreation/${V}/pickup`, { method: 'POST', body });
  // Les numéros retenus sont renvoyés : l'appelant sait ce qui a été rattaché
  // après déduplication et troncature.
  return { ...normalizePickup(data), trackingNumbers: tracked };
}

/**
 * Annule un enlèvement planifié.
 * DELETE /api/shipments/v2409/pickup/{CancelBy}
 *
 * CancelBy = "prn" pour annuler par numéro de confirmation.
 */
export async function cancelPickup(pickupRequestNumber) {
  const data = await upsFetch(`/shipments/${V}/pickup/prn`, {
    method: 'DELETE',
    query: { PRN: pickupRequestNumber },
  });

  const status = data?.PickupCancelResponse?.Response?.ResponseStatus;
  return {
    success: status?.Code === '1',
    message: status?.Description || 'Statut inconnu',
    raw: data,
  };
}

function normalizePickup(data) {
  const result = data?.PickupCreationResponse || {};
  const charge = result.RateResult?.GrandTotalOfAllCharge;

  return {
    confirmationNumber: result.PRN || '',
    // UPS ne facture l'enlèvement que dans certains cas ; sinon aucun montant.
    charge: charge ? Number(charge) : null,
    currency: result.RateResult?.CurrencyCode || null,
    readyTime: result.ReadyTime || null,
    raw: data,
  };
}
