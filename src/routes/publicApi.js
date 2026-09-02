import { Router } from 'express';
import { createShipment, voidShipment, LABEL_FORMATS } from '../services/shipping.js';
import { SERVICE_CODES } from '../services/rating.js';
import { getTransitTimes } from '../services/timeInTransit.js';
import {
  saveShipment,
  markVoided,
  getShipmentByTracking,
  listPackagesOfShipment,
  getLabel,
  listLabelsOfShipment,
} from '../db/shipmentsRepository.js';
import { getBatch } from '../db/batchesRepository.js';
import { findByLabel } from '../db/packageTypesRepository.js';
import { isDbEnabled } from '../db/pool.js';
import { requireApiKey } from '../middleware/apiKey.js';
import { asyncHandler, badRequest, requireFields, validatePackages } from '../middleware/validate.js';
import { log, ACTIONS, describeRecipient } from '../services/activity.js';

/**
 * API machine — `/api/v1`.
 *
 * Destinée aux autres applications, qui pilotent cette application-ci comme
 * un service d'expédition : elles créent des étiquettes, les récupèrent et
 * les annulent sans passer par l'interface.
 *
 * Deux principes la distinguent des routes internes :
 *
 * 1. **Clé d'API obligatoire.** Les routes internes tolèrent l'absence
 *    d'identité ; ici la moindre requête engage une facturation UPS.
 * 2. **Contrat figé.** Le préfixe `v1` existe pour que l'interface puisse
 *    évoluer sans casser l'application appelante, qu'on ne redéploie pas au
 *    même rythme.
 *
 * Les réponses ne renvoient que ce dont l'appelant a besoin : la forme
 * interne d'un envoi porte des champs (identifiants de lot, anomalies
 * calculées) qui deviendraient un contrat implicite si on les exposait.
 */
export const publicApiRouter = Router();

// Appliquée au routeur entier : une route ajoutée plus tard hérite de la
// protection au lieu de l'oublier.
publicApiRouter.use(requireApiKey);

/** Nombre maximal d'expéditions dans une commande. */
const MAX_BATCH = 50;

/**
 * Forme publique d'une expédition créée.
 *
 * `labelUrl` est relative : l'appelant la préfixe de sa propre base, et
 * l'application n'a pas à connaître le nom d'hôte sous lequel on l'atteint.
 */
function toPublicShipment(created, { localShipmentId, labelFormat }) {
  const packages = created.packages ?? [];
  const id = localShipmentId || packages[0]?.trackingNumber || created.shipmentIdentificationNumber;

  return {
    id,
    shipmentId: created.shipmentIdentificationNumber,
    trackingNumbers: packages.map((p) => p.trackingNumber).filter(Boolean),
    labelFormat,
    // Base64 pour l'impression immédiate…
    labels: packages.map((p) => ({
      trackingNumber: p.trackingNumber || null,
      base64: p.label?.base64 ?? null,
      mime: p.label?.mime ?? null,
    })),
    // …et l'URL pour la récupérer plus tard, sans avoir à la stocker.
    labelUrl: id ? `/api/v1/shipments/${encodeURIComponent(id)}/label` : null,
    totalCharges: created.totalCharges ?? null,
    currency: created.currency ?? null,
  };
}

/** Forme publique d'un envoi relu en base. */
function toPublicStored(shipment, packages) {
  return {
    id: shipment.localShipmentId,
    shipmentId: shipment.shipmentId,
    status: shipment.status,
    statusDescription: shipment.statusDescription ?? null,
    createdAt: shipment.createdAt,
    expectedDelivery: shipment.expectedDelivery ?? null,
    deliveredAt: shipment.deliveredAt ?? null,
    voidedAt: shipment.voidedAt ?? null,
    recipient: {
      name: shipment.recipientName,
      city: shipment.recipientCity,
      postalCode: shipment.recipientPostal,
      country: shipment.recipientCountry,
    },
    trackingNumbers: packages.map((p) => p.trackingNumber).filter(Boolean),
    labelUrl: `/api/v1/shipments/${encodeURIComponent(shipment.localShipmentId)}/label`,
  };
}

/**
 * Remplace les `packageType` nommés par les caractéristiques du catalogue.
 * Même service que l'interface : une application tierce désigne « DS620 »
 * sans répéter poids et dimensions, et un changement du catalogue vaut pour
 * les deux.
 */
