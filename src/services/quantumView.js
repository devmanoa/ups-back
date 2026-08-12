import { API_VERSIONS } from '../config.js';
import { upsFetch } from './upsClient.js';

const V = API_VERSIONS.quantumView;

/**
 * QuantumView : flux d'événements d'expédition.
 *
 * Contrairement au Tracking, un seul appel rapporte les événements de tous
 * les colis récents — bien plus économe pour actualiser une liste entière.
 *
 * Limites imposées par UPS :
 * - un abonnement doit être configuré sur le compte (Quantum View Manage) ;
 * - les données ne remontent qu'à environ 14 jours ;
 * - la lecture se fait par fichiers, paginés via un Bookmark.
 */

/** Convertit une date UPS (YYYYMMDD) et une heure (HHmmss) en ISO 8601. */
function toIso(date, time) {
  if (!date || date.length !== 8) return null;
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  if (!time || time.length < 6) return iso;
  return `${iso}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
}

/** UPS renvoie tantôt un objet, tantôt un tableau, selon le nombre d'éléments. */
function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Récupère les événements non lus.
 *
 * @param {object} params
 * @param {string} [params.subscriptionName] nom de l'abonnement Quantum View
 * @param {string} [params.bookmark] jeton de pagination renvoyé par l'appel précédent
 */
export async function getEvents({ subscriptionName, bookmark } = {}) {
  const body = {
    QuantumViewRequest: {
      Request: {
        RequestAction: 'QVEvents',
        TransactionReference: { CustomerContext: 'ups-backend quantumview' },
      },
      // Sans nom d'abonnement, UPS renvoie les événements de tous les
      // abonnements actifs du compte.
      ...(subscriptionName ? { SubscriptionRequest: [{ Name: subscriptionName }] } : {}),
      ...(bookmark ? { Bookmark: bookmark } : {}),
    },
  };

  const data = await upsFetch(`/quantumview/${V}/events`, { method: 'POST', body });
  return normalizeEvents(data);
}

/**
 * Aplatit la réponse en une liste d'événements par numéro de suivi.
 *
 * Quatre types d'événements existent, du plus précoce au plus tardif :
 * Manifest (étiquette créée), Origin (pris en charge), Exception (incident),
 * Delivery (livré).
 */
function normalizeEvents(data) {
  const response = data?.QuantumViewResponse || {};
  const events = [];

  for (const subscription of asArray(response.QuantumViewEvents?.SubscriptionEvents)) {
    const subscriptionName = subscription.Name || '';

    for (const file of asArray(subscription.SubscriptionFile)) {
      // Manifest : l'étiquette a été créée, le colis n'est pas encore pris en charge.
      for (const manifest of asArray(file.Manifest)) {
        for (const pkg of asArray(manifest.Package)) {
          for (const tracking of asArray(pkg.TrackingNumber)) {
            events.push({
              trackingNumber: tracking,
              type: 'manifest',
              status: 'created',
              description: 'Étiquette créée',
              date: toIso(manifest.PickupDate),
              subscriptionName,
            });
          }
        }
      }

      // Origin : le colis a été scanné au départ.
      for (const origin of asArray(file.Origin)) {
        for (const tracking of asArray(origin.TrackingNumber)) {
          events.push({
            trackingNumber: tracking,
            type: 'origin',
            status: 'in_transit',
            description: 'Pris en charge par UPS',
            date: toIso(origin.Date, origin.Time),
            subscriptionName,
          });
        }
      }

      // Exception : incident d'acheminement.
      for (const exception of asArray(file.Exception)) {
        for (const tracking of asArray(exception.TrackingNumber)) {
          events.push({
            trackingNumber: tracking,
            type: 'exception',
            status: 'exception',
            description:
              exception.StatusDescription || exception.Resolution?.Description || 'Incident',
            date: toIso(exception.Date, exception.Time),
            subscriptionName,
          });
        }
      }

      // Delivery : colis livré.
      for (const delivery of asArray(file.Delivery)) {
        for (const tracking of asArray(delivery.TrackingNumber)) {
          events.push({
            trackingNumber: tracking,
            type: 'delivery',
            status: 'delivered',
            description: delivery.DeliveryLocation?.Description
              ? `Livré — ${delivery.DeliveryLocation.Description}`
              : 'Livré',
            date: toIso(delivery.Date, delivery.Time),
            subscriptionName,
          });
        }
      }
    }
  }

  return {
    events,
    // Présent tant qu'il reste des fichiers à lire : à repasser au prochain appel.
    bookmark: response.Bookmark || null,
    raw: data,
  };
}

/** Priorité des statuts : un événement plus avancé ne doit jamais être écrasé. */
const STATUS_RANK = { created: 0, in_transit: 1, exception: 2, delivered: 3 };

/**
 * Réduit les événements à un statut par colis, en gardant le plus avancé.
 * Les événements n'arrivent pas forcément dans l'ordre chronologique.
 */
export function latestStatusByTracking(events) {
  const byTracking = new Map();

  for (const event of events) {
    const current = byTracking.get(event.trackingNumber);
    if (!current || STATUS_RANK[event.status] >= STATUS_RANK[current.status]) {
      byTracking.set(event.trackingNumber, event);
    }
  }

  return byTracking;
}
