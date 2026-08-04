import { Router } from 'express';
import { trackByNumber, trackByReference } from '../services/tracking.js';
import { asyncHandler, badRequest } from '../middleware/validate.js';

export const trackingRouter = Router();

/**
 * GET /api/tracking/reference/:referenceNumber
 * Déclarée avant /:trackingNumber, sinon Express ferait correspondre
 * "reference" au paramètre générique.
 */
trackingRouter.get(
  '/reference/:referenceNumber',
  asyncHandler(async (req, res) => {
    const result = await trackByReference(req.params.referenceNumber, {
      locale: req.query.locale || 'fr_FR',
      fromPickUpDate: req.query.from,
      toPickUpDate: req.query.to,
    });

    res.json({ success: true, data: result });
  }),
);

/** GET /api/tracking/:trackingNumber */
trackingRouter.get(
  '/:trackingNumber',
  asyncHandler(async (req, res) => {
    const { trackingNumber } = req.params;

    if (!/^[A-Za-z0-9]{6,35}$/.test(trackingNumber)) {
      throw badRequest('Numéro de suivi invalide (6 à 35 caractères alphanumériques attendus).');
    }

    const result = await trackByNumber(trackingNumber, {
      locale: req.query.locale || 'fr_FR',
      returnSignature: req.query.signature === 'true',
    });

    res.json({ success: true, data: result });
  }),
);
