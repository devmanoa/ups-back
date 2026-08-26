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
  -- Identifiant UPS de l'expédition. Ne peut pas servir de clé de
  -- regroupement : en CIE, UPS renvoie la même valeur factice pour toutes
  -- les expéditions, ce qui fusionnerait des envois sans rapport.
  shipment_id         TEXT NOT NULL,
  -- Notre propre identifiant d'expédition, attribué à l'enregistrement.
  -- C'est lui qui regroupe les colis d'un même envoi, sans dépendre de ce
  -- qu'UPS renvoie.
  local_shipment_id   TEXT,
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
--
-- Les numéros factices en sont exclus : l'environnement CIE renvoie
-- 1ZXXXXXXXXXXXXXXXX pour tous les colis de toutes les expéditions. Sous une
-- contrainte d'unicité, seul le tout premier envoi de test s'enregistrerait
-- et les suivants seraient rejetés. La règle reste entière en production,
-- où chaque colis reçoit un numéro distinct.
DROP INDEX IF EXISTS shipments_tracking_uniq;
DROP INDEX IF EXISTS shipments_tracking_shipment_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS shipments_tracking_real_uniq
  ON shipments (tracking_number)
  WHERE tracking_number IS NOT NULL AND tracking_number !~* 'X{6,}';

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
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS local_shipment_id TEXT;

-- Antenne d'origine, quand l'étiquette a été créée depuis un lien Antennes.
-- Sans clé étrangère : les antennes vivent dans une autre application, et
-- leur suppression ne doit pas effacer notre historique d'envois.
-- Adresse d'expédition figée à la création. Elle vit dans les variables
-- SHIPPER_*, qui changeraient en cas de déménagement : sans copie, tous les
-- envois passés afficheraient rétroactivement la nouvelle adresse, alors
-- qu'ils sont bel et bien partis de l'ancienne.
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS shipper_name    TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS shipper_address TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS shipper_city    TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS shipper_postal  TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS shipper_country TEXT;

ALTER TABLE shipments ADD COLUMN IF NOT EXISTS antenne_contact_id INTEGER;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS antenne_id         INTEGER;

CREATE INDEX IF NOT EXISTS shipments_antenne_idx ON shipments (antenne_id)
  WHERE antenne_id IS NOT NULL;

-- Reprise des lignes antérieures à cette colonne. Les envois CIE partagent
-- un shipment_id factice : les regrouper par (shipment_id, created_at à la
-- seconde près) sépare des expéditions distinctes créées à des moments
-- différents, sans casser les vrais envois multi-colis, dont les lignes sont
-- écrites dans la même seconde.
UPDATE shipments s
   SET local_shipment_id = g.key
  FROM (
    SELECT shipment_id,
           date_trunc('second', created_at) AS second,
           shipment_id || '-' || EXTRACT(EPOCH FROM date_trunc('second', created_at))::bigint
             AS key
      FROM shipments
     GROUP BY shipment_id, date_trunc('second', created_at)
  ) g
 WHERE s.local_shipment_id IS NULL
   AND s.shipment_id = g.shipment_id
   AND date_trunc('second', s.created_at) = g.second;

CREATE INDEX IF NOT EXISTS shipments_local_idx ON shipments (local_shipment_id);

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

-- Adresse de départ retenue par défaut. Distincte de la colonne is_default,
-- qui vaut pour le destinataire : une même adresse peut être le point de
-- départ habituel sans être le destinataire habituel, et inversement.
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS is_default_shipper BOOLEAN NOT NULL DEFAULT FALSE;

-- Une seule adresse de départ par défaut : deux rendraient le choix arbitraire.
-- L'index porte sur une constante, filtré aux seules lignes marquées : c'est
-- la façon d'exiger « au plus une ligne vérifiant cette condition ».
CREATE UNIQUE INDEX IF NOT EXISTS addresses_default_shipper_uniq
  ON addresses ((TRUE)) WHERE is_default_shipper AND archived_at IS NULL;

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

-- Commentaires libres attachés à un envoi : ce que le journal d'activité ne
-- peut pas dire (« client prévenu », « colis récupéré sur place »).
CREATE TABLE IF NOT EXISTS shipment_comments (
  id              BIGSERIAL PRIMARY KEY,
  -- Rattaché au numéro de suivi et non à shipments.id : une expédition
  -- multi-colis occupe plusieurs lignes, et le numéro est ce que l'équipe
  -- manipule. Pas de clé étrangère, pour la même raison.
  tracking_number TEXT NOT NULL,
  -- Auteur recopié, comme dans activity_log : Keycloak est la source
  -- d'identité, et un utilisateur supprimé ne doit pas effacer le fil.
  actor_id        TEXT,
  actor_name      TEXT,
  actor_email     TEXT,
  body            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS shipment_comments_tracking_idx
  ON shipment_comments (tracking_number, created_at DESC);
`;

export async function migrate() {
  if (!isDbEnabled()) {
    console.warn('  ⚠  DATABASE_URL absent — historique des envois désactivé');
    return false;
  }

  try {
    await query(SCHEMA);
    console.log(
      '  → Base PostgreSQL prête (shipments, addresses, activity_log, package_types, shipment_comments)',
    );
    return true;
  } catch (err) {
    // Une base injoignable ne doit pas empêcher les autres pages de fonctionner.
    console.error(`  ⚠  Base PostgreSQL injoignable : ${err.message}`);
    return false;
  }
}
