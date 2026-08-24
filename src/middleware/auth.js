import { config } from '../config.js';
import { isAuthConfigured, verifyToken, toActor } from '../services/keycloak.js';

/**
 * Attache l'identité de l'appelant à `req.actor`, à partir du jeton Keycloak.
 *
 * Trois modes, selon la configuration :
 *
 * | KEYCLOAK_URL | AUTH_REQUIRED | Comportement                                  |
 * |--------------|---------------|-----------------------------------------------|
 * | absent       | —             | Aucun contrôle ; req.actor reste null          |
 * | présent      | false         | Jeton vérifié s'il est fourni, sinon passe     |
 * | présent      | true          | Jeton obligatoire et vérifié, 401 sinon        |
 *
 * Le mode intermédiaire est le défaut : il permet de nommer les auteurs dans
 * le journal d'activité sans bloquer un déploiement dont le client Keycloak
 * n'est pas encore configuré.
 */
export async function attachActor(req, res, next) {
  req.actor = null;

  if (!isAuthConfigured()) return next();

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!token) {
    if (config.auth.required) {
      return next(
        Object.assign(new Error('Authentification requise.'), {
          status: 401,
          code: 'AUTH_REQUIRED',
        }),
      );
    }
    return next();
  }

  try {
    req.actor = toActor(await verifyToken(token));
    return next();
  } catch (err) {
    // Keycloak injoignable : en mode non strict, mieux vaut servir la requête
    // sans auteur que rendre l'application inutilisable.
    if (!config.auth.required && err.code !== 'TOKEN_EXPIRED') {
      console.warn(`[auth] Jeton non vérifié (${err.code}) : ${err.message}`);
      return next();
    }
    return next(err);
  }
}

/**
 * Exige une identité sur une route donnée, quelle que soit AUTH_REQUIRED.
 * Inutilisé pour l'instant : prévu pour les routes d'administration.
 */
export function requireActor(req, res, next) {
  if (!req.actor) {
    return next(
      Object.assign(new Error('Authentification requise.'), {
        status: 401,
        code: 'AUTH_REQUIRED',
      }),
    );
  }
  next();
}
