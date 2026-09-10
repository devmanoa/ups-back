import { Router } from 'express';
import { config } from '../config.js';
import { isDbEnabled } from '../db/pool.js';
import { latestKey, listKeys, createKey, revokeKey } from '../db/apiKeysRepository.js';

/**
 * Description de l'API machine pour l'onglet « WS API » de l'admin panel.
 *
 * L'admin appelle `/adminpanel/ws/endpoints` et `/adminpanel/ws/token` au
 * travers de son proxy, qui relaie le jeton d'un administrateur : ces routes
 * n'ont pas d'authentification propre, et ne renvoient donc que la
 * description publique du contrat — jamais la clé elle-même.
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

/** GET /adminpanel/ws/endpoints — contrat de l'API machine. */
adminWsRouter.get('/endpoints', (_req, res) => {
  res.json({ data: ENDPOINTS, count: ENDPOINTS.length });
});

/**
 * Nom d'application par défaut à la génération.
 *
 * L'admin panel poste sans corps : il faut donc un nom, sinon la clé serait
 * anonyme dans le journal. Renommable ensuite via le corps de la requête.
 */
const DEFAULT_CLIENT = 'adminpanel';

/**
 * GET /adminpanel/ws/token — la clé courante.
 *
 * Renvoie un aperçu, pas le jeton complet : cette route n'a pas
 * d'authentification propre, et l'admin y accède par son proxy. Le jeton
 * entier n'apparaît qu'une fois, à sa création.
 */
adminWsRouter.get('/token', async (_req, res, next) => {
  try {
    const fromEnv = config.apiKeys.map((entry) => entry.name);

    if (!isDbEnabled()) {
      return res.json({
        token: null,
        updated_at: null,
        configured: fromEnv.length > 0,
        clients: fromEnv,
        message: fromEnv.length
          ? `${fromEnv.length} clé(s) dans API_KEYS. Leur valeur n’est pas exposée.`
          : 'Base indisponible et API_KEYS vide : aucune clé utilisable.',
      });
    }

    const [current, keys] = await Promise.all([latestKey(), listKeys()]);

    res.json({
      // `preview` et non le jeton : l'admin affiche ce champ tel quel.
      token: current?.preview ?? null,
      updated_at: current?.createdAt ?? null,
      configured: Boolean(current) || fromEnv.length > 0,
      clients: [...keys.map((k) => k.clientName), ...fromEnv],
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
        : 'Aucune clé. Cliquez sur « Générer » pour en créer une.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /adminpanel/ws/token — crée une clé.
 *
 * C'est le seul moment où le jeton complet est renvoyé : il n'est plus
 * lisible ensuite, ni en base pour l'admin, ni par cette route.
 */
adminWsRouter.post('/token', async (req, res, next) => {
  try {
    if (!isDbEnabled()) {
      throw Object.assign(
        new Error(
          'Base de données requise pour générer une clé. Renseignez DATABASE_URL, ou utilisez la variable API_KEYS.',
        ),
        { status: 503, code: 'DB_NOT_CONFIGURED' },
      );
    }

    const client = String(req.body?.client ?? '').trim() || DEFAULT_CLIENT;
    const created = await createKey(client);

    // Une clé créée remplace la précédente du même appelant : la trace en
    // dit assez pour retrouver qui l'a fait, sans exposer le jeton.
    console.log(`[api] Nouvelle clé pour « ${created.clientName} »`);

    res.status(201).json({
      token: created.token,
      updated_at: created.createdAt,
      client: created.clientName,
      message:
        'Copiez ce jeton maintenant : il ne sera plus affiché. ' +
        'L’application appelante l’envoie dans l’en-tête X-API-Key.',
    });
  } catch (err) {
    next(err);
  }
});

/** DELETE /adminpanel/ws/token/:id — révoque une clé. */
adminWsRouter.delete('/token/:id', async (req, res, next) => {
  try {
    if (!isDbEnabled()) {
      throw Object.assign(new Error('Base de données indisponible.'), { status: 503 });
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      throw Object.assign(new Error('Identifiant invalide.'), { status: 400 });
    }

    const revoked = await revokeKey(id);
    if (!revoked) {
      throw Object.assign(new Error('Clé introuvable ou déjà révoquée.'), { status: 404 });
    }

    console.log(`[api] Clé révoquée pour « ${revoked.clientName} »`);
    res.json({ id: revoked.id, client: revoked.clientName, revoked_at: revoked.revokedAt });
  } catch (err) {
    next(err);
  }
});
