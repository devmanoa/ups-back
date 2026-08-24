import { record } from '../db/activityRepository.js';
import { isDbEnabled } from '../db/pool.js';

/**
 * Journalisation des actions applicatives.
 *
 * Règle absolue : **une écriture de journal ne doit jamais faire échouer
 * l'action qu'elle décrit.** Une étiquette créée est déjà facturée par UPS ;
 * perdre la trace vaut mieux que perdre l'étiquette. Toutes les erreurs sont
 * donc avalées et journalisées en console.
 */

/** Actions connues. Le préfixe sert aussi de filtre côté client. */
export const ACTIONS = {
  SHIPMENT_CREATE: 'shipment.create',
  SHIPMENT_VOID: 'shipment.void',
  SHIPMENT_SYNC: 'shipment.sync',
  BULK_CREATE: 'bulk.create',
  ADDRESS_CREATE: 'address.create',
  ADDRESS_UPDATE: 'address.update',
  ADDRESS_ARCHIVE: 'address.archive',
  ADDRESS_RESTORE: 'address.restore',
  ADDRESS_DELETE: 'address.delete',
  GROUP_CREATE: 'group.create',
  GROUP_UPDATE: 'group.update',
  GROUP_DELETE: 'group.delete',
  PICKUP_CREATE: 'pickup.create',
  PICKUP_CANCEL: 'pickup.cancel',
};

/**
 * Enregistre une action. Ne lève jamais.
 * `req` porte l'auteur attaché par le middleware d'authentification.
 */
export async function log(req, { action, entityType, entityId, summary, metadata }) {
  if (!isDbEnabled()) return;

  try {
    await record({
      actor: req?.actor ?? null,
      action,
      entityType,
      entityId,
      summary,
      metadata,
    });
  } catch (err) {
    console.error(`[activity] Journalisation impossible (${action}) :`, err.message);
  }
}

/** Résumé lisible d'une adresse, pour les entrées liées aux envois. */
export function describeRecipient(shipTo) {
  return [shipTo?.name, shipTo?.city].filter(Boolean).join(', ') || 'destinataire inconnu';
}
