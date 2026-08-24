import { Router } from 'express';
import {
  listShipments,
  listOpenShipments,
  getShipmentByTracking,
  listPackagesOfShipment,
  updateStatus,
  countByStatus,
  getStats,
  getLabel,
} from '../db/shipmentsRepository.js';
import {
  listComments,
  addComment,
  deleteComment,
  countByTracking,
  MAX_BODY,
} from '../db/commentsRepository.js';
import { findCreator, findCreators, listActivity } from '../db/activityRepository.js';
import { withAnomalies, summarize } from '../services/anomalies.js';
import { config } from '../config.js';
import { isDbEnabled } from '../db/pool.js';
import { trackByNumber, findMatchingPackage } from '../services/tracking.js';
import { getEvents, latestStatusByTracking } from '../services/quantumView.js';
import { asyncHandler, badRequest } from '../middleware/validate.js';

export const shipmentsRouter = Router();

/** Statuts internes, distincts des libellés UPS. */
const STATUSES = ['created', 'in_transit', 'delivered', 'exception', 'voided'];

/**
 * Garde locale plutôt qu'un `router.use` : les autres routes de ce fichier
 * (suivi, tarifs) fonctionnent sans base et ne doivent pas être bloquées.
 */
function requireDb() {
  if (!isDbEnabled()) {
    throw Object.assign(
      new Error('Les commentaires nécessitent une base PostgreSQL. Renseignez DATABASE_URL.'),
      { status: 503, code: 'DB_NOT_CONFIGURED' },
    );
  }
}

/**
 * Déduit un statut interne à partir du libellé UPS.
 * Les codes UPS varient selon le service : on s'appuie sur le type d'activité
 * quand il est présent, sinon sur le libellé.
 */
function deriveStatus(currentStatus, statusCode) {
  const text = (currentStatus || '').toLowerCase();

  if (statusCode === '011' || /livr|deliver/.test(text)) return 'delivered';
  if (/exception|retard|echec|échec|refus/.test(text)) return 'exception';
  if (/transit|achemin|sortie|charg|scan|collect|pris en charge/.test(text)) return 'in_transit';
  return 'created';
}

/**
 * Actualise un envoi via l'API Tracking et enregistre le nouveau statut.
 * Partagé entre /refresh-status (page affichée) et le repli de /sync.
 */
async function refreshOneViaTracking(trackingNumber) {
  try {
    const tracking = await trackByNumber(trackingNumber);

    // UPS renvoie un colis de démonstration lorsque le numéro n'existe
    // pas : sans ce contrôle, on écrirait en base le statut d'un autre
    // colis. La correspondance (numéro du colis ou alias via
    // l'inquiryNumber de l'envoi) est portée par le service.
    const pkg = findMatchingPackage(tracking.packages, trackingNumber);

    if (!pkg) {
      return {
        trackingNumber,
        ok: false,
        // Distinct d'une panne UPS : le numéro est inconnu et UPS a
        // répondu avec un colis de démonstration.
        error: 'UPS a répondu pour un autre numéro — vérifiez le numéro, statut non modifié',
      };
    }

    const status = deriveStatus(pkg.currentStatus, pkg.currentStatusCode);
    const updated = await updateStatus(trackingNumber, {
      status,
      description: pkg.currentStatus,
      // Date du dernier événement : base du calcul « aucun mouvement ».
      eventDate: pkg.activities[0]?.date || null,
    });

    return { trackingNumber, ok: true, status, description: pkg.currentStatus, shipment: updated };
  } catch (err) {
    return { trackingNumber, ok: false, error: err.message };
  }
}

