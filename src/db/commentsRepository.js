import { query } from './pool.js';

/**
 * Commentaires libres attachés à un envoi.
 *
 * Complète le journal d'activité, qui n'enregistre que des actions faites
 * dans l'application : un commentaire porte ce qui s'est passé ailleurs
 * (« client prévenu par téléphone », « colis récupéré à l'agence »).
 */

/** Longueur maximale d'un commentaire, alignée sur le champ du formulaire. */
export const MAX_BODY = 2000;

function toComment(row) {
  return {
    id: Number(row.id),
    trackingNumber: row.tracking_number,
    body: row.body,
    createdAt: row.created_at,
    actor: row.actor_id || row.actor_name
      ? { id: row.actor_id, name: row.actor_name, email: row.actor_email }
      : null,
  };
}

/** Liste les commentaires d'un envoi, du plus récent au plus ancien. */
export async function listComments(trackingNumber) {
  const { rows } = await query(
    `SELECT * FROM shipment_comments
      WHERE tracking_number = $1 AND deleted_at IS NULL
      ORDER BY created_at DESC`,
    [trackingNumber],
  );
  return rows.map(toComment);
}

export async function addComment({ trackingNumber, body, actor }) {
  const { rows } = await query(
    `INSERT INTO shipment_comments
       (tracking_number, actor_id, actor_name, actor_email, body)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [
      trackingNumber,
      actor?.id ?? null,
      actor?.name ?? null,
      actor?.email ?? null,
      body,
    ],
  );
  return toComment(rows[0]);
}

/**
 * Supprime un commentaire, à condition qu'il appartienne à `actorId`.
 *
 * Suppression douce : le fil garde sa cohérence, et une suppression
 * accidentelle reste rattrapable en base.
 *
 * Renvoie `'deleted'`, `'not_found'` ou `'forbidden'` — l'appelant traduit.
 * Distinguer les deux derniers cas permet un message utile plutôt qu'un 404
 * trompeur sur un commentaire qui existe bel et bien.
 */
export async function deleteComment(id, actorId) {
  const { rows } = await query(
    `SELECT actor_id FROM shipment_comments WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  if (!rows.length) return 'not_found';

  // Sans identité vérifiée (Keycloak absent), personne ne peut supprimer :
  // un fil partagé ne doit pas être effaçable par un anonyme.
  if (!actorId || rows[0].actor_id !== actorId) return 'forbidden';

  await query(`UPDATE shipment_comments SET deleted_at = NOW() WHERE id = $1`, [id]);
  return 'deleted';
}

/** Nombre de commentaires par envoi, pour pastiller la liste sans N requêtes. */
export async function countByTracking(trackingNumbers) {
  if (!trackingNumbers?.length) return {};

  const { rows } = await query(
    `SELECT tracking_number, COUNT(*)::int AS total
       FROM shipment_comments
      WHERE deleted_at IS NULL AND tracking_number = ANY($1)
      GROUP BY tracking_number`,
    [trackingNumbers],
  );
  return Object.fromEntries(rows.map((r) => [r.tracking_number, r.total]));
}