async function resolvePackages(packages, label) {
  if (!isDbEnabled()) return packages;

  return Promise.all(
    (packages ?? []).map(async (pkg) => {
      if (!pkg?.packageType) return pkg;

      const type = await findByLabel(pkg.packageType);
      if (!type) {
        throw badRequest(`${label} — type de colis « ${pkg.packageType} » introuvable.`);
      }

      // La valeur explicite prime : le type ne fournit qu'un défaut.
      const { packageType, ...explicit } = pkg;
      return {
        weight: explicit.weight || type.weight,
        length: explicit.length || type.length || undefined,
        width: explicit.width || type.width || undefined,
        height: explicit.height || type.height || undefined,
        description: explicit.description || type.description || undefined,
        packagingType: explicit.packagingType || type.packagingType || undefined,
        reference: explicit.reference || type.reference || undefined,
      };
    }),
  );
}

/** Enregistre l'envoi. Un échec ici ne perd jamais l'étiquette déjà facturée. */
async function persist(payload) {
  if (!isDbEnabled()) return { localShipmentId: null };
  try {
    let expectedDelivery = null;
    let transitDays = null;
    try {
      const weight = Number(payload.shipment?.billingWeight?.split(' ')[0]) || 1;
      const { services } = await getTransitTimes({ shipTo: payload.shipTo, weight });
      const match = services?.find((s) => s.serviceCode === payload.serviceCode) ?? services?.[0];
      expectedDelivery = match?.deliveryDate ?? null;
      transitDays = match?.businessDaysInTransit ?? null;
    } catch {
      // Date de livraison indisponible : l'envoi est enregistré sans elle.
    }

    const rows = await saveShipment({
      ...payload,
      serviceName: SERVICE_CODES[payload.serviceCode] || null,
      expectedDelivery,
      transitDays,
    });
    return { localShipmentId: rows[0]?.localShipmentId ?? null };
  } catch (err) {
    console.error('[api/v1] Enregistrement impossible :', err.message);
    return { localShipmentId: null };
  }
}

/** Valide et normalise une expédition du corps de requête. */
function validateEntry(entry, label) {
  if (!entry?.shipTo) throw badRequest(`${label} — le champ "shipTo" est obligatoire.`);
  requireFields(
    entry.shipTo,
    ['name', 'addressLine1', 'city', 'postalCode', 'country'],
    `${label} shipTo`,
  );
  // Un type nommé dispense de poids : la validation vient après résolution.
  const named = (entry.packages ?? []).some((p) => p?.packageType);
  if (!named) validateEntry.packages(entry.packages, label);
}
validateEntry.packages = (packages, label) => {
  try {
    validatePackages(packages);
  } catch (err) {
    throw badRequest(`${label} — ${err.message}`);
  }
};

/**
 * GET /api/v1/ping — vérifie la clé.
 *
 * L'intégrateur confirme sa configuration sans créer d'étiquette facturée.
 */
publicApiRouter.get('/ping', (req, res) => {
  res.json({ success: true, data: { client: req.apiClient, environment: process.env.UPS_ENV || 'test' } });
});

/**
 * GET /api/v1/services — codes de service acceptés.
 * Évite à l'appelant de coder en dur une table qui lui échapperait.
 */
publicApiRouter.get('/services', (req, res) => {
  res.json({
    success: true,
    data: {
      services: Object.entries(SERVICE_CODES).map(([code, name]) => ({ code, name })),
      labelFormats: Object.keys(LABEL_FORMATS),
    },
  });
});

/**
 * POST /api/v1/shipments — crée une expédition et son étiquette.
 */
publicApiRouter.post(
  '/shipments',
  asyncHandler(async (req, res) => {
    const {
      shipTo,
      shipFrom,
      packages,
      serviceCode = '11',
      description,
      labelFormat = 'GIF',
      reference,
    } = req.body;

    validateEntry({ shipTo, packages }, 'shipments');

    if (!LABEL_FORMATS[labelFormat]) {
      throw badRequest(
        `labelFormat invalide. Valeurs acceptées : ${Object.keys(LABEL_FORMATS).join(', ')}`,
      );
    }
    if (shipFrom) {
      requireFields(
        shipFrom,
        ['name', 'addressLine1', 'city', 'postalCode', 'country'],
        'champ shipFrom',
      );
    }

    const resolved = await resolvePackages(packages, 'shipments');
    validateEntry.packages(resolved, 'shipments');

    const created = await createShipment({
      shipTo,
      shipFrom,
      packages: resolved,
      serviceCode,
      description,
      labelFormat,
    });

    const { localShipmentId } = await persist({
      shipment: created,
      // La référence de l'appelant est rangée dans le champ `reference` de
      // l'envoi : déjà stocké, déjà cherchable depuis l'interface. C'est par
      // elle qu'il relie l'envoi à sa propre commande.
      shipTo: reference ? { ...shipTo, reference } : shipTo,
      serviceCode,
      description,
      labelFormat,
      shipper: created.shipper,
    });

    const tracking = created.packages?.[0]?.trackingNumber;
    await log(req, {
      action: ACTIONS.SHIPMENT_CREATE,
      entityType: 'shipment',
      entityId: localShipmentId || tracking || created.shipmentIdentificationNumber,
      summary: `Étiquette ${tracking || created.shipmentIdentificationNumber} → ${describeRecipient(shipTo)}`,
      metadata: {
        shipmentId: created.shipmentIdentificationNumber,
        trackingNumber: tracking ?? null,
        packageCount: created.packages?.length ?? 1,
        serviceCode,
        via: 'api',
        client: req.apiClient,
        reference: reference ?? null,
      },
    });

    res.status(201).json({
      success: true,
      data: toPublicShipment(created, { localShipmentId, labelFormat }),
    });
  }),
);