/** GET /api/shipments — liste paginée avec recherche et filtres */
shipmentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { search, status, from, to } = req.query;

    if (status && status !== 'all' && !STATUSES.includes(status)) {
      throw badRequest(`status invalide. Valeurs acceptées : all, ${STATUSES.join(', ')}`);
    }

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const result = await listShipments({ search, status, from, to, limit, offset });

    // Les anomalies sont calculées à la lecture : les seuils sont
    // configurables et un envoi peut en sortir sans réécriture en base.
    const now = new Date();
    const shipments = result.shipments.map((s) => withAnomalies(s, now));

    const visible =
      req.query.anomaliesOnly === 'true' ? shipments.filter((s) => s.hasAnomaly) : shipments;

    // Auteurs et compteurs de commentaires en deux requêtes, pas deux par
    // ligne. Un échec ici n'empêche pas d'afficher la liste.
    const trackingNumbers = visible.map((s) => s.trackingNumber).filter(Boolean);
    const [creators, commentCounts] = await Promise.all([
      findCreators('shipment', trackingNumbers).catch(() => ({})),
      countByTracking(trackingNumbers).catch(() => ({})),
    ]);

    res.json({
      success: true,
      data: {
        ...result,
        shipments: visible.map((s) => ({
          ...s,
          creator: creators[s.trackingNumber] ?? null,
          commentCount: commentCounts[s.trackingNumber] ?? 0,
        })),
        limit,
        offset,
      },
    });
  }),
);

/**
 * GET /api/shipments/anomalies — envois nécessitant une attention.
 *
 * Analyse tous les envois non terminés, indépendamment de la pagination
 * de la liste principale.
 */
shipmentsRouter.get(
  '/anomalies',
  asyncHandler(async (req, res) => {
    const open = await listOpenShipments(500);
    const now = new Date();

    const analysed = open.map((s) => withAnomalies(s, now));
    const affected = analysed.filter((s) => s.hasAnomaly);

    const type = req.query.type;
    const filtered = type
      ? affected.filter((s) => s.anomalies.some((a) => a.type === type))
      : affected;

    res.json({
      success: true,
      data: {
        summary: summarize(open, now),
        shipments: filtered,
        thresholds: config.anomalies,
      },
    });
  }),
);

/** GET /api/shipments/stats — répartition par statut */
shipmentsRouter.get(
  '/stats',
  asyncHandler(async (req, res) => {
    if (!isDbEnabled()) {
      return res.json({ success: true, data: { counts: {}, dbEnabled: false } });
    }

    const { from, to } = req.query;
    if (from && Number.isNaN(Date.parse(from))) throw badRequest('Paramètre "from" invalide.');
    if (to && Number.isNaN(Date.parse(to))) throw badRequest('Paramètre "to" invalide.');

    // `counts` est conservé : le tableau de bord s'en sert déjà.
    const [counts, stats] = await Promise.all([countByStatus(), getStats({ from, to })]);

    res.json({ success: true, data: { counts, stats, dbEnabled: true } });
  }),
);

/**
 * POST /api/shipments/refresh-status — met à jour les statuts depuis UPS.
 *
 * Les envois déjà livrés ou annulés ne sont pas réinterrogés : leur statut
 * est définitif, et chaque appel consomme du quota UPS.
 */
shipmentsRouter.post(
  '/refresh-status',
  asyncHandler(async (req, res) => {
    const { trackingNumbers } = req.body;

    if (!Array.isArray(trackingNumbers) || trackingNumbers.length === 0) {
      throw badRequest('Le champ "trackingNumbers" doit contenir au moins un numéro.');
    }
    if (trackingNumbers.length > 50) {
      throw badRequest('50 numéros de suivi maximum par appel.');
    }
    // Validé avant tout appel UPS : un élément non-chaîne lèverait un
    // TypeError après avoir consommé du quota, avec un message interne
    // exposé au client.
    if (trackingNumbers.some((t) => typeof t !== 'string' || !t.trim())) {
      throw badRequest('Chaque élément de "trackingNumbers" doit être une chaîne non vide.');
    }

    const results = await Promise.all(trackingNumbers.map(refreshOneViaTracking));

    res.json({ success: true, data: { results } });
  }),
);

