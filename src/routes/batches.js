import { Router } from 'express';
import { listBatches, getBatch } from '../db/batchesRepository.js';
import { withAnomalies } from '../services/anomalies.js';
import { isDbEnabled } from '../db/pool.js';
import { asyncHandler } from '../middleware/validate.js';

export const batchesRouter = Router();

/**
 * Lots d'envoi groupé, présentés comme « commandes » dans l'interface.
 * Agrégations de la table shipments via `batch_id` : aucune table dédiée.
 */

batchesRouter.use((req, res, next) => {
  if (!isDbEnabled()) {
    return next(
      Object.assign(
        new Error('Les envois groupés nécessitent une base PostgreSQL. Renseignez DATABASE_URL.'),
        { status: 503, code: 'DB_NOT_CONFIGURED' },
      ),
    );
  }
  next();
});

/** GET /api/batches — liste des lots */
batchesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { search, from, to } = req.query;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const result = await listBatches({ search, from, to, limit, offset });
    res.json({ success: true, data: { ...result, limit, offset } });
  }),
);

/** GET /api/batches/:batchId — récapitulatif et envois du lot */
batchesRouter.get(
  '/:batchId',
  asyncHandler(async (req, res) => {
    const batch = await getBatch(req.params.batchId);

    if (!batch) {
      throw Object.assign(new Error('Lot introuvable.'), { status: 404, code: 'NOT_FOUND' });
    }

    // Mêmes anomalies que sur la page « Envois » : calculées à la lecture.
    const now = new Date();
    res.json({
      success: true,
      data: { ...batch, shipments: batch.shipments.map((s) => withAnomalies(s, now)) },
    });
  }),
);