/**
 * POST /api/v1/orders — crée une commande : plusieurs expéditions en un appel.
 *
 * Chaque ligne est indépendante : une adresse refusée par UPS n'annule pas
 * les étiquettes déjà obtenues, qui sont facturées. La réponse détaille donc
 * chaque ligne, réussie ou non, et le statut vaut pour l'ensemble.
 */
publicApiRouter.post(
  '/orders',
  asyncHandler(async (req, res) => {
    const {
      shipments,
      shipFrom,
      serviceCode,
      description,
      labelFormat = 'GIF',
      reference,
    } = req.body;

    if (!Array.isArray(shipments) || shipments.length === 0) {
      throw badRequest('Le champ "shipments" doit contenir au moins une expédition.');
    }
    if (shipments.length > MAX_BATCH) {
      throw badRequest(`${MAX_BATCH} expéditions maximum par commande.`);
    }
    if (!LABEL_FORMATS[labelFormat]) {
      throw badRequest(
        `labelFormat invalide. Valeurs acceptées : ${Object.keys(LABEL_FORMATS).join(', ')}`,
      );
    }
    if (shipFrom) {
      requireFields(
        shipFrom,
        ['name', 'addressLine1', 'city', 'postalCode', 'country'],
        'champ shipFrom',
      );
    }

    // Tout est validé avant le premier appel UPS : découvrir une ligne
    // invalide à mi-parcours laisserait la moitié des étiquettes facturées.
    shipments.forEach((entry, i) => validateEntry(entry, `shipments[${i}]`));

    const resolvedEntries = [];
    for (const [i, entry] of shipments.entries()) {
      const resolved = await resolvePackages(entry.packages, `shipments[${i}]`);
      validateEntry.packages(resolved, `shipments[${i}]`);
      resolvedEntries.push({ ...entry, packages: resolved });
    }

    const orderId = `batch-${Date.now()}`;
    const results = [];

    for (const [index, entry] of resolvedEntries.entries()) {
      const entryService = entry.serviceCode || serviceCode || '11';
      try {
        const created = await createShipment({
          shipTo: entry.shipTo,
          shipFrom,
          packages: entry.packages,
          serviceCode: entryService,
          description: entry.description || description,
          labelFormat,
        });

        const entryReference = entry.reference ?? reference ?? null;
        const { localShipmentId } = await persist({
          shipment: created,
          shipTo: entryReference ? { ...entry.shipTo, reference: entryReference } : entry.shipTo,
          serviceCode: entryService,
          description: entry.description || description,
          labelFormat,
          batchId: orderId,
          shipper: created.shipper,
        });

        results.push({
          index,
          ok: true,
          reference: entry.reference ?? null,
          recipient: entry.shipTo.name,
          shipment: toPublicShipment(created, { localShipmentId, labelFormat }),
        });
      } catch (err) {
        results.push({
          index,
          ok: false,
          reference: entry.reference ?? null,
          recipient: entry.shipTo?.name ?? null,
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
      entityId: orderId,
      summary:
        `Commande ${req.apiClient} : ${created} étiquette${created > 1 ? 's' : ''} créée${created > 1 ? 's' : ''}` +
        (failed > 0 ? `, ${failed} en échec` : ''),
      metadata: { batchId: orderId, created, failed, total: results.length, via: 'api', client: req.apiClient, reference: reference ?? null },
    });

    // 207 : la commande est partiellement satisfaite. Un 201 laisserait
    // croire que tout est passé, un 502 ferait ignorer les étiquettes déjà
    // facturées — les deux mèneraient à un doublon au réessai.
    const status = failed === 0 ? 201 : created > 0 ? 207 : 502;

    res.status(status).json({
      success: created > 0,
      data: { orderId, created, failed, total: results.length, results },
    });
  }),
);

/** GET /api/v1/orders/:orderId — récapitulatif d'une commande. */
publicApiRouter.get(
  '/orders/:orderId',
  asyncHandler(async (req, res) => {
    if (!isDbEnabled()) {
      throw Object.assign(new Error('Consultation indisponible sans base de données.'), {
        status: 503,
        code: 'DB_NOT_CONFIGURED',
      });
    }

    const batch = await getBatch(req.params.orderId);
    if (!batch) {
      throw Object.assign(new Error('Commande introuvable.'), { status: 404, code: 'NOT_FOUND' });
    }

    res.json({
      success: true,
      data: {
        orderId: batch.batchId ?? req.params.orderId,
        createdAt: batch.createdAt ?? null,
        total: batch.shipmentCount ?? batch.shipments?.length ?? 0,
        counts: batch.counts ?? null,
        // Vrai quand plus aucun envoi ne bouge : l'appelant sait qu'il peut
        // cesser d'interroger la commande.
        completed: batch.completed ?? false,
        shipments: (batch.shipments ?? []).map((s) => toPublicStored(s, [s])),
      },
    });
  }),
);

/** GET /api/v1/shipments/:id — état d'un envoi. */
publicApiRouter.get(
  '/shipments/:id',
  asyncHandler(async (req, res) => {
    if (!isDbEnabled()) {
      throw Object.assign(new Error('Consultation indisponible sans base de données.'), {
        status: 503,
        code: 'DB_NOT_CONFIGURED',
      });
    }

    const shipment = await getShipmentByTracking(req.params.id);
    if (!shipment) {
      throw Object.assign(new Error('Envoi introuvable.'), { status: 404, code: 'NOT_FOUND' });
    }

    const packages = await listPackagesOfShipment(shipment.localShipmentId).catch(() => [shipment]);
    res.json({ success: true, data: toPublicStored(shipment, packages) });
  }),
);

/**
 * GET /api/v1/shipments/:id/label — étiquette(s) de l'envoi.
 *
 * Déclarée avant `/shipments/:id` ? Non : Express distingue les deux par le
 * segment supplémentaire, l'ordre n'a pas d'incidence ici.
 */
publicApiRouter.get(
  '/shipments/:id/label',
  asyncHandler(async (req, res) => {
    if (!isDbEnabled()) {
      throw Object.assign(new Error('Étiquettes indisponibles sans base de données.'), {
        status: 503,
        code: 'DB_NOT_CONFIGURED',
      });
    }

    const labels = await listLabelsOfShipment(req.params.id);
    const found = labels.length ? labels : [await getLabel(req.params.id)].filter(Boolean);

    if (!found.length) {
      throw Object.assign(new Error('Aucune étiquette enregistrée pour cet envoi.'), {
        status: 404,
        code: 'LABEL_NOT_FOUND',
      });
    }

    // `?format=binary` sert le fichier tel quel : l'appelant le passe à une
    // imprimante ou le stocke sans décoder du base64.
    if (req.query.format === 'binary') {
      const first = found[0];
      const mime = LABEL_FORMATS[first.format]?.mime ?? 'application/octet-stream';
      const ext = LABEL_FORMATS[first.format]?.ext ?? 'bin';
      res.setHeader('Content-Type', mime);
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${first.trackingNumber || 'etiquette'}.${ext}"`,
      );
      return res.send(Buffer.from(first.base64, 'base64'));
    }

    res.json({
      success: true,
      data: {
        labels: found.map((l) => ({
          trackingNumber: l.trackingNumber,
          format: l.format,
          base64: l.base64,
        })),
      },
    });
  }),
);

/**
 * DELETE /api/v1/shipments/:shipmentId — annule une expédition.
 *
 * L'identifiant est celui d'UPS (`shipmentId`), seul reconnu par l'API
 * d'annulation.
 */
publicApiRouter.delete(
  '/shipments/:shipmentId',
  asyncHandler(async (req, res) => {
    const trackingNumbers = req.query.trackingNumbers
      ? String(req.query.trackingNumbers)
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

    const result = await voidShipment(req.params.shipmentId, trackingNumbers);

    let voidedLocalId = null;
    if (result.success && isDbEnabled()) {
      try {
        const rows = await markVoided(req.params.shipmentId);
        voidedLocalId = rows[0]?.localShipmentId ?? null;
      } catch (err) {
        console.error('[api/v1] Statut annulé non enregistré :', err.message);
      }
    }

    if (result.success) {
      await log(req, {
        action: ACTIONS.SHIPMENT_VOID,
        entityType: 'shipment',
        entityId: voidedLocalId || req.params.shipmentId,
        summary: `Expédition ${req.params.shipmentId} annulée`,
        metadata: {
          trackingNumbers,
          shipmentId: req.params.shipmentId,
          via: 'api',
          client: req.apiClient,
        },
      });
    }

    res.json({ success: result.success, data: result });
  }),
);
