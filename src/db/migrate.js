import { query, isDbEnabled } from './pool.js';

/**
 * Crée le schéma si nécessaire. Idempotent : exécuté à chaque démarrage.
 *
 * UPS ne propose aucune API pour lister les expéditions déjà créées :
 * on conserve donc localement ce que l'API renvoie à la création.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS shipments (
  id                  BIGSERIAL PRIMARY KEY,
  shipment_id         TEXT NOT NULL,
  tracking_number     TEXT,
  service_code        TEXT,
  service_name        TEXT,
  recipient_name      TEXT,
  recipient_company   TEXT,
  recipient_address   TEXT,
  recipient_city      TEXT,
  recipient_postal    TEXT,
  recipient_country   TEXT,
  reference           TEXT,
  description         TEXT,
  total_charges       NUMERIC(12,2),
  currency            TEXT,
  billing_weight      TEXT,
  label_format        TEXT,
  label_base64        TEXT,
  access_point_id     TEXT,
  status              TEXT NOT NULL DEFAULT 'created',
  status_description  TEXT,
  status_checked_at   TIMESTAMPTZ,
  voided_at           TIMESTAMPTZ,
  batch_id            TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Un même numéro de suivi ne doit jamais être enregistré deux fois.
CREATE UNIQUE INDEX IF NOT EXISTS shipments_tracking_uniq
  ON shipments (tracking_number) WHERE tracking_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS shipments_created_idx ON shipments (created_at DESC);
CREATE INDEX IF NOT EXISTS shipments_status_idx  ON shipments (status);
CREATE INDEX IF NOT EXISTS shipments_batch_idx   ON shipments (batch_id);
`;

export async function migrate() {
  if (!isDbEnabled()) {
    console.warn('  ⚠  DATABASE_URL absent — historique des envois désactivé');
    return false;
  }

  try {
    await query(SCHEMA);
    console.log('  → Base PostgreSQL prête (table shipments)');
    return true;
  } catch (err) {
    // Une base injoignable ne doit pas empêcher les autres pages de fonctionner.
    console.error(`  ⚠  Base PostgreSQL injoignable : ${err.message}`);
    return false;
  }
}
