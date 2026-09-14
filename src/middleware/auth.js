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
 *
 * Sert l'annuaire des mentions : il expose les noms et courriels du realm,
 * qui n'ont pas à être lisibles par quiconque atteint le backend. Le mode
 * permissif d'AUTH_REQUIRED vaut pour les pages d'expédition, pas pour des
 * données personnelles.
 *
 * Keycloak non configuré : la route reste ouverte, faute de quoi elle serait
 * inutilisable en développement. C'est sans conséquence, l'annuaire ayant
 * lui aussi besoin de Keycloak pour répondre.
 */
export function requireActor(req, res, next) {
  if (!isAuthConfigured()) return next();

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

/**
 * Exige le rôle Keycloak `admin`, sans jamais laisser passer par défaut.
 *
 * Réservé aux routes qui manipulent des secrets — la génération de clés
 * d'API en particulier. À la différence de requireActor, Keycloak absent ne
 * vaut pas laissez-passer : une clé d'API ouvre un compte UPS facturé, et
 * un backend sans authentification ne doit pas pouvoir en fabriquer. Sans
 * Keycloak, la variable API_KEYS reste le moyen de déclarer une clé.
 *
 * Le rôle `admin` est celui que la plateforme Konitys donne à ses
 * administrateurs ; c'est lui que le proxy de l'admin panel relaie.
 */
export function requireAdmin(req, res, next) {
  if (!req.actor) {
    return next(
      Object.assign(new Error('Authentification requise.'), {
        status: 401,
        code: 'AUTH_REQUIRED',
      }),
    );
  }

  if (!req.actor.roles?.includes('admin')) {
    return next(
      Object.assign(new Error('Réservé aux administrateurs.'), {
        status: 403,
        code: 'ADMIN_REQUIRED',
      }),
    );
  }

  next();
}
