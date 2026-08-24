import { Router } from 'express';
import { createPickup, cancelPickup, CONTAINER_CODES, MAX_TRACKING_NUMBERS } from '../services/pickup.js';
import { asyncHandler, badRequest, requireFields } from '../middleware/validate.js';
import { log, ACTIONS } from '../services/activity.js';

export const pickupRouter = Router();

/** GET /api/pickup/containers — codes conteneur pour alimenter le front */
pickupRouter.get('/containers', (req, res) => {
  res.json({
    success: true,
    data: Object.entries(CONTAINER_CODES).map(([code, name]) => ({ code, name })),
  });
});

/** POST /api/pickup — planifie un enlèvement */
pickupRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const {
      address,
      pickupDate,
      readyTime,
      closeTime,
      pieces,
      contactName,
      companyName,
      phone,
      pickupPoint,
      residential,
      trackingNumbers,
    } = req.body;

    if (!address) throw badRequest('Le champ "address" est obligatoire.');
    requireFields(address, ['addressLine1', 'city', 'postalCode', 'country'], 'champ address');

    if (!pickupDate) throw badRequest('La date d’enlèvement est obligatoire.');
    if (!/^\d{4}-\d{2}-\d{2}/.test(pickupDate)) {
      throw badRequest('pickupDate doit être au format AAAA-MM-JJ.');
    }

    if (!Array.isArray(pieces) || pieces.length === 0) {
      throw badRequest('Le champ "pieces" doit contenir au moins une ligne.');
    }

    pieces.forEach((p, i) => {
      const qty = Number(p?.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw badRequest(`pieces[${i}].quantity doit être un nombre supérieur à 0.`);
      }
    });

    // Numéros de suivi rattachés : facultatifs, mais un format erroné serait
    // refusé par UPS avec un message peu parlant.
    if (trackingNumbers !== undefined) {
      if (!Array.isArray(trackingNumbers)) {
        throw badRequest('Le champ "trackingNumbers" doit être un tableau.');
      }
      if (trackingNumbers.length > MAX_TRACKING_NUMBERS) {
        throw badRequest(
          `${MAX_TRACKING_NUMBERS} numéros de suivi maximum par enlèvement (${trackingNumbers.length} fournis).`,
          ['trackingNumbers'],
        );
      }
      trackingNumbers.forEach((n, i) => {
        const value = String(n ?? '').trim();
        if (!value) throw badRequest(`trackingNumbers[${i}] est vide.`, ['trackingNumbers']);
        if (value.length > 18) {
          throw badRequest(
            `trackingNumbers[${i}] dépasse 18 caractères (« ${value} »).`,
            ['trackingNumbers'],
          );
        }
      });
    }

    const result = await createPickup({
      address,
      pickupDate,
      readyTime,
      closeTime,
      pieces,
      contactName,
      companyName,
      phone,
      pickupPoint,
      residential: Boolean(residential),
      trackingNumbers,
    });

    await log(req, {
      action: ACTIONS.PICKUP_CREATE,
      entityType: 'pickup',
      entityId: result.confirmationNumber,
      summary:
        `Enlèvement planifié le ${pickupDate} à ${address?.city || 'adresse inconnue'}` +
        (result.trackingNumbers?.length
          ? ` — ${result.trackingNumbers.length} colis rattaché${result.trackingNumbers.length > 1 ? 's' : ''}`
          : ''),
      metadata: {
        confirmationNumber: result.confirmationNumber,
        pickupDate,
        readyTime,
        closeTime,
        trackingNumbers: result.trackingNumbers ?? [],
      },
    });

    res.status(201).json({ success: true, data: result });
  }),
);

/** DELETE /api/pickup/:prn — annule un enlèvement */
pickupRouter.delete(
  '/:prn',
  asyncHandler(async (req, res) => {
    const result = await cancelPickup(req.params.prn);

    if (result.success) {
      await log(req, {
        action: ACTIONS.PICKUP_CANCEL,
        entityType: 'pickup',
        entityId: req.params.prn,
        summary: `Enlèvement ${req.params.prn} annulé`,
      });
    }

    res.json({ success: result.success, data: result });
  }),
);
