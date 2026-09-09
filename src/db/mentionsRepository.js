import { query } from './pool.js';

/**
 * Mentions « @quelqu'un » dans un commentaire.
 *
 * Enregistrées à part du commentaire : elles se retrouvent par personne
 * (« mes mentions ») et portent chacune l'état de sa notification.
 */

function toMention(row) {
  return {
    id: Number(row.id),
    commentId: Number(row.comment_id),
    trackingNumber: row.tracking_number,
    user: { id: row.user_id, name: row.user_name, email: row.user_email },
    notifiedAt: row.notified_at,
    notifyError: row.notify_error,
    createdAt: row.created_at,
  };
}

/**
 * Enregistre les personnes mentionnées dans un commentaire.
 *
 * `ON CONFLICT DO NOTHING` : un nom cité deux fois dans le même commentaire
 * ne doit produire qu'une notification.
 */
export async function addMentions({ commentId, trackingNumber, users }) {
  if (!users?.length) return [];

  const values = [];
  const params = [];
  users.forEach((user, i) => {
    const base = i * 5;
    values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`);
    params.push(commentId, trackingNumber, user.id, user.name ?? null, user.email ?? null);
  });

  const { rows } = await query(
    `INSERT INTO comment_mentions
       (comment_id, tracking_number, user_id, user_name, user_email)
     VALUES ${values.join(',')}
     ON CONFLICT (comment_id, user_id) DO NOTHING
     RETURNING *`,
    params,
  );

  return rows.map(toMention);
}

/** Mentions d'un commentaire. */
export async function listByComment(commentId) {
  const { rows } = await query(
    `SELECT * FROM comment_mentions WHERE comment_id = $1 ORDER BY id ASC`,
    [commentId],
  );
  return rows.map(toMention);
}

/**
 * Mentions d'un ensemble de commentaires, en une requête.
 * Renvoie un objet indexé par identifiant de commentaire.
 */
export async function listByComments(commentIds) {
  if (!commentIds?.length) return {};

  const { rows } = await query(
    `SELECT * FROM comment_mentions WHERE comment_id = ANY($1) ORDER BY id ASC`,
    [commentIds.map(Number)],
  );

  const byComment = {};
  for (const row of rows) {
    const mention = toMention(row);
    (byComment[mention.commentId] ??= []).push(mention);
  }
  return byComment;
}

/** Marque une notification comme envoyée. */
export async function markNotified(id) {
  await query(
    `UPDATE comment_mentions SET notified_at = NOW(), notify_error = NULL WHERE id = $1`,
    [id],
  );
}

/**
 * Note l'échec d'une notification, sans marquer la mention notifiée : la
 * reprise pourra la retenter.
 */
export async function markNotifyError(id, message) {
  await query(`UPDATE comment_mentions SET notify_error = $2 WHERE id = $1`, [
    id,
    String(message ?? '').slice(0, 500),
  ]);
}

/**
 * Mentions dont la notification n'est jamais partie.
 *
 * Sert la reprise après une panne de l'application de notifications. Les
 * plus anciennes d'abord : elles attendent depuis le plus longtemps.
 */
export async function listPendingNotifications(limit = 50) {
  const { rows } = await query(
    `SELECT * FROM comment_mentions
      WHERE notified_at IS NULL
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit],
  );
  return rows.map(toMention);
}
