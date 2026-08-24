import { query, withTransaction } from './pool.js';

/**
 * Catalogue des types de colis : le matériel expédié régulièrement, avec son
 * poids et ses dimensions.
 *
 * Comme le carnet d'adresses, aucune clé étrangère ne relie ce catalogue aux
 * envois : `shipments` recopie le poids à la création. Corriger le poids d'un
 * type ne réécrit donc jamais l'historique.
 */

/** Colonnes modifiables, dans l'ordre attendu par les requêtes. */
const FIELDS = [
  'label',
  'weight',
  'length',
  'width',
  'height',
  'description',
  'packaging_type',
  'reference',
];

/** Défaut d'abord, puis les plus utilisés : le matériel courant remonte seul. */
const ORDER_BY = `ORDER BY is_default DESC, usage_count DESC,
                  last_used_at DESC NULLS LAST, LOWER(label) ASC`;

export async function listPackageTypes({ search, includeArchived = false } = {}) {
  const conditions = [];
  const params = [];

  if (!includeArchived) conditions.push('archived_at IS NULL');

  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    conditions.push(`(label ILIKE ${p} OR description ILIKE ${p} OR reference ILIKE ${p})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(`SELECT * FROM package_types ${where} ${ORDER_BY}`, params);
  return rows.map(toPackageType);
}

export async function getPackageType(id) {
  const { rows } = await query('SELECT * FROM package_types WHERE id = $1', [id]);
  return rows[0] ? toPackageType(rows[0]) : null;
}

/** Crée un type. Poser `isDefault` retire le défaut précédent. */
export async function createPackageType(input) {
  return withTransaction(async (client) => {
    if (input.isDefault) await clearDefault(client);

    const values = FIELDS.map((f) => columnValue(f, input));
    const placeholders = FIELDS.map((_, i) => `$${i + 1}`).join(', ');

    const { rows } = await client.query(
      `INSERT INTO package_types (${FIELDS.join(', ')}, is_default)
       VALUES (${placeholders}, $${FIELDS.length + 1})
       RETURNING *`,
      [...values, Boolean(input.isDefault)],
    );
    return toPackageType(rows[0]);
  });
}

/** Modification partielle : les champs absents du corps sont laissés tels quels. */
export async function updatePackageType(id, input) {
  return withTransaction(async (client) => {
    const { rows: existing } = await client.query('SELECT * FROM package_types WHERE id = $1', [id]);
    if (!existing[0]) return null;

    if (input.isDefault) await clearDefault(client, id);

    const sets = [];
    const params = [];

    for (const field of FIELDS) {
      const key = camel(field);
      if (input[key] === undefined) continue;
      params.push(columnValue(field, input));
      sets.push(`${field} = $${params.length}`);
    }

    if (input.isDefault !== undefined) {
      params.push(Boolean(input.isDefault));
      sets.push(`is_default = $${params.length}`);
    }

    if (!sets.length) return toPackageType(existing[0]);

    sets.push('updated_at = NOW()');
    params.push(id);

    const { rows } = await client.query(
      `UPDATE package_types SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    return toPackageType(rows[0]);
  });
}

/** Archive par défaut : le type disparaît du sélecteur mais reste restaurable. */
export async function archivePackageType(id, { hard = false } = {}) {
  const { rows } = hard
    ? await query('DELETE FROM package_types WHERE id = $1 RETURNING *', [id])
    : await query(
        `UPDATE package_types SET archived_at = NOW(), is_default = FALSE, updated_at = NOW()
         WHERE id = $1 AND archived_at IS NULL RETURNING *`,
        [id],
      );
  return rows[0] ? toPackageType(rows[0]) : null;
}

export async function restorePackageType(id) {
  const { rows } = await query(
    `UPDATE package_types SET archived_at = NULL, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id],
  );
  return rows[0] ? toPackageType(rows[0]) : null;
}

/** Enregistre une utilisation : alimente le tri par fréquence. */
export async function markUsed(id) {
  const { rows } = await query(
    `UPDATE package_types SET usage_count = usage_count + 1, last_used_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id],
  );
  return rows[0] ? toPackageType(rows[0]) : null;
}

/**
 * Retrouve un type par son nom, insensible à la casse.
 * Sert à résoudre la colonne `type` d'un CSV d'envoi groupé.
 */
export async function findByLabel(label) {
  const { rows } = await query(
    `SELECT * FROM package_types
      WHERE LOWER(label) = LOWER($1) AND archived_at IS NULL
      LIMIT 1`,
    [label],
  );
  return rows[0] ? toPackageType(rows[0]) : null;
}

/* -------------------------------- Utils --------------------------------- */

async function clearDefault(client, exceptId = null) {
  const params = [];
  let where = 'is_default = TRUE';

  if (exceptId) {
    params.push(exceptId);
    where += ` AND id <> $${params.length}`;
  }

  await client.query(`UPDATE package_types SET is_default = FALSE WHERE ${where}`, params);
}

function columnValue(field, input) {
  const value = input[camel(field)];

  // Les dimensions sont facultatives : une chaîne vide vaut « non renseigné »,
  // pas zéro.
  if (['weight', 'length', 'width', 'height'].includes(field)) {
    if (value === undefined || value === null || value === '') return null;
    return Number(value);
  }

  if (field === 'packaging_type') return value || '02';
  if (value === undefined || value === '') return null;
  return value;
}

function camel(column) {
  return column.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Projette une ligne vers la forme attendue par le formulaire.
 * Les nombres sortent en chaînes : les champs de saisie manipulent du texte,
 * et c'est aussi ce que l'API Shipping attend.
 */
function toPackageType(row) {
  return {
    id: row.id,
    label: row.label,
    weight: row.weight != null ? String(Number(row.weight)) : '',
    length: row.length != null ? String(Number(row.length)) : '',
    width: row.width != null ? String(Number(row.width)) : '',
    height: row.height != null ? String(Number(row.height)) : '',
    description: row.description,
    packagingType: row.packaging_type,
    reference: row.reference,
    isDefault: row.is_default,
    usageCount: row.usage_count,
    lastUsedAt: row.last_used_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