/**
 * Codes UPS signifiant « QuantumView inutilisable en l'état » :
 * - 250002 : API non souscrite par l'application (developer.ups.com) ;
 * - 330052 : abonnements Quantum View Data inactifs sur le compte.
 * Dans les deux cas, l'API Tracking reste fonctionnelle : on bascule dessus
 * plutôt que de renvoyer une erreur à l'utilisateur.
 */
const QVD_UNAVAILABLE_CODES = new Set(['250002', '330052']);

function isQvdUnavailable(err) {
  const codes = [err.code, ...(err.upsCodes || [])].filter(Boolean).map(String);
  return codes.some((c) => QVD_UNAVAILABLE_CODES.has(c));
}

/** Nombre maximal d'appels Tracking par synchronisation de repli. */
const TRACKING_FALLBACK_LIMIT = 50;

/**
 * POST /api/shipments/sync — actualise les statuts via QuantumView.
 *
 * Un seul appel UPS rapporte les événements de tous les colis récents,
 * là où /refresh-status interroge le Tracking colis par colis.
 *
 * Contreparties : un abonnement Quantum View Data doit être actif sur le
 * compte, et l'historique ne remonte qu'à environ 14 jours. Tant que ce
 * n'est pas le cas, la route bascule d'elle-même sur l'API Tracking pour
 * les envois ouverts (`mode: 'tracking'` dans la réponse).
 */
shipmentsRouter.post(
  '/sync',
  asyncHandler(async (req, res) => {
    const { subscriptionName, maxPages = 5 } = req.body || {};

    const pages = Math.min(Math.max(Number(maxPages) || 1, 1), 20);
    const allEvents = [];
    let bookmark;
    let pagesRead = 0;

    try {
      // UPS pagine par fichiers : on suit le bookmark jusqu'à épuisement.
      do {
        const page = await getEvents({ subscriptionName, bookmark });
        allEvents.push(...page.events);
        bookmark = page.bookmark;
        pagesRead += 1;
      } while (bookmark && pagesRead < pages);
    } catch (err) {
      if (!isQvdUnavailable(err)) throw err;

      // Repli : Tracking colis par colis sur les envois encore ouverts.
      // Plus coûteux en quota (un appel par colis), donc plafonné.
      const open = await listOpenShipments(TRACKING_FALLBACK_LIMIT + 1);
      const numbers = open
        .map((s) => s.trackingNumber)
        .filter(Boolean)
        .slice(0, TRACKING_FALLBACK_LIMIT);

      const results = await Promise.all(numbers.map(refreshOneViaTracking));
      const updated = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);

      res.json({
        success: true,
        data: {
          mode: 'tracking',
          fallbackReason: err.message,
          checked: numbers.length,
          updated: updated.length,
          failed: failed.length,
          hasMore: open.length > TRACKING_FALLBACK_LIMIT,
          details: updated.map(({ trackingNumber, status, description }) => ({
            trackingNumber,
            status,
            description,
          })),
          failures: failed.map(({ trackingNumber, error }) => ({ trackingNumber, error })),
          // Champs QuantumView, neutres, pour un front pas encore à jour.
          eventsRead: 0,
          pagesRead: 0,
          ignored: 0,
        },
      });
      return;
    }

    const latest = latestStatusByTracking(allEvents);
    const updated = [];
    const ignored = [];

    for (const [trackingNumber, event] of latest) {
      // Seuls les colis présents dans l'historique local sont mis à jour :
      // QuantumView renvoie aussi des envois créés hors de cette application.
      const shipment = await updateStatus(trackingNumber, {
        status: event.status,
        description: event.description,
        eventDate: event.date,
      });

      if (shipment) {
        updated.push({ trackingNumber, status: event.status, description: event.description });
      } else {
        ignored.push(trackingNumber);
      }
    }

    res.json({
      success: true,
      data: {
        mode: 'quantumview',
        eventsRead: allEvents.length,
        pagesRead,
        hasMore: Boolean(bookmark),
        updated: updated.length,
        ignored: ignored.length,
        details: updated,
      },
    });
  }),
);

