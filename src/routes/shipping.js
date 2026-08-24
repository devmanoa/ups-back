import { Router } from 'express';
import { createShipment, voidShipment, LABEL_FORMATS } from '../services/shipping.js';
import { SERVICE_CODES } from '../services/rating.js';
import { getTransitTimes } from '../services/timeInTransit.js';
import { saveShipment, markVoided } from '../db/shipmentsRepository.js';
import { findByLabel } from '../db/packageTypesRepository.js';
import { isDbEnabled } from '../db/pool.js';
import { asyncHandler, badRequest, requireFields, validatePackages } from '../middleware/validate.js';
import { log, ACTIONS, describeRecipient } from '../services/activity.js';

export const shippingRouter = Router();

/** POST /api/shipping — crée une expédition et son étiquette */
shippingRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const {
      shipTo,
      shipFrom,
      packages,
      serviceCode,
      description,
      labelFormat = 'GIF',
      paymentAccountNumber,
      accessPointLocationId,
      // Antenne d'origine, quand la page a été ouverte depuis un lien
      // Antennes. Purement informatif : rien n'est envoyé à UPS.
      antenne,
    } = req.body;

    if (!shipTo) throw badRequest('Le champ "shipTo" est obligatoire.');
    requireFields(shipTo, ['name', 'addressLine1', 'city', 'postalCode', 'country'], 'champ shipTo');
    validatePackages(packages);

    if (!LABEL_FORMATS[labelFormat]) {
      throw badRequest(
        `labelFormat invalide. Valeurs acceptées: ${Object.keys(LABEL_FORMATS).join(', ')}`,
      );
    }

    const result = await createShipment({
      shipTo,
      shipFrom,
      packages,
      serviceCode,
      description,
      labelFormat,
      paymentAccountNumber,
      accessPointLocationId,
    });

    // L'expédition existe et est facturée chez UPS : un échec d'enregistrement
    // ne doit jamais empêcher le client de récupérer son étiquette.
    const saved = await persistShipment({
      shipment: result,
      shipTo,
      serviceCode,
      description,
      labelFormat,
      accessPointLocationId,
      antenne,
    });

    const tracking = result.packages?.[0]?.trackingNumber;
    await log(req, {
      action: ACTIONS.SHIPMENT_CREATE,
      entityType: 'shipment',
      entityId: tracking || result.shipmentIdentificationNumber,
      summary: `Étiquette ${tracking || result.shipmentIdentificationNumber} → ${describeRecipient(shipTo)}`,
      metadata: {
        shipmentId: result.shipmentIdentificationNumber,
        packageCount: result.packages?.length ?? 1,
        serviceCode,
        totalCharges: result.totalCharges ?? null,
        currency: result.currency ?? null,
      },
    });

    res.status(201).json({ success: true, data: { ...result, saved } });
  }),
);

/**
 * Enregistre une expédition sans jamais propager d'erreur.
 * Retourne false si l'historique n'a pas pu être mis à jour.
 */
async function persistShipment(payload) {
  if (!isDbEnabled()) return false;
  try {
    const estimate = await estimateDelivery(payload);
    await saveShipment({
      ...payload,
      serviceName: SERVICE_CODES[payload.serviceCode] || null,
      expectedDelivery: estimate.expectedDelivery,
      transitDays: estimate.transitDays,
    });
    return true;
  } catch (err) {
    console.error('[shipments] Enregistrement impossible :', err.message);
    return false;
  }
}

/**
 * Interroge Time In Transit pour connaître la date de livraison promise.
 * Elle sert de référence à la détection de retard. Un échec est sans
 * conséquence : l'envoi est enregistré sans date, et la détection retombe
 * alors sur un seuil d'ancienneté.
 */
async function estimateDelivery({ shipTo, serviceCode, shipment }) {
  try {
    const weight = Number(shipment?.billingWeight?.split(' ')[0]) || 1;
    const { services } = await getTransitTimes({ shipTo, weight });

    const match =
      services.find((s) => s.serviceCode === serviceCode) ||
      services.find((s) => s.deliveryDate);

    return {
      expectedDelivery: match?.deliveryDate || null,
      transitDays: match?.businessDaysInTransit ?? null,
    };
  } catch (err) {
    console.warn('[shipments] Délai de livraison indisponible :', err.message);
    return { expectedDelivery: null, transitDays: null };
  }
}

/**
 * POST /api/shipping/bulk — crée plusieurs expéditions en une passe.
 *
 * Les envois sont traités séquentiellement : chacun est facturé par UPS, et
 * un échec sur l'un ne doit pas empêcher les suivants ni annuler les
 * précédents. La réponse détaille le résultat ligne par ligne.
 */
