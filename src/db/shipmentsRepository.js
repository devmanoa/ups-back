import { query } from './pool.js';

/**
 * Accès aux expéditions enregistrées localement.
 * UPS ne permet pas de relire la liste des envois : cette table est la
 * seule source de vérité pour l'historique.
 */

/**
 * Enregistre les colis d'une expédition. Un envoi multi-colis produit
 * une ligne par numéro de suivi.
 */
export async function saveShipment({ shipment, shipTo, serviceCode, serviceName, description, labelFormat, accessPointLocationId, batchId, expectedDelivery, transitDays }) {
  const rows = [];

  for (const pkg of shipment.packages) {
    // Un doublon (rejeu) ne doit pas faire échouer l'appel : l'étiquette UPS
    // existe déjà et le client doit la recevoir.
    const existing = pkg.trackingNumber
      ? await query('SELECT * FROM shipments WHERE tracking_number = $1', [pkg.trackingNumber])
      : { rows: [] };

    if (existing.rows.length > 0) {
      rows.push(existing.rows[0]);
      continue;
    }

    const { rows: inserted } = await query(
      `INSERT INTO shipments (
         shipment_id, tracking_number, service_code, service_name,
         recipient_name, recipient_company, recipient_address, recipient_city,
         recipient_postal, recipient_country, reference, description,
         total_charges, currency, billing_weight, label_format, label_base64,
         access_point_id, batch_id, expected_delivery, transit_days
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [
        shipment.shipmentIdentificationNumber,
        pkg.trackingNumber || null,
        serviceCode || null,
        serviceName || null,
        shipTo.name || null,
        shipTo.attentionName || null,
        [shipTo.addressLine1, shipTo.addressLine2].filter(Boolean).join(' ') || null,
        shipTo.city || null,
        shipTo.postalCode || null,
        shipTo.country || null,
        shipTo.reference || null,
        description || null,
        shipment.totalCharges ?? null,
        shipment.currency || null,
        shipment.billingWeight || null,
        labelFormat || null,
        pkg.label?.base64 || null,
        accessPointLocationId || null,
        batchId || null,
        expectedDelivery || null,
        transitDays ?? null,
      ],
    );
    rows.push(inserted[0]);
  }

  return rows.map(toShipment);
}

/** Liste paginée avec recherche et filtres. */
export async function listShipments({ search, status, batchId, from, to, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const params = [];

  if (batchId) {
    params.push(batchId);
    conditions.push(`batch_id = $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    conditions.push(
      `(tracking_number ILIKE ${p} OR shipment_id ILIKE ${p} OR recipient_name ILIKE ${p} OR recipient_city ILIKE ${p} OR reference ILIKE ${p})`,
    );
  }

  if (status && status !== 'all') {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }

  if (from) {
    params.push(from);
    conditions.push(`created_at >= $${params.length}`);
  }

  if (to) {
    // Borne incluse : on ajoute un jour pour couvrir toute la journée.
    params.push(to);
    conditions.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS total FROM shipments ${where}`,
    params,
  );

  params.push(limit, offset);
  const { rows } = await query(
    `SELECT * FROM shipments ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return { total: countRows[0].total, shipments: rows.map(toShipment) };
}

export async function getShipmentByTracking(trackingNumber) {
  const { rows } = await query('SELECT * FROM shipments WHERE tracking_number = $1', [
    trackingNumber,
  ]);
  return rows[0] ? toShipment(rows[0]) : null;
}

/**
 * Tous les colis d'une même expédition, celui demandé compris.
 *
 * `saveShipment` écrit une ligne par colis sous un `shipment_id` commun :
 * une expédition de trois colis existe donc en trois lignes, dont la page de
 * détail ne montrerait qu'une seule sans cette lecture.
 */
export async function listPackagesOfShipment(shipmentId) {
  const { rows } = await query(
    'SELECT * FROM shipments WHERE shipment_id = $1 ORDER BY id ASC',
    [shipmentId],
  );
  return rows.map(toShipment);
}

/** Met à jour le statut après interrogation de l'API Tracking. */
export async function updateStatus(trackingNumber, { status, description, eventDate }) {
  const { rows } = await query(
    `UPDATE shipments
        SET status = $2,
            status_description = $3,
            status_checked_at = NOW(),
            -- Date du dernier événement connu : sert à repérer les colis immobiles.
            last_event_at = COALESCE($4::timestamptz, last_event_at),
            -- Jalons figés au premier passage : ils ne doivent pas reculer.
            picked_up_at = CASE
              WHEN picked_up_at IS NULL AND $2 IN ('in_transit','delivered','exception')
              THEN COALESCE($4::timestamptz, NOW()) ELSE picked_up_at END,
            delivered_at = CASE
              WHEN delivered_at IS NULL AND $2 = 'delivered'
              THEN COALESCE($4::timestamptz, NOW()) ELSE delivered_at END
      WHERE tracking_number = $1
      RETURNING *`,
    [trackingNumber, status, description || null, eventDate || null],
  );
  return rows[0] ? toShipment(rows[0]) : null;
}

/** Envois non terminés, pour l'analyse d'anomalies. */
export async function listOpenShipments(limit = 500) {
  const { rows } = await query(
    `SELECT * FROM shipments
      WHERE status NOT IN ('delivered','voided')
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map(toShipment);
}

/** Marque comme annulés tous les colis d'une expédition. */
export async function markVoided(shipmentId) {
  const { rows } = await query(
    `UPDATE shipments
        SET status = 'voided', status_description = 'Expédition annulée', voided_at = NOW()
      WHERE shipment_id = $1
      RETURNING *`,
    [shipmentId],
  );
  return rows.map(toShipment);
}

/** Compte les envois par statut, pour le tableau de bord. */
export async function countByStatus() {
  const { rows } = await query(
    `SELECT status, COUNT(*)::int AS count FROM shipments GROUP BY status`,
  );
  return rows.reduce((acc, r) => ({ ...acc, [r.status]: r.count }), {});
}

/**
 * Indicateurs chiffrés sur une période : coûts, volumes, répartitions.
 *
 * Attention au calcul du coût : `saveShipment` écrit une ligne par colis, et
 * chacune porte le total de l'expédition entière. Sommer `total_charges`
 * multiplierait le coût d'un envoi multi-colis par son nombre de colis. Les
 * montants sont donc agrégés par `shipment_id` avant d'être additionnés.
 */
export async function getStats({ from, to } = {}) {
  const conditions = ["status <> 'voided'"];
  const params = [];

  if (from) {
    params.push(from);
    conditions.push(`created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  // Même période, mais tous statuts confondus : sert au décompte par statut,
  // où les annulations doivent apparaître.
  const periodConditions = [];
  const periodParams = [];

  if (from) {
    periodParams.push(from);
    periodConditions.push(`created_at >= $${periodParams.length}`);
  }
  if (to) {
    periodParams.push(to);
    periodConditions.push(`created_at < ($${periodParams.length}::date + INTERVAL '1 day')`);
  }

  const periodWhere = periodConditions.length ? `WHERE ${periodConditions.join(' AND ')}` : '';

  // Une expédition = un shipment_id, quel que soit son nombre de colis.
  const perShipment = `
    SELECT shipment_id,
           MAX(total_charges) AS charges,
           MAX(currency)      AS currency,
           MIN(created_at)    AS created_at,
           COUNT(*)::int      AS package_count
      FROM shipments ${where}
     GROUP BY shipment_id`;

  const [totals, byService, byDay, statuses, delays] = await Promise.all([
    query(
      `SELECT COUNT(*)::int                       AS shipment_count,
              COALESCE(SUM(package_count), 0)::int AS package_count,
              COALESCE(SUM(charges), 0)           AS total_cost,
              AVG(charges)                        AS average_cost,
              MAX(currency)                       AS currency
         FROM (${perShipment}) s`,
      params,
    ),
    query(
      `SELECT COALESCE(service_name, 'Service inconnu') AS service,
              COUNT(DISTINCT shipment_id)::int         AS shipment_count,
              COALESCE(SUM(charges), 0)                AS total_cost
         FROM (
           SELECT shipment_id, service_name,
                  MAX(total_charges) AS charges
             FROM shipments ${where}
            GROUP BY shipment_id, service_name
         ) s
        GROUP BY service
        ORDER BY total_cost DESC`,
      params,
    ),
    query(
      `SELECT DATE(created_at)            AS day,
              COUNT(*)::int               AS shipment_count,
              COALESCE(SUM(charges), 0)   AS total_cost
         FROM (${perShipment}) s
        GROUP BY day
        ORDER BY day ASC`,
      params,
    ),
    // Les annulations sont exclues des coûts mais restent comptées ici :
    // savoir combien d'envois ont été annulés a son intérêt. Ce filtre
    // reprend donc la période sans exclure aucun statut.
    query(
      `SELECT status, COUNT(DISTINCT shipment_id)::int AS count
         FROM shipments
        ${periodWhere}
        GROUP BY status`,
      periodParams,
    ),
    // Délai réel de livraison, pour les envois arrivés à destination.
    query(
      `SELECT AVG(EXTRACT(EPOCH FROM (delivered_at - created_at)) / 86400) AS avg_days,
              COUNT(*)::int                                                AS delivered_count
         FROM (
           SELECT DISTINCT ON (shipment_id) shipment_id, created_at, delivered_at
             FROM shipments ${where} AND delivered_at IS NOT NULL
         ) s`,
      params,
    ),
  ]);

  const t = totals.rows[0];
  const d = delays.rows[0];

  return {
    shipmentCount: t.shipment_count,
    packageCount: t.package_count,
    totalCost: Number(t.total_cost) || 0,
    averageCost: t.average_cost != null ? Number(t.average_cost) : null,
    currency: t.currency || 'EUR',
    averageDeliveryDays: d.avg_days != null ? Number(d.avg_days) : null,
    deliveredCount: d.delivered_count,
    byStatus: statuses.rows.reduce((acc, r) => ({ ...acc, [r.status]: r.count }), {}),
    byService: byService.rows.map((r) => ({
      service: r.service,
      shipmentCount: r.shipment_count,
      totalCost: Number(r.total_cost) || 0,
    })),
    byDay: byDay.rows.map((r) => ({
      day: new Date(r.day).toISOString().slice(0, 10),
      shipmentCount: r.shipment_count,
      totalCost: Number(r.total_cost) || 0,
    })),
  };
}

/** Convertit une ligne SQL en objet exploitable par le front. */
function toShipment(row) {
  return {
    id: row.id,
    shipmentId: row.shipment_id,
    trackingNumber: row.tracking_number,
    serviceCode: row.service_code,
    serviceName: row.service_name,
    recipient: {
      name: row.recipient_name,
      company: row.recipient_company,
      address: row.recipient_address,
      city: row.recipient_city,
      postalCode: row.recipient_postal,
      country: row.recipient_country,
    },
    reference: row.reference,
    description: row.description,
    totalCharges: row.total_charges != null ? Number(row.total_charges) : null,
    currency: row.currency,
    billingWeight: row.billing_weight,
    labelFormat: row.label_format,
    // L'étiquette est volumineuse : on n'expose que sa disponibilité.
    hasLabel: Boolean(row.label_base64),
    accessPointId: row.access_point_id,
    status: row.status,
    statusDescription: row.status_description,
    statusCheckedAt: row.status_checked_at,
    voidedAt: row.voided_at,
    // Champs alimentant la détection d'anomalies.
    expectedDelivery: row.expected_delivery
      ? new Date(row.expected_delivery).toISOString().slice(0, 10)
      : null,
    transitDays: row.transit_days,
    lastEventAt: row.last_event_at,
    pickedUpAt: row.picked_up_at,
    deliveredAt: row.delivered_at,
    batchId: row.batch_id,
    createdAt: row.created_at,
  };
}

/** Récupère l'étiquette stockée, à la demande. */
export async function getLabel(trackingNumber) {
  const { rows } = await query(
    'SELECT label_base64, label_format, tracking_number FROM shipments WHERE tracking_number = $1',
    [trackingNumber],
  );
  if (!rows[0]?.label_base64) return null;
  return {
    base64: rows[0].label_base64,
    format: rows[0].label_format,
    trackingNumber: rows[0].tracking_number,
  };
}
