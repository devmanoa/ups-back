import { query } from './pool.js';
import { listShipments } from './shipmentsRepository.js';

/**
 * Lots d'envoi groupé, appelés « commandes » côté interface.
 *
 * Aucune table dédiée : `batch_id` est déjà écrit sur chaque envoi créé par
 * /api/shipping/bulk et indexé. Un lot est donc une agrégation, pas une
 * entité stockée — ce qui évite un état à maintenir en cohérence.
 */

/** Liste les lots, du plus récent au plus ancien, avec leur avancement. */
export async function listBatches({ search, from, to, limit = 50, offset = 0 } = {}) {
  const conditions = ['batch_id IS NOT NULL'];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    conditions.push(`(batch_id ILIKE ${p} OR recipient_name ILIKE ${p} OR tracking_number ILIKE ${p})`);
  }
  if (from) {
    params.push(from);
    conditions.push(`created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const { rows: countRows } = await query(
    `SELECT COUNT(DISTINCT batch_id)::int AS total FROM shipments ${where}`,
    params,
  );

  params.push(limit, offset);
  const { rows } = await query(
    `SELECT
        batch_id,
        MIN(created_at)                                   AS created_at,
        COUNT(*)::int                                     AS shipment_count,
        COUNT(*) FILTER (WHERE status = 'delivered')::int  AS delivered_count,
        COUNT(*) FILTER (WHERE status = 'exception')::int  AS exception_count,
        COUNT(*) FILTER (WHERE status = 'voided')::int     AS voided_count,
        COUNT(*) FILTER (WHERE status = 'in_transit')::int AS in_transit_count,
        COUNT(*) FILTER (WHERE status = 'created')::int    AS created_count,
        SUM(total_charges)                                AS total_charges,
        MAX(currency)                                     AS currency
       FROM shipments ${where}
      GROUP BY batch_id
      ORDER BY MIN(created_at) DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return { total: countRows[0].total, batches: rows.map(toBatch) };
}

/** Détail d'un lot : son récapitulatif et les envois qui le composent. */
export async function getBatch(batchId) {
  const { rows } = await query(
    `SELECT
        batch_id,
        MIN(created_at)                                   AS created_at,
        COUNT(*)::int                                     AS shipment_count,
        COUNT(*) FILTER (WHERE status = 'delivered')::int  AS delivered_count,
        COUNT(*) FILTER (WHERE status = 'exception')::int  AS exception_count,
        COUNT(*) FILTER (WHERE status = 'voided')::int     AS voided_count,
        COUNT(*) FILTER (WHERE status = 'in_transit')::int AS in_transit_count,
        COUNT(*) FILTER (WHERE status = 'created')::int    AS created_count,
        SUM(total_charges)                                AS total_charges,
        MAX(currency)                                     AS currency
       FROM shipments
      WHERE batch_id = $1
      GROUP BY batch_id`,
    [batchId],
  );

  if (!rows[0]) return null;

  // Réutilise la lecture des envois : même projection que la page « Envois ».
  const { shipments } = await listShipments({ batchId, limit: 200 });

  return { ...toBatch(rows[0]), shipments };
}

function toBatch(row) {
  const total = row.shipment_count;
  const delivered = row.delivered_count;

  return {
    batchId: row.batch_id,
    createdAt: row.created_at,
    shipmentCount: total,
    counts: {
      created: row.created_count,
      inTransit: row.in_transit_count,
      delivered,
      exception: row.exception_count,
      voided: row.voided_count,
    },
    // Un lot est terminé quand plus aucun envoi ne bouge.
    completed: delivered + row.voided_count === total,
    totalCharges: row.total_charges != null ? Number(row.total_charges) : null,
    currency: row.currency,
  };
}
