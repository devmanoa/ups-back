import { createHash, randomBytes } from 'node:crypto';
import { query, withTransaction } from './pool.js';

/**
 * Clés de l'API machine, gérées depuis l'admin panel.
 *
 * Le jeton n'est jamais stocké : seule son empreinte SHA-256 l'est, avec
 * ses premiers caractères pour l'identifier dans une liste. Il n'existe en
 * clair qu'une fois, dans la réponse de sa création. Une sauvegarde ou un
 * `SELECT *` de diagnostic ne peuvent donc rien livrer d'utilisable, et
 * aucune route n'a à se souvenir de ne pas renvoyer une colonne secrète.
 */

/** 32 octets aléatoires : assez d'entropie pour qu'un SHA-256 nu suffise. */
const TOKEN_BYTES = 32;
const PREFIX_CHARS = 8;

/** Colonnes servies aux listes. Le secret n'y figure pas, par construction. */
const PUBLIC_COLUMNS = `id, client_name, token_prefix, revoked_at, last_used_at, use_count, created_at`;

function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function toKey(row) {
  return {
    id: Number(row.id),
    clientName: row.client_name,
    // Aperçu explicite : un admin qui le copie doit voir qu'il n'a pas le
    // jeton, et non découvrir un 401 en l'utilisant.
    preview: `${row.token_prefix}… (jeton masqué, affiché à la création)`,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count ?? 0,
    createdAt: row.created_at,
  };
}

/** Clés actives, la plus récente en premier. */
export async function listKeys() {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS} FROM api_keys
      WHERE revoked_at IS NULL
      ORDER BY created_at DESC`,
  );
  return rows.map(toKey);
}

/** Au moins une clé active existe-t-elle ? Sert à distinguer 503 de 401. */
export async function hasActiveKeys() {
  const { rows } = await query(
    `SELECT EXISTS (SELECT 1 FROM api_keys WHERE revoked_at IS NULL) AS present`,
  );
  return Boolean(rows[0]?.present);
}

/**
 * Crée une clé pour une application.
 *
 * Révocation de la précédente et insertion dans la même transaction : deux
 * requêtes séparées laisseraient, entre les deux, une application sans
 * aucune clé valide si la seconde échouait. « Générer un nouveau token »
 * remplace la clé, il n'en fait pas coexister deux pour le même appelant.
 *
 * Le jeton en clair n'existe que dans la valeur renvoyée ici.
 */
export async function createKey(clientName) {
  const name = String(clientName ?? '').trim();
  if (!name) {
    throw Object.assign(new Error('Nom d’application requis.'), {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  const token = randomBytes(TOKEN_BYTES).toString('hex');

  try {
    const row = await withTransaction(async (client) => {
      await client.query(
        `UPDATE api_keys SET revoked_at = NOW()
          WHERE LOWER(client_name) = LOWER($1) AND revoked_at IS NULL`,
        [name],
      );
      const { rows } = await client.query(
        `INSERT INTO api_keys (client_name, token_hash, token_prefix)
         VALUES ($1, $2, $3)
         RETURNING ${PUBLIC_COLUMNS}`,
        [name, hashToken(token), token.slice(0, PREFIX_CHARS)],
      );
      return rows[0];
    });

    return { ...toKey(row), token };
  } catch (err) {
    // Deux générations simultanées pour le même nom : la seconde bute sur
    // l'index d'unicité. C'est un conflit, pas une panne — la première a
    // réussi et son jeton a été montré.
    if (err.code === '23505') {
      throw Object.assign(
        new Error('Une clé vient d’être générée pour cette application. Rechargez la page.'),
        { status: 409, code: 'API_KEY_CONFLICT' },
      );
    }
    throw err;
  }
}

/** Révoque une clé. Archivage : l'historique garde un nom lisible. */
export async function revokeKey(id) {
  const { rows } = await query(
    `UPDATE api_keys SET revoked_at = NOW()
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING ${PUBLIC_COLUMNS}`,
    [id],
  );
  return rows[0] ? toKey(rows[0]) : null;
}

/**
 * Retrouve l'application derrière un jeton, par son empreinte.
 *
 * Comparer l'empreinte et non le jeton rend la recherche indifférente au
 * contenu de ce dernier : le temps de réponse ne renseigne pas sur les
 * caractères qui coïncident, ce qu'une égalité sur le jeton laisserait
 * mesurer.
 */
export async function findByToken(token) {
  const value = String(token ?? '');
  if (!value) return null;

  const { rows } = await query(
    `SELECT id, client_name FROM api_keys
      WHERE token_hash = $1 AND revoked_at IS NULL
      LIMIT 1`,
    [hashToken(value)],
  );
  return rows[0] ? { id: Number(rows[0].id), name: rows[0].client_name } : null;
}

/** Erreurs déjà signalées, pour n'avertir qu'une fois par cause. */
const reportedTouchErrors = new Set();

/**
 * Note qu'une clé vient de servir.
 *
 * Non attendu par l'appelant : un compteur d'usage ne doit jamais retarder
 * ni faire échouer la requête qu'il mesure. L'échec est toutefois signalé
 * — une fois par cause, pas à chaque appel — car un compteur figé à zéro
 * ferait croire qu'une clé ne sert plus, et la ferait révoquer à tort.
 */
export function touchKey(id) {
  query(
    `UPDATE api_keys SET last_used_at = NOW(), use_count = use_count + 1 WHERE id = $1`,
    [id],
  ).catch((err) => {
    if (reportedTouchErrors.has(err.message)) return;
    reportedTouchErrors.add(err.message);
    console.warn(`[api] Compteur d’usage non écrit : ${err.message}`);
  });
}