shippingRouter.post(
  '/bulk',
  asyncHandler(async (req, res) => {
    const { shipments, labelFormat = 'GIF', serviceCode, description } = req.body;

    if (!Array.isArray(shipments) || shipments.length === 0) {
      throw badRequest('Le champ "shipments" doit contenir au moins une expédition.');
    }
    if (shipments.length > 50) {
      throw badRequest('50 expéditions maximum par envoi groupé.');
    }
    if (!LABEL_FORMATS[labelFormat]) {
      throw badRequest(
        `labelFormat invalide. Valeurs acceptées: ${Object.keys(LABEL_FORMATS).join(', ')}`,
      );
    }

    // Une ligne peut nommer un type de colis au lieu de répéter son poids :
    // résolu ici, avant la validation, pour que l'absence de poids soit
    // signalée par le type introuvable plutôt que par un champ manquant.
    await resolvePackageTypes(shipments);

    // Validation complète avant le premier appel : mieux vaut tout refuser
    // que créer la moitié des étiquettes puis échouer.
    shipments.forEach((s, i) => {
      if (!s?.shipTo) throw badRequest(`shipments[${i}].shipTo est obligatoire.`);
      const missing = ['name', 'addressLine1', 'city', 'postalCode', 'country'].filter(
        (f) => !s.shipTo[f],
      );
      if (missing.length) {
        throw badRequest(`shipments[${i}].shipTo — champs manquants : ${missing.join(', ')}`);
      }
      try {
        validatePackages(s.packages);
      } catch (err) {
        throw badRequest(`shipments[${i}] — ${err.message}`);
      }
    });

    const batchId = `batch-${Date.now()}`;
    const results = [];

    for (const [index, entry] of shipments.entries()) {
      const entryService = entry.serviceCode || serviceCode || '11';
      try {
        const created = await createShipment({
          shipTo: entry.shipTo,
          packages: entry.packages,
          serviceCode: entryService,
          description: entry.description || description,
          labelFormat,
          accessPointLocationId: entry.accessPointLocationId,
        });

        await persistShipment({
          shipment: created,
          shipTo: entry.shipTo,
          serviceCode: entryService,
          description: entry.description || description,
          labelFormat,
          accessPointLocationId: entry.accessPointLocationId,
          batchId,
        });

        results.push({ index, ok: true, recipient: entry.shipTo.name, shipment: created });
      } catch (err) {
        results.push({
          index,
          ok: false,
          recipient: entry.shipTo?.name,
          error: err.message,
          upsCodes: err.upsCodes || [],
        });
      }
    }

    const created = results.filter((r) => r.ok).length;
    const failed = results.length - created;

    await log(req, {
      action: ACTIONS.BULK_CREATE,
      entityType: 'batch',
      entityId: batchId,
      summary:
        `Envoi groupé : ${created} étiquette${created > 1 ? 's' : ''} créée${created > 1 ? 's' : ''}` +
        (failed > 0 ? `, ${failed} en échec` : ''),
      metadata: { batchId, created, failed, total: results.length },
    });

    res.status(created > 0 ? 201 : 502).json({
      success: created > 0,
      data: { batchId, created, failed, results },
    });
  }),
);

/**
 * Remplace les `packageType` nommés par les caractéristiques du catalogue.
 *
 * Les valeurs déjà présentes sur la ligne l'emportent : un poids explicite
 * dans le CSV reste prioritaire sur celui du type, ce qui permet de traiter
 * un cas particulier sans créer un type dédié.
 *
 * Sans base, la mention est ignorée : les lignes portant leur propre poids
 * restent valides.
 */
async function resolvePackageTypes(shipments) {
  if (!isDbEnabled()) return;

  const cache = new Map();

  for (const [index, entry] of shipments.entries()) {
    for (const pkg of entry?.packages ?? []) {
      const label = pkg?.packageType;
      if (!label) continue;

      const key = String(label).toLowerCase();
      if (!cache.has(key)) cache.set(key, await findByLabel(String(label)));

      const type = cache.get(key);
      if (!type) {
        throw badRequest(
          `shipments[${index}] — type de colis « ${label} » introuvable dans le catalogue.`,
        );
      }

      pkg.weight = pkg.weight || type.weight;
      pkg.length = pkg.length || type.length || undefined;
      pkg.width = pkg.width || type.width || undefined;
      pkg.height = pkg.height || type.height || undefined;
      pkg.description = pkg.description || type.description || undefined;
      pkg.packagingType = pkg.packagingType || type.packagingType;
      pkg.reference = pkg.reference || type.reference || undefined;

      delete pkg.packageType;
    }
  }
}

/** DELETE /api/shipping/:shipmentId — annule une expédition */
shippingRouter.delete(
  '/:shipmentId',
  asyncHandler(async (req, res) => {
    const trackingNumbers = req.query.trackingNumbers
      ? String(req.query.trackingNumbers).split(',').map((t) => t.trim()).filter(Boolean)
      : [];

    const result = await voidShipment(req.params.shipmentId, trackingNumbers);

    // Reflète l'annulation dans l'historique, sans bloquer la réponse.
    if (result.success && isDbEnabled()) {
      try {
        await markVoided(req.params.shipmentId);
      } catch (err) {
        console.error('[shipments] Mise à jour du statut annulé impossible :', err.message);
      }
    }

    if (result.success) {
      await log(req, {
        action: ACTIONS.SHIPMENT_VOID,
        entityType: 'shipment',
        entityId: req.params.shipmentId,
        summary: `Expédition ${req.params.shipmentId} annulée`,
        metadata: { trackingNumbers },
      });
    }

    res.json({ success: result.success, data: result });
  }),
);
