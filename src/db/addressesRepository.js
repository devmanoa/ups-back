import { query, withTransaction } from './pool.js';

/**
 * Carnet d'adresses partagé : un même référentiel pour tous les utilisateurs.
 * Sert à pré-remplir les destinataires des formulaires d'expédition.
 *
 * Aucune clé étrangère ne relie ce carnet à `shipments` : les envois recopient
 * l'adresse au moment de leur création. Modifier ou archiver une entrée du
 * carnet ne réécrit donc jamais l'historique.
 */

/** Colonnes modifiables d'une adresse, dans l'ordre attendu par les requêtes. */
const FIELDS = [
  'label',
  'name',
  'attention_name',
  'phone',
  'address_line1',
  'address_line2',
  'city',
  'state',
  'postal_code',
  'country',
  'residential',
  'group_id',
];

/** Applique l'ordre d'affichage : défaut d'abord, puis les plus utilisées. */
const ORDER_BY = `ORDER BY is_default DESC, usage_count DESC,
                  last_used_at DESC NULLS LAST, LOWER(label) ASC`;

/**
 * Liste les adresses du carnet.
 * Les archivées sont masquées sauf demande explicite.
 */
export async function listAddresses({ search, groupId, includeArchived = false } = {}) {
  const conditions = [];
  const params = [];

  if (!includeArchived) conditions.push('archived_at IS NULL');

  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    conditions.push(
      `(label ILIKE ${p} OR name ILIKE ${p} OR city ILIKE ${p}
        OR postal_code ILIKE ${p} OR address_line1 ILIKE ${p})`,
    );
  }

  // 'none' filtre les adresses sans groupe : distinct de « tous les groupes ».
  if (groupId === 'none') {
    conditions.push('group_id IS NULL');
  } else if (groupId) {
    params.push(groupId);
    conditions.push(`group_id = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(`SELECT * FROM addresses ${where} ${ORDER_BY}`, params);
  return rows.map(toAddress);
}

export async function getAddress(id) {
  const { rows } = await query('SELECT * FROM addresses WHERE id = $1', [id]);
  return rows[0] ? toAddress(rows[0]) : null;
}

/**
 * Crée une adresse. Poser `isDefault` retire le défaut précédent du même
 * groupe : la transaction garantit qu'il n'y en a jamais deux à la fois.
 */
export async function createAddress(input) {
  return withTransaction(async (client) => {
    if (input.isDefault) await clearDefault(client, input.groupId ?? null);

    const values = FIELDS.map((f) => columnValue(f, input));
    const placeholders = FIELDS.map((_, i) => `$${i + 1}`).join(', ');

    const { rows } = await client.query(
      `INSERT INTO addresses (${FIELDS.join(', ')}, is_default)
       VALUES (${placeholders}, $${FIELDS.length + 1})
       RETURNING *`,
      [...values, Boolean(input.isDefault)],
    );
    return toAddress(rows[0]);
  });
}

/** Met à jour une adresse. Les champs absents du corps sont laissés tels quels. */
export async function updateAddress(id, input) {
  return withTransaction(async (client) => {
    const { rows: existing } = await client.query('SELECT * FROM addresses WHERE id = $1', [id]);
    if (!existing[0]) return null;

    const current = existing[0];
    const nextGroupId =
      input.groupId !== undefined ? normalizeGroupId(input.groupId) : current.group_id;

    if (input.isDefault) await clearDefault(client, nextGroupId, id);

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

    if (!sets.length) return toAddress(current);

    sets.push('updated_at = NOW()');
    params.push(id);

    const { rows } = await client.query(
      `UPDATE addresses SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    return toAddress(rows[0]);
  });
}

/**
 * Archive une adresse : elle disparaît des sélecteurs mais reste consultable
 * et restaurable. `hard` supprime définitivement la ligne.
 */
export async function archiveAddress(id, { hard = false } = {}) {
  const { rows } = hard
    ? await query('DELETE FROM addresses WHERE id = $1 RETURNING *', [id])
    : await query(
        `UPDATE addresses SET archived_at = NOW(), is_default = FALSE, updated_at = NOW()
         WHERE id = $1 AND archived_at IS NULL RETURNING *`,
        [id],
      );
  return rows[0] ? toAddress(rows[0]) : null;
}

