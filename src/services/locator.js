import { API_VERSIONS } from '../config.js';
import { upsFetch } from './upsClient.js';

const V = API_VERSIONS.locator;

/**
 * reqOption pilote le type de recherche.
 * 64 = UPS Access Point (points relais) — c'est ce qui nous intéresse ici.
 */
export const REQ_OPTIONS = {
  LOCATIONS: '1',
  RETAIL: '32',
  ACCESS_POINT: '64',
};

/**
 * Recherche des points relais (UPS Access Point) autour d'une adresse.
 * POST /api/locations/v3/search/availabilities/{reqOption}
 *
 * @param {object} params
 * @param {object} params.address adresse de recherche
 * @param {number} [params.radius] rayon de recherche
 * @param {'KM'|'MI'} [params.unit] unité du rayon
 * @param {number} [params.maxResults] nombre max de résultats
 */
export async function findAccessPoints({
  address,
  radius = 25,
  unit = 'KM',
  maxResults = 10,
  locale = 'fr_FR',
  reqOption = REQ_OPTIONS.ACCESS_POINT,
}) {
  const addressLines = [address.addressLine1, address.addressLine2].filter(Boolean);

  const body = {
    LocatorRequest: {
      Request: {
        RequestAction: 'Locator',
        TransactionReference: { CustomerContext: 'ups-backend locator' },
      },
      OriginAddress: {
        AddressKeyFormat: {
          ...(addressLines.length ? { AddressLine: addressLines.join(' ') } : {}),
          PoliticalDivision2: address.city || '',
          ...(address.state ? { PoliticalDivision1: address.state } : {}),
          PostcodePrimaryLow: address.postalCode || '',
          CountryCode: address.country || 'FR',
        },
        MaximumListSize: String(maxResults),
      },
      Translate: {
        LanguageCode: locale.startsWith('fr') ? 'FRA' : 'ENG',
        Locale: locale,
      },
      UnitOfMeasurement: { Code: unit },
      LocationSearchCriteria: {
        MaximumListSize: String(maxResults),
        SearchRadius: String(radius),
        // 01/018 = filtre "UPS Access Point" côté critères de recherche.
        SearchOption: [
          {
            OptionType: { Code: '01' },
            OptionCode: [{ Code: '018' }],
            Relation: { Code: '01' },
          },
        ],
      },
      SortCriteria: { SortType: '01' }, // tri par distance
    },
  };

  const data = await upsFetch(`/locations/${V}/search/availabilities/${reqOption}`, {
    method: 'POST',
    body,
  });

  return normalizeLocations(data);
}

const DAY_LABELS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

function formatHours(opHours) {
  const days = opHours?.StandardHours?.DayOfWeek;
  if (!days) return [];
  const list = Array.isArray(days) ? days : [days];

  return list.map((d) => {
    const idx = Number(d.Day) - 1;
    const open = d.OpenHours;
    const close = d.CloseHours;
    const hhmm = (t) => (t && t.length === 4 ? `${t.slice(0, 2)}:${t.slice(2)}` : t);

    return {
      day: DAY_LABELS[idx] || `Jour ${d.Day}`,
      closed: !open || !close,
      hours: open && close ? `${hhmm(open)} - ${hhmm(close)}` : 'Fermé',
    };
  });
}

function normalizeLocations(data) {
  const found = data?.LocatorResponse?.SearchResults?.DropLocation;
  if (!found) return { locations: [], raw: data };

  const list = Array.isArray(found) ? found : [found];

  const locations = list.map((loc) => {
    const addr = loc.AddressKeyFormat || {};
    const lines = addr.AddressLine
      ? Array.isArray(addr.AddressLine)
        ? addr.AddressLine
        : [addr.AddressLine]
      : [];

    return {
      locationId: loc.LocationID || '',
      name: loc.LocationName || addr.ConsigneeName || '',
      addressLines: lines,
      city: addr.PoliticalDivision2 || '',
      state: addr.PoliticalDivision1 || '',
      postalCode: addr.PostcodePrimaryLow || '',
      country: addr.CountryCode || '',
      phone: loc.PhoneNumber || null,
      distance: loc.Distance
        ? {
            value: Number(loc.Distance.Value),
            unit: loc.Distance.UnitOfMeasurement?.Code || '',
          }
        : null,
      latitude: loc.Geocode?.Latitude ? Number(loc.Geocode.Latitude) : null,
      longitude: loc.Geocode?.Longitude ? Number(loc.Geocode.Longitude) : null,
      isAccessPoint: Boolean(loc.AccessPointInformation),
      accessPointStatus: loc.AccessPointInformation?.AccessPointStatus?.Description || null,
      openingHours: formatHours(loc.OperatingHours),
    };
  });

  return { locations, raw: data };
}