/** GET /api/shipments/:trackingNumber/label — récupère l'étiquette stockée */
shipmentsRouter.get(
  '/:trackingNumber/label',
  asyncHandler(async (req, res) => {
    const label = await getLabel(req.params.trackingNumber);
    if (!label) {
      throw Object.assign(new Error('Aucune étiquette enregistrée pour ce colis.'), {
        status: 404,
        code: 'LABEL_NOT_FOUND',
      });
    }
    res.json({ success: true, data: label });
  }),
);

/**
 * GET /api/shipments/:trackingNumber/comments — fil de discussion de l'envoi
 *
 * Déclaré avant `/:trackingNumber` : Express retient la première route qui
 * correspond, et le motif générique capterait « .../comments » sinon.
 */
shipmentsRouter.get(
  '/:trackingNumber/comments',
  asyncHandler(async (req, res) => {
    requireDb();
    const comments = await listComments(req.params.trackingNumber);
    res.json({ success: true, data: { comments, count: comments.length } });
  }),
);

/** POST /api/shipments/:trackingNumber/comments — ajoute un commentaire */
shipmentsRouter.post(
  '/:trackingNumber/comments',
  asyncHandler(async (req, res) => {
    requireDb();

    const body = String(req.body?.body ?? '').trim();
    if (!body) throw badRequest('Le commentaire ne peut pas être vide.');
    if (body.length > MAX_BODY) {
      throw badRequest(`Le commentaire dépasse ${MAX_BODY} caractères.`);
    }

    const comment = await addComment({
      trackingNumber: req.params.trackingNumber,
      body,
      actor: req.actor,
    });

    res.status(201).json({ success: true, data: comment });
  }),
);

/** DELETE /api/shipments/:trackingNumber/comments/:id — retire son commentaire */
shipmentsRouter.delete(
  '/:trackingNumber/comments/:id',
  asyncHandler(async (req, res) => {
    requireDb();

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw badRequest('Identifiant de commentaire invalide.');

    const outcome = await deleteComment(id, req.actor?.id ?? null);

    if (outcome === 'not_found') {
      throw Object.assign(new Error('Commentaire introuvable.'), {
        status: 404,
        code: 'COMMENT_NOT_FOUND',
      });
    }
    if (outcome === 'forbidden') {
      throw Object.assign(
        new Error('Un commentaire ne peut être supprimé que par son auteur.'),
        { status: 403, code: 'COMMENT_FORBIDDEN' },
      );
    }

    res.json({ success: true, data: { id } });
  }),
);

/**
 * GET /api/shipments/:trackingNumber — détail d'un envoi
 *
 * Rassemble ce que la page dédiée affiche : l'envoi, son auteur (lu dans le
 * journal, la table shipments n'en portant pas), le journal des actions le
 * concernant et le fil de commentaires.
 */
shipmentsRouter.get(
  '/:trackingNumber',
  asyncHandler(async (req, res) => {
    const shipment = await getShipmentByTracking(req.params.trackingNumber);
    if (!shipment) {
      throw Object.assign(new Error('Envoi introuvable dans l’historique.'), {
        status: 404,
        code: 'SHIPMENT_NOT_FOUND',
      });
    }

    // Le détail reste consultable même si une de ces lectures échoue : elles
    // enrichissent la page, elles ne la conditionnent pas.
    const [creator, activity, comments, packages] = await Promise.all([
      findCreator('shipment', shipment.trackingNumber).catch(() => null),
      listActivity({ entityType: 'shipment', entityId: shipment.trackingNumber, limit: 100 })
        .then((r) => r.entries)
        .catch(() => []),
      listComments(shipment.trackingNumber).catch(() => []),
      // Les colis frères de la même expédition : sans eux, un envoi de trois
      // colis n'en montrerait qu'un.
      listPackagesOfShipment(shipment.localShipmentId).catch(() => [shipment]),
    ]);

    res.json({ success: true, data: { shipment, creator, activity, comments, packages } });
  }),
);