export async function restoreAddress(id) {
  const { rows } = await query(
    `UPDATE addresses SET archived_at = NULL, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id],
  );
  return rows[0] ? toAddress(rows[0]) : null;
}

/**
 * Enregistre une utilisation : alimente le tri par fréquence.
 * Appelé au chargement d'une adresse dans un formulaire.
 */
export async function markUsed(id) {
  const { rows } = await query(
    `UPDATE addresses SET usage_count = usage_count + 1, last_used_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id],
  );
  return rows[0] ? toAddress(rows[0]) : null;
}

/* ------------------------------- Groupes -------------------------------- */

/** Liste les groupes avec le nombre d'adresses actives de chacun. */
export async function listGroups() {
  const { rows } = await query(
    `SELECT g.*, COUNT(a.id) FILTER (WHERE a.archived_at IS NULL) AS address_count
       FROM address_groups g
       LEFT JOIN addresses a ON a.group_id = g.id
      GROUP BY g.id
      ORDER BY g.position ASC, LOWER(g.name) ASC`,
  );
  return rows.map(toGroup);
}

export async function createGroup({ name, position }) {
  const { rows } = await query(
    `INSERT INTO address_groups (name, position)
     VALUES ($1, COALESCE($2, (SELECT COALESCE(MAX(position), 0) + 1 FROM address_groups)))
     RETURNING *`,
    [name, position ?? null],
  );
  return toGroup(rows[0]);
}

export async function updateGroup(id, { name, position }) {
  const sets = [];
  const params = [];

  if (name !== undefined) {
    params.push(name);
    sets.push(`name = $${params.length}`);
  }
  if (position !== undefined) {
    params.push(position);
    sets.push(`position = $${params.length}`);
  }
  if (!sets.length) return getGroup(id);

  params.push(id);
  const { rows } = await query(
    `UPDATE address_groups SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );
  return rows[0] ? toGroup(rows[0]) : null;
}

export async function getGroup(id) {
  const { rows } = await query('SELECT * FROM address_groups WHERE id = $1', [id]);
  return rows[0] ? toGroup(rows[0]) : null;
}

/** Supprime un groupe. Ses adresses sont conservées et deviennent sans groupe. */
export async function deleteGroup(id) {
  const { rows } = await query('DELETE FROM address_groups WHERE id = $1 RETURNING *', [id]);
  return rows[0] ? toGroup(rows[0]) : null;
}

/** Vrai si le groupe existe : évite d'écrire une référence orpheline. */
export async function groupExists(id) {
  const { rows } = await query('SELECT 1 FROM address_groups WHERE id = $1', [id]);
  return rows.length > 0;
}

/* -------------------------------- Utils --------------------------------- */

/** Retire le défaut courant d'un groupe, en épargnant éventuellement une ligne. */
async function clearDefault(client, groupId, exceptId = null) {
  const params = [];
  let where;

  if (groupId === null || groupId === undefined) {
    where = 'group_id IS NULL';
  } else {
    params.push(groupId);
    where = `group_id = $${params.length}`;
  }

  if (exceptId) {
    params.push(exceptId);
    where += ` AND id <> $${params.length}`;
  }

  await client.query(`UPDATE addresses SET is_default = FALSE WHERE ${where}`, params);
}

/** Un identifiant de groupe vide vaut « sans groupe », pas 0. */
function normalizeGroupId(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number(value);
}

function columnValue(field, input) {
  const value = input[camel(field)];
  if (field === 'group_id') return normalizeGroupId(value);
  if (field === 'residential') return Boolean(value);
  if (value === undefined || value === '') return field === 'country' ? 'FR' : null;
  return value;
}

function camel(column) {
  return column.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Projette une ligne vers la forme `Address` du frontend, afin qu'une adresse
 * chargée depuis le carnet entre telle quelle dans un formulaire.
 */
function toAddress(row) {
  return {
    id: row.id,
    label: row.label,
    groupId: row.group_id,
    name: row.name,
    attentionName: row.attention_name,
    phone: row.phone,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    country: row.country,
    residential: row.residential,
    isDefault: row.is_default,
    usageCount: row.usage_count,
    lastUsedAt: row.last_used_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toGroup(row) {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    // Absent des requêtes de mutation, présent dans la liste.
    addressCount: row.address_count !== undefined ? Number(row.address_count) : undefined,
    createdAt: row.created_at,
  };
}
