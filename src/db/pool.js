import pg from 'pg';
import { config } from '../config.js';

/**
 * Pool PostgreSQL partagé. Créé uniquement si DATABASE_URL est défini :
 * sans base, l'application reste utilisable, seul l'historique des envois
 * est désactivé.
 */
let pool = null;

if (config.databaseUrl) {
  pool = new pg.Pool({
    connectionString: config.databaseUrl,
    // Les hébergeurs managés (Neon, Supabase…) imposent TLS ; en réseau
    // interne Coolify, la connexion est en clair.
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on('error', (err) => {
    // Un client inactif peut être coupé par le serveur : on le journalise
    // sans faire tomber le process.
    console.error('[db] Erreur inattendue sur un client inactif :', err.message);
  });
}

export function isDbEnabled() {
  return pool !== null;
}

/** Exécute une requête. Lève une erreur explicite si la base n'est pas configurée. */
export async function query(text, params) {
  if (!pool) {
    throw Object.assign(
      new Error(
        "L'historique des envois nécessite une base PostgreSQL. Renseignez DATABASE_URL.",
      ),
      { status: 503, code: 'DB_NOT_CONFIGURED' },
    );
  }
  return pool.query(text, params);
}

/** Exécute plusieurs requêtes dans une transaction. */
export async function withTransaction(fn) {
  if (!pool) {
    throw Object.assign(new Error('Base PostgreSQL non configurée.'), {
      status: 503,
      code: 'DB_NOT_CONFIGURED',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) await pool.end();
}
