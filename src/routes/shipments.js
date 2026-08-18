import { Router } from 'express';
import {
  listShipments,
  listOpenShipments,
  getShipmentByTracking,
  updateStatus,
  countByStatus,
  getLabel,
} from '../db/shipmentsRepository.js';
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

    res.json({
      success: true,
      data: {
        ...result,
        shipments: req.query.anomaliesOnly === 'true'
          ? shipments.filter((s) => s.hasAnomaly)
          : shipments,
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
    const counts = await countByStatus();
    res.json({ success: true, data: { counts, dbEnabled: isDbEnabled() } });
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

    const results = await Promise.all(
      trackingNumbers.map(async (trackingNumber) => {
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
      }),
    );

    res.json({ success: true, data: { results } });
  }),
);

/**
 * POST /api/shipments/sync — actualise les statuts via QuantumView.
 *
 * Un seul appel UPS rapporte les événements de tous les colis récents,
 * là où /refresh-status interroge le Tracking colis par colis.
 *
 * Contreparties : un abonnement Quantum View doit être configuré sur le
 * compte, et l'historique ne remonte qu'à environ 14 jours.
 */
shipmentsRouter.post(
  '/sync',
  asyncHandler(async (req, res) => {
    const { subscriptionName, maxPages = 5 } = req.body || {};

    const pages = Math.min(Math.max(Number(maxPages) || 1, 1), 20);
    const allEvents = [];
    let bookmark;
    let pagesRead = 0;

    // UPS pagine par fichiers : on suit le bookmark jusqu'à épuisement.
    do {
      const page = await getEvents({ subscriptionName, bookmark });
      allEvents.push(...page.events);
      bookmark = page.bookmark;
      pagesRead += 1;
    } while (bookmark && pagesRead < pages);

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

/** GET /api/shipments/:trackingNumber — détail d'un envoi */
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
    res.json({ success: true, data: shipment });
  }),
);
