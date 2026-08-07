import { Router } from 'express';
import { getTransitTimes } from '../services/timeInTransit.js';
import { asyncHandler, badRequest, requireFields } from '../middleware/validate.js';

export const timeInTransitRouter = Router();

/** POST /api/transit-times */
timeInTransitRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const {
      shipFrom,
      shipTo,
      weight,
      weightUnit = 'KGS',
      shipDate,
      numberOfPackages = 1,
      shipmentValue,
      currency,
      residential,
    } = req.body;

    if (!shipTo) throw badRequest('Le champ "shipTo" est obligatoire.');
    requireFields(shipTo, ['country'], 'champ shipTo');

    if (!shipTo.postalCode && !shipTo.city) {
      throw badRequest('Renseignez au minimum un code postal ou une ville de destination.');
    }

    const weightNum = Number(weight);
    if (!Number.isFinite(weightNum) || weightNum <= 0) {
      throw badRequest('Le poids doit être un nombre supérieur à 0.');
    }

    if (!['KGS', 'LBS'].includes(weightUnit)) {
      throw badRequest('weightUnit doit valoir "KGS" ou "LBS".');
    }

    const result = await getTransitTimes({
      shipFrom,
      shipTo,
      weight: weightNum,
      weightUnit,
      shipDate,
      numberOfPackages: Number(numberOfPackages) || 1,
      shipmentValue,
      currency,
      residential: Boolean(residential),
    });

    res.json({ success: true, data: result });
  }),
);
