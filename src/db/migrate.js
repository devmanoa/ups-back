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

-- Colonnes ajoutées après la première version : ALTER plutôt que recréation
-- pour préserver les bases déjà déployées.
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS expected_delivery DATE;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS transit_days      INTEGER;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS last_event_at     TIMESTAMPTZ;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS picked_up_at      TIMESTAMPTZ;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS delivered_at      TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS shipments_expected_idx ON shipments (expected_delivery)
  WHERE expected_delivery IS NOT NULL;

-- Carnet d'adresses partagé : réutilisable comme destinataire sur toutes les
-- pages de saisie. Les groupes (« antennes », « partenaires »…) sont plats :
-- une hiérarchie n'a pas d'usage identifié ici.
CREATE TABLE IF NOT EXISTS address_groups (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS address_groups_name_uniq
  ON address_groups (LOWER(name));

CREATE TABLE IF NOT EXISTS addresses (
  id             BIGSERIAL PRIMARY KEY,
  -- Supprimer un groupe ne doit jamais supprimer ses adresses : elles
  -- retombent dans « Sans groupe ».
  group_id       BIGINT REFERENCES address_groups(id) ON DELETE SET NULL,
  label          TEXT NOT NULL,
  name           TEXT NOT NULL,
  attention_name TEXT,
  phone          TEXT,
  address_line1  TEXT NOT NULL,
  address_line2  TEXT,
  city           TEXT NOT NULL,
  state          TEXT,
  postal_code    TEXT NOT NULL,
  country        TEXT NOT NULL DEFAULT 'FR',
  residential    BOOLEAN NOT NULL DEFAULT FALSE,
  is_default     BOOLEAN NOT NULL DEFAULT FALSE,
  usage_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at   TIMESTAMPTZ,
  archived_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Deux adresses actives de même nom rendraient le sélecteur ambigu.
-- L'archivage libère le nom.
CREATE UNIQUE INDEX IF NOT EXISTS addresses_label_uniq
  ON addresses (LOWER(label)) WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS addresses_group_idx ON addresses (group_id)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS addresses_usage_idx
  ON addresses (usage_count DESC, last_used_at DESC);

-- Journal d'activité : qui a fait quoi dans l'application. Distinct de
-- l'historique UPS (parcours du colis), qui vit dans la table shipments.
CREATE TABLE IF NOT EXISTS activity_log (
  id           BIGSERIAL PRIMARY KEY,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- L'auteur est recopié, sans clé étrangère : Keycloak est la source
  -- d'identité, et un utilisateur supprimé ne doit pas effacer l'histoire.
  actor_id     TEXT,
  actor_name   TEXT,
  actor_email  TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  -- Résumé figé à l'écriture : renommer une adresse plus tard ne doit pas
  -- réécrire le passé. C'est un journal, pas une vue.
  summary      TEXT NOT NULL,
  metadata     JSONB
);

CREATE INDEX IF NOT EXISTS activity_occurred_idx ON activity_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS activity_actor_idx    ON activity_log (actor_id);
CREATE INDEX IF NOT EXISTS activity_action_idx   ON activity_log (action);
CREATE INDEX IF NOT EXISTS activity_entity_idx   ON activity_log (entity_type, entity_id);

-- Catalogue de types de colis : le matériel expédié régulièrement (DS620,
-- QW410, bornes...) avec son poids et ses dimensions, pour éviter de les
-- ressaisir à chaque envoi.
CREATE TABLE IF NOT EXISTS package_types (
  id             BIGSERIAL PRIMARY KEY,
  label          TEXT NOT NULL,
  -- Seul le poids est obligatoire, comme dans le formulaire : UPS n'exige
  -- les dimensions que si les trois sont fournies.
  weight         NUMERIC(10,3) NOT NULL,
  length         NUMERIC(10,2),
  width          NUMERIC(10,2),
  height         NUMERIC(10,2),
  description    TEXT,
  packaging_type TEXT NOT NULL DEFAULT '02',
  reference      TEXT,
  is_default     BOOLEAN NOT NULL DEFAULT FALSE,
  usage_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at   TIMESTAMPTZ,
  archived_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Deux types actifs de meme nom rendraient le selecteur ambigu.
CREATE UNIQUE INDEX IF NOT EXISTS package_types_label_uniq
  ON package_types (LOWER(label)) WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS package_types_usage_idx
  ON package_types (usage_count DESC, last_used_at DESC);
`;

export async function migrate() {
  if (!isDbEnabled()) {
    console.warn('  ⚠  DATABASE_URL absent — historique des envois désactivé');
    return false;
  }

  try {
    await query(SCHEMA);
    console.log('  → Base PostgreSQL prête (shipments, addresses, activity_log, package_types)');
    return true;
  } catch (err) {
    // Une base injoignable ne doit pas empêcher les autres pages de fonctionner.
    console.error(`  ⚠  Base PostgreSQL injoignable : ${err.message}`);
    return false;
  }
}
