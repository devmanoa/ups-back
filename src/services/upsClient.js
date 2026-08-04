import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getAccessToken, invalidateToken } from './auth.js';

/**
 * Extrait un message lisible depuis les différentes formes d'erreur renvoyées
 * par les APIs UPS (le format varie selon l'API et la couche qui rejette).
 */
function parseUpsError(data, res) {
  const errors =
    data?.response?.errors ||
    data?.Response?.Error ||
    data?.errors ||
    (data?.fault ? [{ message: data.fault.faultstring }] : null);

  if (Array.isArray(errors) && errors.length) {
    return {
      message: errors.map((e) => e.message || e.ErrorDescription).filter(Boolean).join(' | '),
      codes: errors.map((e) => e.code || e.ErrorCode).filter(Boolean),
    };
  }
  return { message: `Erreur UPS (HTTP ${res.status})`, codes: [] };
}

/**
 * Appelle une API UPS avec authentification, retry unique sur 401
 * (jeton révoqué côté UPS) et normalisation des erreurs.
 *
 * @param {string} path chemin après /api, ex: "/track/v1/details/1Z..."
 * @param {object} options
 * @param {'GET'|'POST'|'DELETE'} [options.method]
 * @param {object} [options.body] corps JSON
 * @param {object} [options.query] paramètres de requête
 * @param {object} [options.headers] en-têtes additionnels
 */
export async function upsFetch(path, { method = 'GET', body, query, headers = {} } = {}) {
  return doFetch(path, { method, body, query, headers }, false);
}

async function doFetch(path, { method, body, query, headers }, isRetry) {
  const token = await getAccessToken();

  const url = new URL(`${config.baseUrl}/api${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      transId: randomUUID().replace(/-/g, '').slice(0, 32),
      transactionSrc: 'ups-backend',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw Object.assign(new Error(`Réponse UPS non-JSON: ${text.slice(0, 300)}`), {
        status: 502,
        code: 'UPS_BAD_RESPONSE',
      });
    }
  }

  // Un jeton peut être invalidé côté UPS avant son expiration annoncée.
  if (res.status === 401 && !isRetry) {
    invalidateToken();
    return doFetch(path, { method, body, query, headers }, true);
  }

  if (!res.ok) {
    const { message, codes } = parseUpsError(data, res);
    throw Object.assign(new Error(message), {
      status: res.status,
      code: codes[0] || 'UPS_API_ERROR',
      upsCodes: codes,
      details: data,
    });
  }

  return data;
}
