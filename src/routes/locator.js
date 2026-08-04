import { Router } from 'express';
import { findAccessPoints, REQ_OPTIONS } from '../services/locator.js';
import { asyncHandler, badRequest, requireFields } from '../middleware/validate.js';

export const locatorRouter = Router();

/** POST /api/locator/access-points — recherche de points relais */
locatorRouter.post(
  '/access-points',
  asyncHandler(async (req, res) => {
    const {
      address,
      radius = 25,
      unit = 'KM',
      maxResults = 10,
      locale = 'fr_FR',
      reqOption = REQ_OPTIONS.ACCESS_POINT,
    } = req.body;

    if (!address) throw badRequest('Le champ "address" est obligatoire.');
    requireFields(address, ['country'], 'champ address');

    if (!address.postalCode && !address.city) {
      throw badRequest('Renseignez au minimum un code postal ou une ville.');
    }

    if (!['KM', 'MI'].includes(unit)) {
      throw badRequest('unit doit valoir "KM" ou "MI".');
    }

    const radiusNum = Number(radius);
    if (!Number.isFinite(radiusNum) || radiusNum <= 0 || radiusNum > 500) {
      throw badRequest('radius doit être un nombre compris entre 1 et 500.');
    }

    const result = await findAccessPoints({
      address,
      radius: radiusNum,
      unit,
      maxResults: Number(maxResults) || 10,
      locale,
      reqOption: String(reqOption),
    });

    res.json({ success: true, data: result });
  }),
);
