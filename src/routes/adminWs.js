import { Router } from 'express';
import { config } from '../config.js';

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
 * GET /adminpanel/ws/token — état de la clé, jamais sa valeur.
 *
 * Les clés vivent dans la variable d'environnement `API_KEYS` : elles ne se
 * génèrent pas depuis l'admin, et les renvoyer ici les exposerait à qui
 * atteint cette route, dépourvue d'authentification propre.
 */
adminWsRouter.get('/token', (_req, res) => {
  res.json({
    token: null,
    updated_at: null,
    configured: config.apiKeys.length > 0,
    clients: config.apiKeys.map((entry) => entry.name),
    message:
      config.apiKeys.length > 0
        ? `${config.apiKeys.length} clé(s) configurée(s) dans API_KEYS. Leur valeur n’est pas exposée.`
        : 'Aucune clé. Renseignez API_KEYS au format « nom:clé » puis redéployez.',
  });
});

/**
 * POST /adminpanel/ws/token — refuse la génération.
 *
 * Une clé écrite ici ne survivrait pas au redémarrage du conteneur, la
 * configuration venant de l'environnement. Mieux vaut un refus explicite
 * qu'une clé qui semble créée et cesse de fonctionner au prochain déploiement.
 */
adminWsRouter.post('/token', (_req, res) => {
  res.status(501).json({
    error: 'Non disponible',
    message:
      'Les clés de cette application vivent dans la variable API_KEYS. ' +
      'Générez-en une avec « openssl rand -hex 32 », ajoutez-la au format ' +
      '« nom:clé » puis redéployez.',
  });
});
