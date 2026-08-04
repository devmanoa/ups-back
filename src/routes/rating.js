import { Router } from 'express';
import { getRates, SERVICE_CODES } from '../services/rating.js';
import { asyncHandler, badRequest, requireFields, validatePackages } from '../middleware/validate.js';

export const ratingRouter = Router();

const VALID_OPTIONS = ['Rate', 'Shop', 'Ratetimeintransit', 'Shoptimeintransit'];

/** GET /api/rating/services — liste des codes service pour alimenter le front */
ratingRouter.get('/services', (req, res) => {
  res.json({
    success: true,
    data: Object.entries(SERVICE_CODES).map(([code, name]) => ({ code, name })),
  });
});

/** POST /api/rating — calcule les tarifs */
ratingRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { shipTo, shipFrom, packages, requestOption = 'Shop', serviceCode, negotiatedRates } = req.body;

    if (!shipTo) throw badRequest('Le champ "shipTo" est obligatoire.');
    requireFields(shipTo, ['postalCode', 'country'], 'champ shipTo');
    validatePackages(packages);

    if (!VALID_OPTIONS.includes(requestOption)) {
      throw badRequest(`requestOption invalide. Valeurs acceptées: ${VALID_OPTIONS.join(', ')}`);
    }

    const result = await getRates({
      shipFrom,
      shipTo,
      packages,
      requestOption,
      serviceCode,
      negotiatedRates: negotiatedRates !== false,
    });

    res.json({ success: true, data: result });
  }),
);
