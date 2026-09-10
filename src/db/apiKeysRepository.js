import { randomBytes } from 'node:crypto';
import { query } from './pool.js';

/**
 * Clés de l'API machine, gérées depuis l'admin panel.
 *
 * Le jeton complet n'est jamais renvoyé aux listes : seule sa création le
 * montre, et l'admin l'affiche alors une fois. Le reste du temps on n'expose
 * qu'un aperçu, suffisant pour reconnaître une clé sans permettre de s'en
 * servir si la page est vue par-dessus une épaule.
 */

/** 32 octets : la même longueur que celle recommandée dans la documentation. */
const TOKEN_BYTES = 32;

/** Assez pour distinguer deux clés, trop court pour être rejoué. */
const PREVIEW_CHARS = 8;

export function generateToken() {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/** Aperçu affichable : les premiers caractères, le reste masqué. */
export function previewOf(token) {
  const value = String(token ?? '');
  return value ? `${value.slice(0, PREVIEW_CHARS)}${'•'.repeat(24)}` : null;
}

function toKey(row, { withToken = false } = {}) {
  return {
    id: Number(row.id),
    clientName: row.client_name,
    // Le jeton n'accompagne que sa propre création.
    token: withToken ? row.token : undefined,
    preview: previewOf(row.token),
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Clés actives, sans les jetons. */
export async function listKeys({ includeRevoked = false } = {}) {
  const { rows } = await query(
    `SELECT * FROM api_keys
      ${includeRevoked ? '' : 'WHERE revoked_at IS NULL'}
      ORDER BY revoked_at IS NOT NULL, created_at DESC`,
  );
  return rows.map((row) => toKey(row));
}

/** La clé active la plus récente, pour l'affichage de l'admin. */
export async function latestKey() {
  const { rows } = await query(
    `SELECT * FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
  );
  return rows[0] ? toKey(rows[0]) : null;
}

/**
 * Crée une clé pour une application.
 *
 * Une clé active existant déjà sous ce nom est révoquée : « générer un
 * nouveau token » remplace le précédent, il ne fait pas coexister deux clés
 * valides pour le même appelant.
 */
export async function createKey(clientName) {
  const name = String(clientName ?? '').trim();
  if (!name) throw Object.assign(new Error('Nom d’application requis.'), { status: 400 });

  await query(
    `UPDATE api_keys SET revoked_at = NOW(), updated_at = NOW()
      WHERE LOWER(client_name) = LOWER($1) AND revoked_at IS NULL`,
    [name],
  );

  const token = generateToken();
  const { rows } = await query(
    `INSERT INTO api_keys (client_name, token) VALUES ($1, $2) RETURNING *`,
    [name, token],
  );

  return toKey(rows[0], { withToken: true });
}

/** Révoque une clé. Archivage : l'historique garde un nom lisible. */
export async function revokeKey(id) {
  const { rows } = await query(
    `UPDATE api_keys SET revoked_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING *`,
    [id],
  );
  return rows[0] ? toKey(rows[0]) : null;
}

/**
 * Retrouve l'application derrière un jeton.
 *
 * La comparaison se fait en base, sur un index : comparer en mémoire
 * imposerait de charger toutes les clés à chaque appel.
 */
export async function findByToken(token) {
  const value = String(token ?? '');
  if (!value) return null;

  const { rows } = await query(
    `SELECT * FROM api_keys WHERE token = $1 AND revoked_at IS NULL LIMIT 1`,
    [value],
  );
  return rows[0] ? { id: Number(rows[0].id), name: rows[0].client_name } : null;
}

/**
 * Note qu'une clé vient de servir.
 *
 * Volontairement non attendu par l'appelant : un compteur d'usage ne doit
 * jamais retarder ni faire échouer la requête qu'il mesure.
 */
export function touchKey(id) {
  query(
    `UPDATE api_keys SET last_used_at = NOW(), use_count = use_count + 1 WHERE id = $1`,
    [id],
  ).catch(() => {});
}
