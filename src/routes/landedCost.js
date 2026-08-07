import { Router } from 'express';
import { getLandedCost } from '../services/landedCost.js';
import { asyncHandler, badRequest } from '../middleware/validate.js';

export const landedCostRouter = Router();

/** POST /api/landed-cost */
landedCostRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const {
      importCountryCode,
      exportCountryCode,
      items,
      currency = 'EUR',
      importProvince,
      shipDate,
      incoterms,
    } = req.body;

    if (!importCountryCode || !exportCountryCode) {
      throw badRequest('importCountryCode et exportCountryCode sont obligatoires.');
    }

    if (!Array.isArray(items) || items.length === 0) {
      throw badRequest('Le champ "items" doit contenir au moins un article.');
    }

    items.forEach((item, i) => {
      const price = Number(item?.priceEach);
      if (!Number.isFinite(price) || price <= 0) {
        throw badRequest(`items[${i}].priceEach doit être un nombre supérieur à 0.`);
      }
      const qty = Number(item?.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw badRequest(`items[${i}].quantity doit être un nombre supérieur à 0.`);
      }
    });

    const result = await getLandedCost({
      importCountryCode,
      exportCountryCode,
      items,
      currency,
      importProvince,
      shipDate,
      incoterms,
    });

    res.json({ success: true, data: result });
  }),
);
