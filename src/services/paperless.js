import { API_VERSIONS, config } from '../config.js';
import { upsFetch } from './upsClient.js';

const V = API_VERSIONS.paperless;

/** Types de documents douaniers acceptés par UPS. */
export const DOCUMENT_TYPES = {
  '001': 'Facture commerciale',
  '002': 'Certificat d’origine',
  '003': 'Déclaration d’exportation',
  '004': 'Connaissement',
  '005': 'Lettre de transport aérien',
  '006': 'Licence d’exportation',
  '007': "Certificat d'assurance",
  '008': 'Facture pro forma',
  '009': 'Liste de colisage',
  '010': 'Certificat NAFTA',
  '011': 'Autre document',
  '012': 'Déclaration de marchandises dangereuses',
  '013': 'Formulaire personnalisé',
};

/** Formats de fichier acceptés. */
export const FILE_FORMATS = ['pdf', 'doc', 'docx', 'jpg', 'png', 'txt', 'rtf', 'xls', 'xlsx'];

function assertAccountNumber() {
  if (!config.accountNumber) {
    throw Object.assign(
      new Error('UPS_ACCOUNT_NUMBER est requis pour les documents dématérialisés.'),
      { status: 400, code: 'MISSING_ACCOUNT_NUMBER' },
    );
  }
}

/**
 * Téléverse un document douanier.
 * POST /api/paperlessdocuments/v2/upload
 *
 * Le fichier est transmis en base64 ; UPS renvoie un identifiant de document
 * réutilisable lors de la création d'une expédition internationale.
 */
export async function uploadDocument({ fileName, fileFormat, documentType, fileBase64 }) {
  assertAccountNumber();

  const format = (fileFormat || '').toLowerCase();
  if (!FILE_FORMATS.includes(format)) {
    throw Object.assign(
      new Error(`Format de fichier non supporté. Formats acceptés : ${FILE_FORMATS.join(', ')}`),
      { status: 400, code: 'UNSUPPORTED_FORMAT' },
    );
  }

  const body = {
    UploadRequest: {
      Request: { TransactionReference: { CustomerContext: 'ups-backend paperless' } },
      UserCreatedForm: {
        UserCreatedFormFileName: fileName,
        UserCreatedFormFileFormat: format,
        UserCreatedFormDocumentType: documentType || '013',
        UserCreatedFormFile: fileBase64,
      },
    },
  };

  const data = await upsFetch(`/paperlessdocuments/${V}/upload`, {
    method: 'POST',
    body,
    headers: { ShipperNumber: config.accountNumber },
  });

  const result = data?.UploadResponse || {};
  const documentId =
    result.FormsHistoryDocumentID?.DocumentID ||
    result.FormsHistoryDocumentID?.[0]?.DocumentID ||
    '';

  return {
    documentId: Array.isArray(documentId) ? documentId[0] : documentId,
    status: result.Response?.ResponseStatus?.Description || 'Téléversé',
    raw: data,
  };
}

/**
 * Rattache un document déjà téléversé à une expédition.
 * POST /api/paperlessdocuments/v2/image
 *
 * À appeler après uploadDocument, avec l'identifiant qu'il retourne.
 */
export async function linkDocumentToShipment({
  documentIds,
  shipmentIdentifier,
  trackingNumber,
  shipFromCountry,
  shipToCountry,
}) {
  assertAccountNumber();

  const body = {
    PushToImageRepositoryRequest: {
      Request: { TransactionReference: { CustomerContext: 'ups-backend paperless link' } },
      FormsHistoryDocumentID: {
        DocumentID: Array.isArray(documentIds) ? documentIds : [documentIds],
      },
      ShipmentIdentifier: shipmentIdentifier,
      ShipmentType: '1', // 1 = expédition sortante
      ShipperNumber: config.accountNumber,
      ...(trackingNumber ? { TrackingNumber: trackingNumber } : {}),
      ShipFromCountryCode: shipFromCountry || config.shipper.country || 'FR',
      ShipToCountryCode: shipToCountry,
    },
  };

  const data = await upsFetch(`/paperlessdocuments/${V}/image`, {
    method: 'POST',
    body,
    headers: { ShipperNumber: config.accountNumber },
  });

  const status = data?.PushToImageRepositoryResponse?.Response?.ResponseStatus;
  return {
    success: status?.Code === '1',
    message: status?.Description || 'Statut inconnu',
    raw: data,
  };
}
