import { Router } from 'express';
import {
  listPackageTypes,
  getPackageType,
  createPackageType,
  updatePackageType,
  archivePackageType,
  restorePackageType,
  markUsed,
} from '../db/packageTypesRepository.js';
import { PACKAGING_CODES, isValidPackagingCode } from '../services/packaging.js';
import { isDbEnabled } from '../db/pool.js';
import { asyncHandler, badRequest, requireFields } from '../middleware/validate.js';
import { log, ACTIONS } from '../services/activity.js';

export const packageTypesRouter = Router();

/** Violation d'unicité PostgreSQL : le nom est déjà pris. */
const UNIQUE_VIOLATION = '23505';

/** Les codes d'emballage sont une liste fixe : consultable sans base. */
packageTypesRouter.get('/packaging-codes', (req, res) => {
  res.json({
    success: true,
    data: Object.entries(PACKAGING_CODES).map(([code, name]) => ({ code, name })),
  });
});

/** Sans base, le catalogue est indisponible ; le reste de l'app fonctionne. */
packageTypesRouter.use((req, res, next) => {
  if (!isDbEnabled()) {
    return next(
      Object.assign(
        new Error('Les types de colis nécessitent une base PostgreSQL. Renseignez DATABASE_URL.'),
        { status: 503, code: 'DB_NOT_CONFIGURED' },
      ),
    );
  }
  next();
});

/** GET /api/package-types — liste, avec recherche */
packageTypesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { search, includeArchived } = req.query;
    const types = await listPackageTypes({
      search: search ? String(search) : undefined,
      includeArchived: includeArchived === 'true',
    });
    res.json({ success: true, data: { types, count: types.length } });
  }),
);

/** POST /api/package-types — enregistre un type */
packageTypesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = validateInput(req.body, { partial: false });

    try {
      const type = await createPackageType(input);

      await log(req, {
        action: ACTIONS.PACKAGE_TYPE_CREATE,
        entityType: 'package_type',
        entityId: type.id,
        summary: `Type de colis « ${type.label} » ajouté (${type.weight} kg)`,
        metadata: { weight: type.weight, packagingType: type.packagingType },
      });

      res.status(201).json({ success: true, data: type });
    } catch (err) {
      throw translateWriteError(err, input.label);
    }
  }),
);

/** GET /api/package-types/:id */
packageTypesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const type = await getPackageType(parseId(req.params.id));
    if (!type) throw notFoundError('Type de colis introuvable.');
    res.json({ success: true, data: type });
  }),
);

/** PUT /api/package-types/:id — modification partielle */
packageTypesRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const input = validateInput(req.body, { partial: true });

    try {
      const type = await updatePackageType(id, input);
      if (!type) throw notFoundError('Type de colis introuvable.');

      await log(req, {
        action: ACTIONS.PACKAGE_TYPE_UPDATE,
        entityType: 'package_type',
        entityId: type.id,
        summary: `Type de colis « ${type.label} » modifié`,
        metadata: { fields: Object.keys(input) },
      });

      res.json({ success: true, data: type });
    } catch (err) {
      throw translateWriteError(err, input.label);
    }
  }),
);

/** DELETE /api/package-types/:id — archive, ?hard=true pour supprimer */
packageTypesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const hard = req.query.hard === 'true';
    const type = await archivePackageType(parseId(req.params.id), { hard });
    if (!type) throw notFoundError('Type de colis introuvable ou déjà archivé.');

    await log(req, {
      action: hard ? ACTIONS.PACKAGE_TYPE_DELETE : ACTIONS.PACKAGE_TYPE_ARCHIVE,
      entityType: 'package_type',
      entityId: type.id,
      summary: `Type de colis « ${type.label} » ${hard ? 'supprimé' : 'archivé'}`,
    });

    res.json({
      success: true,
      data: type,
      message: hard ? 'Type supprimé.' : 'Type archivé.',
    });
  }),
);

/** POST /api/package-types/:id/restore */
packageTypesRouter.post(
  '/:id/restore',
  asyncHandler(async (req, res) => {
    try {
      const type = await restorePackageType(parseId(req.params.id));
      if (!type) throw notFoundError('Type de colis introuvable.');

      await log(req, {
        action: ACTIONS.PACKAGE_TYPE_RESTORE,
        entityType: 'package_type',
        entityId: type.id,
        summary: `Type de colis « ${type.label} » restauré`,
      });

      res.json({ success: true, data: type });
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) {
        throw badRequest(
          'Un type actif porte déjà ce nom. Renommez-le avant de restaurer celui-ci.',
          ['label'],
        );
      }
      throw err;
    }
  }),
);

/** POST /api/package-types/:id/use — enregistre une utilisation */
packageTypesRouter.post(
  '/:id/use',
  asyncHandler(async (req, res) => {
    const type = await markUsed(parseId(req.params.id));
    if (!type) throw notFoundError('Type de colis introuvable.');
    res.json({ success: true, data: type });
  }),
);

/* -------------------------------- Utils --------------------------------- */

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw badRequest('Identifiant de type de colis invalide.');
  }
  return id;
}

function notFoundError(message) {
  return Object.assign(new Error(message), { status: 404, code: 'NOT_FOUND' });
}

/**
 * Valide et normalise le corps d'une requête d'écriture.
 * Seul le poids est obligatoire, comme dans le formulaire de saisie.
 */
function validateInput(body, { partial }) {
  if (!body || typeof body !== 'object') throw badRequest('Corps de requête invalide.');

  if (!partial) {
    requireFields(body, ['label', 'weight'], 'type de colis');
  } else {
    const emptied = ['label', 'weight'].filter(
      (f) => body[f] !== undefined && String(body[f]).trim() === '',
    );
    if (emptied.length) {
      throw badRequest(`Ces champs ne peuvent pas être vidés : ${emptied.join(', ')}`, emptied);
    }
  }

  const input = { ...body };

  for (const key of ['label', 'description', 'reference']) {
    if (typeof input[key] === 'string') input[key] = input[key].trim();
  }

  // Poids et dimensions doivent être des nombres strictement positifs :
  // un zéro ou une valeur négative serait refusé par UPS, plus tard et
  // avec un message moins clair.
  for (const key of ['weight', 'length', 'width', 'height']) {
    if (input[key] === undefined || input[key] === null || input[key] === '') continue;

    const value = Number(String(input[key]).replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      throw badRequest(`Le champ "${key}" doit être un nombre supérieur à 0.`, [key]);
    }
    input[key] = value;
  }

  if (input.packagingType !== undefined && input.packagingType !== '') {
    if (!isValidPackagingCode(input.packagingType)) {
      throw badRequest(
        `Code d'emballage inconnu. Valeurs acceptées : ${Object.keys(PACKAGING_CODES).join(', ')}`,
        ['packagingType'],
      );
    }
  }

  return input;
}

function translateWriteError(err, label) {
  if (err.code === UNIQUE_VIOLATION) {
    return badRequest(
      `Un type de colis nommé « ${label} » existe déjà. Choisissez un autre nom.`,
      ['label'],
    );
  }
  return err;
}
