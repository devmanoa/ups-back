import { config } from '../config.js';

/**
 * Détection d'anomalies sur les envois enregistrés.
 *
 * Le calcul est fait à la lecture plutôt que stocké : les seuils sont
 * configurables et un envoi peut sortir d'anomalie sans qu'on ait à
 * réécrire la base.
 */

export const ANOMALY_TYPES = {
  DELAYED: 'delayed',
  EXCEPTION: 'exception',
  STALLED: 'stalled',
  NEVER_PICKED_UP: 'never_picked_up',
};

/** Sévérité croissante : sert à trier et à choisir l'anomalie principale. */
const SEVERITY = {
  [ANOMALY_TYPES.NEVER_PICKED_UP]: 1,
  [ANOMALY_TYPES.STALLED]: 2,
  [ANOMALY_TYPES.DELAYED]: 3,
  [ANOMALY_TYPES.EXCEPTION]: 4,
};

/** Nombre de jours entiers écoulés depuis une date. */
function daysSince(date, now) {
  if (!date) return null;
  const then = new Date(date);
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((now.getTime() - then.getTime()) / 86_400_000);
}

/**
 * Analyse un envoi et retourne ses anomalies.
 *
 * @param {object} shipment envoi normalisé issu du dépôt
 * @param {Date} [now] instant de référence, injectable pour les tests
 */
export function detectAnomalies(shipment, now = new Date()) {
  // Un envoi livré ou annulé est clos : plus rien à signaler.
  if (shipment.status === 'delivered' || shipment.status === 'voided') return [];

  const anomalies = [];
  const { stalledDays, neverPickedUpDays, fallbackDelayDays } = config.anomalies;

  // 1. Incident signalé par UPS — le plus fiable, il vient du transporteur.
  if (shipment.status === 'exception') {
    anomalies.push({
      type: ANOMALY_TYPES.EXCEPTION,
      label: 'Incident signalé par UPS',
      detail: shipment.statusDescription || 'Consultez le suivi pour le détail.',
    });
  }

  // 2. Étiquette créée mais colis jamais pris en charge.
  const ageDays = daysSince(shipment.createdAt, now);
  if (!shipment.pickedUpAt && shipment.status === 'created' && ageDays !== null && ageDays >= neverPickedUpDays) {
    anomalies.push({
      type: ANOMALY_TYPES.NEVER_PICKED_UP,
      label: 'Jamais pris en charge',
      detail: `Étiquette créée il y a ${ageDays} jour(s), aucun scan UPS.`,
    });
  }

  // 3. Retard : date prévue dépassée, ou repli sur un seuil d'âge.
  if (shipment.expectedDelivery) {
    const lateDays = daysSince(shipment.expectedDelivery, now);
    if (lateDays !== null && lateDays > 0) {
      anomalies.push({
        type: ANOMALY_TYPES.DELAYED,
        label: 'Livraison en retard',
        detail: `Livraison prévue le ${shipment.expectedDelivery}, dépassée de ${lateDays} jour(s).`,
      });
    }
  } else if (ageDays !== null && ageDays >= fallbackDelayDays) {
    // Sans engagement UPS connu, on ne parle pas de « retard » mais de durée
    // inhabituelle : la nuance évite les fausses alertes.
    anomalies.push({
      type: ANOMALY_TYPES.DELAYED,
      label: 'Durée inhabituelle',
      detail: `En cours depuis ${ageDays} jour(s), sans date de livraison connue.`,
    });
  }

  // 4. Colis en transit mais immobile.
  const sinceLastEvent = daysSince(shipment.lastEventAt, now);
  if (shipment.status === 'in_transit' && sinceLastEvent !== null && sinceLastEvent >= stalledDays) {
    anomalies.push({
      type: ANOMALY_TYPES.STALLED,
      label: 'Aucun mouvement',
      detail: `Dernier événement il y a ${sinceLastEvent} jour(s).`,
    });
  }

  return anomalies.sort((a, b) => SEVERITY[b.type] - SEVERITY[a.type]);
}

/** Enrichit un envoi de ses anomalies et de l'anomalie principale. */
export function withAnomalies(shipment, now = new Date()) {
  const anomalies = detectAnomalies(shipment, now);
  return {
    ...shipment,
    anomalies,
    hasAnomaly: anomalies.length > 0,
    // La plus sévère : elle porte le badge affiché dans la liste.
    primaryAnomaly: anomalies[0] || null,
  };
}

/** Répartition des anomalies par type, pour le tableau de bord. */
export function summarize(shipments, now = new Date()) {
  const counts = {
    [ANOMALY_TYPES.DELAYED]: 0,
    [ANOMALY_TYPES.EXCEPTION]: 0,
    [ANOMALY_TYPES.STALLED]: 0,
    [ANOMALY_TYPES.NEVER_PICKED_UP]: 0,
  };
  let affected = 0;

  for (const shipment of shipments) {
    const anomalies = detectAnomalies(shipment, now);
    if (anomalies.length > 0) affected += 1;
    // Un envoi peut cumuler plusieurs anomalies : chacune est comptée.
    for (const a of anomalies) counts[a.type] += 1;
  }

  return { counts, affected, total: shipments.length };
}
