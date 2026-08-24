import { query } from './pool.js';

/**
 * Journal d'activité applicative : qui a créé une étiquette, ajouté une
 * adresse, annulé un envoi.
 *
 * À ne pas confondre avec l'historique UPS (parcours du colis), qui vit dans
 * la table shipments et provient des APIs Tracking / QuantumView.
 */

/** Écrit une entrée. Le résumé est figé ici, jamais recalculé à la lecture. */
export async function record({ actor, action, entityType, entityId, summary, metadata }) {
  const { rows } = await query(
    `INSERT INTO activity_log
       (actor_id, actor_name, actor_email, action, entity_type, entity_id, summary, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      actor?.id ?? null,
      actor?.name ?? null,
      actor?.email ?? null,
      action,
      entityType ?? null,
      entityId != null ? String(entityId) : null,
      summary,
      metadata ? JSON.stringify(metadata) : null,
    ],
  );
  return toEntry(rows[0]);
}

/** Liste paginée, filtrable par auteur, action, entité et période. */
export async function listActivity({
  actorId,
  action,
  entityType,
  entityId,
  from,
  to,
  search,
  limit = 50,
  offset = 0,
} = {}) {
  const conditions = [];
  const params = [];

  if (actorId) {
    params.push(actorId);
    conditions.push(`actor_id = $${params.length}`);
  }

  // `action` accepte un préfixe : "address" couvre address.create,
  // address.update… sans lister chaque variante côté client.
  if (action) {
    params.push(action, `${action}.%`);
    conditions.push(`(action = $${params.length - 1} OR action LIKE $${params.length})`);
  }

  if (entityType) {
    params.push(entityType);
    conditions.push(`entity_type = $${params.length}`);
  }
  if (entityId) {
    params.push(String(entityId));
    conditions.push(`entity_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`occurred_at >= $${params.length}`);
  }
  if (to) {
    // Borne incluse : l'utilisateur choisit un jour, pas un instant.
    params.push(to);
    conditions.push(`occurred_at < ($${params.length}::date + INTERVAL '1 day')`);
  }
  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    conditions.push(`(summary ILIKE ${p} OR actor_name ILIKE ${p} OR entity_id ILIKE ${p})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS total FROM activity_log ${where}`,
    params,
  );

  params.push(limit, offset);
  const { rows } = await query(
    `SELECT * FROM activity_log ${where}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return { total: countRows[0].total, entries: rows.map(toEntry) };
}

/** Auteurs distincts, pour alimenter le filtre de la page Timeline. */
export async function listActors() {
  const { rows } = await query(
    `SELECT actor_id, MAX(actor_name) AS actor_name, COUNT(*)::int AS action_count
       FROM activity_log
      WHERE actor_id IS NOT NULL
      GROUP BY actor_id
      ORDER BY action_count DESC`,
  );
  return rows.map((r) => ({
    id: r.actor_id,
    name: r.actor_name,
    actionCount: r.action_count,
  }));
}

/** Répartition par action, sur une période, pour le récapitulatif. */
export async function countByAction({ from, to } = {}) {
  const conditions = [];
  const params = [];

  if (from) {
    params.push(from);
    conditions.push(`occurred_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`occurred_at < ($${params.length}::date + INTERVAL '1 day')`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT action, COUNT(*)::int AS count FROM activity_log ${where}
      GROUP BY action ORDER BY count DESC`,
    params,
  );

  return Object.fromEntries(rows.map((r) => [r.action, r.count]));
}

function toEntry(row) {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    actor: {
      id: row.actor_id,
      // Les actions antérieures à l'activation de Keycloak n'ont pas d'auteur.
      name: row.actor_name ?? 'Utilisateur inconnu',
      email: row.actor_email,
    },
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    summary: row.summary,
    metadata: row.metadata,
  };
}
