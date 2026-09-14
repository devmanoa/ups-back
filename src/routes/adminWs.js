import { Router } from 'express';
import { config } from '../config.js';
import { isDbEnabled } from '../db/pool.js';
import { listKeys, createKey, revokeKey } from '../db/apiKeysRepository.js';
import { requireAdmin } from '../middleware/auth.js';
import { asyncHandler, badRequest } from '../middleware/validate.js';

/**
 * Onglet « WS API » de l'admin panel : description de l'API machine et
 * gestion de ses clés.
 *
 * Deux niveaux d'accès. La liste des routes est publique — elle ne dit rien
 * qu'un client de l'API ne sache déjà. Les clés, elles, exigent le rôle
 * Keycloak `admin`, relayé par le proxy de l'admin panel avec chaque appel :
 * une clé ouvre un compte UPS facturé, et sa fabrication ne peut dépendre
 * d'une protection située dans un autre dépôt.
 */
export const adminWsRouter = Router();

/**
 * Les routes de `/api/v1`, telles que l'admin les affiche.
 *
 * Décrites à la main plutôt que déduites du routeur : la description et les
 * paramètres n'existent nulle part dans le code, et une liste générée
 * automatiquement afficherait des chemins sans en expliquer l'usage.
 */
const ENDPOINTS = [
  {
    name: 'ping',
    method: 'GET',
    path: '/api/v1/ping',
    description: 'Vérifie la clé sans créer d’étiquette facturée',
    params: [],
    status: 'done',
  },
  {
    name: 'services',
    method: 'GET',
    path: '/api/v1/services',
    description: 'Codes de service et formats d’étiquette acceptés',
    params: [],
    status: 'done',
  },
  {
    name: 'create-shipment',
    method: 'POST',
    path: '/api/v1/shipments',
    description: 'Crée une étiquette (facturée par UPS en production)',
    params: [],
    status: 'done',
  },
  {
    name: 'get-shipment',
    method: 'GET',
    path: '/api/v1/shipments/:id',
    description: 'État d’un envoi',
    params: [{ name: 'id', description: 'Identifiant renvoyé à la création' }],
    status: 'done',
  },
  {
    name: 'get-label',
    method: 'GET',
    path: '/api/v1/shipments/:id/label',
    description: 'Étiquettes en base64, ou en binaire avec format=binary',
    params: [
      { name: 'id', description: 'Identifiant de l’envoi' },
      { name: 'format', description: 'binary pour un fichier prêt à imprimer' },
    ],
    status: 'done',
  },
  {
    name: 'void-shipment',
    method: 'DELETE',
    path: '/api/v1/shipments/:shipmentId',
    description: 'Annule une expédition (identifiant UPS attendu)',
    params: [
      { name: 'shipmentId', description: 'Identifiant UPS de l’expédition' },
      { name: 'trackingNumbers', description: 'Colis à annuler, séparés par des virgules' },
    ],
    status: 'done',
  },
  {
    name: 'create-order',
    method: 'POST',
    path: '/api/v1/orders',
    description: 'Crée une commande : jusqu’à 50 expéditions en un appel',
    params: [],
    status: 'done',
  },
  {
    name: 'get-order',
    method: 'GET',
    path: '/api/v1/orders/:orderId',
    description: 'État d’une commande et de ses envois',
    params: [{ name: 'orderId', description: 'Identifiant renvoyé à la création' }],
    status: 'done',
  },
];

/** GET /adminpanel/ws/endpoints — contrat de l'API machine. Public. */
adminWsRouter.get('/endpoints', (_req, res) => {
  res.json({ data: ENDPOINTS, count: ENDPOINTS.length });
});

// Tout ce qui touche aux clés est réservé aux administrateurs.
adminWsRouter.use('/token', requireAdmin);

/**
 * Nom d'application par défaut à la génération.
 *
 * L'admin panel poste sans corps : il faut donc un nom, sinon la clé serait
 * anonyme dans le journal. Un appelant qui envoie `{ client }` le remplace.
 */
const DEFAULT_CLIENT = 'adminpanel';

/** Les écritures exigent la base ; la lecture, elle, se replie sur API_KEYS. */
function requireDb(req, res, next) {
  if (isDbEnabled()) return next();
  next(
    Object.assign(
      new Error(
        'Base de données requise pour gérer les clés. Renseignez DATABASE_URL, ou utilisez la variable API_KEYS.',
      ),
      { status: 503, code: 'DB_NOT_CONFIGURED' },
    ),
  );
}

/**
 * GET /adminpanel/ws/token — la clé courante et la liste des clés.
 *
 * Le jeton n'est jamais renvoyé ici : il n'est pas stocké. Le champ `token`
 * porte un aperçu explicite, pour que l'admin panel affiche quelque chose
 * sans qu'un copier-coller passe pour un jeton valide.
 */
adminWsRouter.get(
  '/token',
  asyncHandler(async (_req, res) => {
    const envClients = config.apiKeys.map((entry) => entry.name);
    const keys = isDbEnabled() ? await listKeys() : [];
    // La liste est triée par date décroissante : la première est la courante.
    const current = keys[0] ?? null;

    res.json({
      token: current?.preview ?? null,
      updated_at: current?.createdAt ?? null,
      configured: keys.length > 0 || envClients.length > 0,
      // Un nom peut exister dans les deux sources : une seule mention, et la
      // source indiquée, car révoquer la clé en base ne ferme pas celle de
      // l'environnement.
      clients: [...new Set([...keys.map((k) => k.clientName), ...envClients])],
      env_clients: envClients,
      keys: keys.map((k) => ({
        id: k.id,
        client: k.clientName,
        preview: k.preview,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        useCount: k.useCount,
      })),
      message: current
        ? 'Le jeton complet n’est montré qu’à sa création.'
        : envClients.length
          ? `Clés déclarées dans API_KEYS : ${envClients.join(', ')}.`
          : 'Aucune clé. Cliquez sur « Générer » pour en créer une.',
    });
  }),
);

/**
 * POST /adminpanel/ws/token — crée une clé.
 *
 * Seul moment où le jeton complet existe en clair : il n'est pas stocké et
 * ne pourra plus être relu.
 */
adminWsRouter.post(
  '/token',
  requireDb,
  asyncHandler(async (req, res) => {
    const client = String(req.body?.client ?? '').trim() || DEFAULT_CLIENT;
    const created = await createKey(client);

    // Qui a généré la clé, pour le journal serveur — sans le jeton.
    console.log(`[api] Nouvelle clé pour « ${created.clientName} » par ${req.actor.name}`);

    res.status(201).json({
      token: created.token,
      updated_at: created.createdAt,
      client: created.clientName,
      message:
        'Copiez ce jeton maintenant : il ne sera plus affiché. ' +
        'L’application appelante l’envoie dans l’en-tête X-API-Key.',
    });
  }),
);

/** DELETE /adminpanel/ws/token/:id — révoque une clé. */
adminWsRouter.delete(
  '/token/:id',
  requireDb,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw badRequest('Identifiant de clé invalide.');

    const revoked = await revokeKey(id);
    if (!revoked) {
      throw Object.assign(new Error('Clé introuvable ou déjà révoquée.'), {
        status: 404,
        code: 'NOT_FOUND',
      });
    }

    console.log(`[api] Clé révoquée pour « ${revoked.clientName} » par ${req.actor.name}`);
    res.json({ id: revoked.id, client: revoked.clientName, revoked_at: revoked.revokedAt });
  }),
);
