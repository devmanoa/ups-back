import { Router } from 'express';
import { listActivity, listActors, countByAction } from '../db/activityRepository.js';
import { isDbEnabled } from '../db/pool.js';
import { asyncHandler, badRequest } from '../middleware/validate.js';

export const activityRouter = Router();

/**
 * Journal d'activité applicative : qui a fait quoi dans l'application.
 *
 * Distinct de l'historique UPS : /api/shipments retrace le parcours du colis
 * chez UPS, ces routes retracent les actions de l'équipe.
 */

activityRouter.use((req, res, next) => {
  if (!isDbEnabled()) {
    return next(
      Object.assign(
        new Error("Le journal d'activité nécessite une base PostgreSQL. Renseignez DATABASE_URL."),
        { status: 503, code: 'DB_NOT_CONFIGURED' },
      ),
    );
  }
  next();
});

/** GET /api/activity/actors — auteurs distincts, pour le filtre */
activityRouter.get(
  '/actors',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await listActors() });
  }),
);

/** GET /api/activity/summary — répartition par action sur une période */
activityRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const { from, to } = req.query;
    res.json({
      success: true,
      data: { byAction: await countByAction({ from, to }) },
    });
  }),
);

/** GET /api/activity — journal paginé, filtrable */
activityRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { actorId, action, entityType, entityId, from, to, search } = req.query;

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    if (from && Number.isNaN(Date.parse(from))) throw badRequest('Paramètre "from" invalide.');
    if (to && Number.isNaN(Date.parse(to))) throw badRequest('Paramètre "to" invalide.');

    const result = await listActivity({
      actorId,
      action,
      entityType,
      entityId,
      from,
      to,
      search,
      limit,
      offset,
    });

    res.json({ success: true, data: { ...result, limit, offset } });
  }),
);
