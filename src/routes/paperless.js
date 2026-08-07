import { Router } from 'express';
import {
  uploadDocument,
  linkDocumentToShipment,
  DOCUMENT_TYPES,
  FILE_FORMATS,
} from '../services/paperless.js';
import { asyncHandler, badRequest, requireFields } from '../middleware/validate.js';

export const paperlessRouter = Router();

/** Limite UPS pour un document dématérialisé. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** GET /api/paperless/document-types */
paperlessRouter.get('/document-types', (req, res) => {
  res.json({
    success: true,
    data: {
      documentTypes: Object.entries(DOCUMENT_TYPES).map(([code, name]) => ({ code, name })),
      fileFormats: FILE_FORMATS,
    },
  });
});

/** POST /api/paperless/upload — téléverse un document douanier */
paperlessRouter.post(
  '/upload',
  asyncHandler(async (req, res) => {
    const { fileName, fileFormat, documentType, fileBase64 } = req.body;

    requireFields(req.body, ['fileName', 'fileFormat', 'fileBase64']);

    // Le base64 pèse environ 4/3 de la taille réelle du fichier.
    const approximateBytes = (fileBase64.length * 3) / 4;
    if (approximateBytes > MAX_FILE_BYTES) {
      throw badRequest('Le document dépasse la taille maximale de 10 Mo.');
    }

    if (documentType && !DOCUMENT_TYPES[documentType]) {
      throw badRequest(
        `documentType invalide. Valeurs acceptées : ${Object.keys(DOCUMENT_TYPES).join(', ')}`,
      );
    }

    const result = await uploadDocument({ fileName, fileFormat, documentType, fileBase64 });
    res.status(201).json({ success: true, data: result });
  }),
);

/** POST /api/paperless/link — rattache un document à une expédition */
paperlessRouter.post(
  '/link',
  asyncHandler(async (req, res) => {
    const { documentIds, shipmentIdentifier, trackingNumber, shipFromCountry, shipToCountry } =
      req.body;

    if (!documentIds || (Array.isArray(documentIds) && documentIds.length === 0)) {
      throw badRequest('Le champ "documentIds" est obligatoire.');
    }
    requireFields(req.body, ['shipmentIdentifier', 'shipToCountry']);

    const result = await linkDocumentToShipment({
      documentIds,
      shipmentIdentifier,
      trackingNumber,
      shipFromCountry,
      shipToCountry,
    });

    res.json({ success: result.success, data: result });
  }),
);
