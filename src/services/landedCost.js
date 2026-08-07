import { API_VERSIONS, config } from '../config.js';
import { upsFetch } from './upsClient.js';

const V = API_VERSIONS.landedCost;

/**
 * Estime les coûts à l'import : droits de douane, taxes et frais annexes.
 * POST /api/landedcost/v1/quotes
 *
 * Cette API exige le numéro de compte UPS en en-tête.
 */
export async function getLandedCost({
  importCountryCode,
  exportCountryCode,
  items,
  currency = 'EUR',
  importProvince = '',
  shipDate = '',
  incoterms = '',
  allowPartialResult = true,
}) {
  if (!config.accountNumber) {
    throw Object.assign(
      new Error(
        'UPS_ACCOUNT_NUMBER est requis pour estimer les coûts à l’import. Renseignez-le dans le .env',
      ),
      { status: 400, code: 'MISSING_ACCOUNT_NUMBER' },
    );
  }

  const body = {
    currencyCode: currency,
    allowPartialLandedCostResult: allowPartialResult,
    shipment: {
      id: `quote-${Date.now()}`,
      importCountryCode,
      importProvince,
      shipDate,
      exportCountryCode,
      incoterms,
      shipmentItems: items.map((item, index) => ({
        commodityId: String(item.commodityId || index + 1),
        grossWeight: item.weight ? String(item.weight) : '',
        grossWeightUnit: item.weight ? item.weightUnit || 'KG' : '',
        priceEach: String(item.priceEach),
        hsCode: item.hsCode || '',
        quantity: Number(item.quantity) || 1,
        UOM: item.uom || 'Each',
        originCountryCode: item.originCountryCode || exportCountryCode,
        commodityCurrencyCode: item.currency || currency,
        description: item.description || '',
      })),
    },
  };

  const data = await upsFetch(`/landedcost/${V}/quotes`, {
    method: 'POST',
    body,
    headers: { AccountNumber: config.accountNumber },
  });

  return normalizeLandedCost(data, currency);
}

function normalizeLandedCost(data, fallbackCurrency) {
  const result = data?.landedCostResponse || data;
  const shipment = result?.shipment || {};

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const items = (shipment.shipmentItems || []).map((item) => ({
    commodityId: item.commodityId || '',
    description: item.description || '',
    quantity: num(item.quantity),
    duties: num(item.dutyAmount ?? item.duties),
    taxes: num(item.taxAmount ?? item.taxes),
    totalCharges: num(item.totalCharges),
  }));

  return {
    currency: result?.currencyCode || fallbackCurrency,
    totalDuties: num(shipment.totalDutyAmount ?? shipment.duties),
    totalTaxes: num(shipment.totalTaxAmount ?? shipment.taxes),
    totalFees: num(shipment.totalFeeAmount ?? shipment.fees),
    grandTotal: num(shipment.totalLandedCost ?? shipment.grandTotal),
    items,
    raw: data,
  };
}
