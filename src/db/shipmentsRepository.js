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
