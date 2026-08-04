import { Router } from 'express';
import { createShipment, voidShipment, LABEL_FORMATS } from '../services/shipping.js';
import { asyncHandler, badRequest, requireFields, validatePackages } from '../middleware/validate.js';

export const shippingRouter = Router();

/** POST /api/shipping — crée une expédition et son étiquette */
shippingRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const {
      shipTo,
      shipFrom,
      packages,
      serviceCode,
      description,
      labelFormat = 'GIF',
      paymentAccountNumber,
      accessPointLocationId,
    } = req.body;

    if (!shipTo) throw badRequest('Le champ "shipTo" est obligatoire.');
    requireFields(shipTo, ['name', 'addressLine1', 'city', 'postalCode', 'country'], 'champ shipTo');
    validatePackages(packages);

    if (!LABEL_FORMATS[labelFormat]) {
      throw badRequest(
        `labelFormat invalide. Valeurs acceptées: ${Object.keys(LABEL_FORMATS).join(', ')}`,
      );
    }

    const result = await createShipment({
      shipTo,
      shipFrom,
      packages,
      serviceCode,
      description,
      labelFormat,
      paymentAccountNumber,
      accessPointLocationId,
    });

    res.status(201).json({ success: true, data: result });
  }),
);

/** DELETE /api/shipping/:shipmentId — annule une expédition */
shippingRouter.delete(
  '/:shipmentId',
  asyncHandler(async (req, res) => {
    const trackingNumbers = req.query.trackingNumbers
      ? String(req.query.trackingNumbers).split(',').map((t) => t.trim()).filter(Boolean)
      : [];

    const result = await voidShipment(req.params.shipmentId, trackingNumbers);
    res.json({ success: result.success, data: result });
  }),
);
