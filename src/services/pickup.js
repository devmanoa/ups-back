import { API_VERSIONS, config } from '../config.js';
import { upsFetch } from './upsClient.js';

const V = API_VERSIONS.pickup;

/** Codes conteneur acceptés par l'API Pickup. */
export const CONTAINER_CODES = {
  '01': 'Colis',
  '02': 'Palette',
  '03': 'Enveloppe',
};

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
}) {
  if (!config.accountNumber) {
    throw Object.assign(
      new Error('UPS_ACCOUNT_NUMBER est requis pour planifier un enlèvement.'),
      { status: 400, code: 'MISSING_ACCOUNT_NUMBER' },
    );
  }

  const body = {
    PickupCreationRequest: {
      RatePickupIndicator: rateePickup ? 'Y' : 'N',
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
    },
  };

  const data = await upsFetch(`/pickupcreation/${V}/pickup`, { method: 'POST', body });
  return normalizePickup(data);
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
