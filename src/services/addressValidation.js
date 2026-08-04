import { API_VERSIONS } from '../config.js';
import { upsFetch } from './upsClient.js';

const V = API_VERSIONS.addressValidation;

/**
 * requestoption : 1 = validation, 2 = classification, 3 = les deux.
 * Note UPS : cette API ne couvre que les États-Unis et Porto Rico.
 */
export const REQUEST_OPTIONS = { VALIDATION: 1, CLASSIFICATION: 2, BOTH: 3 };

/**
 * Valide et normalise une adresse.
 * POST /api/addressvalidation/v2/{requestoption}
 */
export async function validateAddress(address, { requestOption = REQUEST_OPTIONS.BOTH, maxSuggestions = 5 } = {}) {
  const addressLines = [address.addressLine1, address.addressLine2, address.addressLine3].filter(Boolean);

  const body = {
    XAVRequest: {
      AddressKeyFormat: {
        AddressLine: addressLines,
        PoliticalDivision2: address.city || '',
        PoliticalDivision1: address.state || '',
        PostcodePrimaryLow: address.postalCode || '',
        CountryCode: address.country || 'US',
      },
      ...(address.name ? { ConsigneeName: address.name } : {}),
      RequestOption: String(requestOption),
      MaximumListSize: String(maxSuggestions),
    },
  };

  const data = await upsFetch(`/addressvalidation/${V}/${requestOption}`, {
    method: 'POST',
    body,
  });

  return normalizeXav(data);
}

const CLASSIFICATION_LABELS = {
  0: 'Inconnu',
  1: 'Commercial',
  2: 'Résidentiel',
};

function normalizeXav(data) {
  const res = data?.XAVResponse || {};

  // UPS renvoie soit un objet unique, soit un tableau selon le nombre de candidats.
  const candidatesRaw = res.Candidate
    ? Array.isArray(res.Candidate)
      ? res.Candidate
      : [res.Candidate]
    : [];

  const candidates = candidatesRaw.map((c) => {
    const akf = c.AddressKeyFormat || {};
    const lines = akf.AddressLine
      ? Array.isArray(akf.AddressLine)
        ? akf.AddressLine
        : [akf.AddressLine]
      : [];
    return {
      addressLines: lines,
      city: akf.PoliticalDivision2 || '',
      state: akf.PoliticalDivision1 || '',
      postalCode: [akf.PostcodePrimaryLow, akf.PostcodeExtendedLow].filter(Boolean).join('-'),
      country: akf.CountryCode || '',
    };
  });

  const classificationCode = res.AddressClassification?.Code;

  return {
    // UPS positionne exactement un de ces indicateurs (chaîne vide = présent).
    valid: res.ValidAddressIndicator !== undefined,
    ambiguous: res.AmbiguousAddressIndicator !== undefined,
    noCandidates: res.NoCandidatesIndicator !== undefined,
    classification: classificationCode
      ? {
          code: classificationCode,
          description:
            res.AddressClassification?.Description || CLASSIFICATION_LABELS[classificationCode] || 'Inconnu',
        }
      : null,
    candidates,
    raw: data,
  };
}
