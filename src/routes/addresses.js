import { Router } from 'express';
import {
  listAddresses,
  getAddress,
  createAddress,
  updateAddress,
  archiveAddress,
  restoreAddress,
  markUsed,
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  groupExists,
} from '../db/addressesRepository.js';
import { isDbEnabled } from '../db/pool.js';
import { asyncHandler, badRequest, requireFields } from '../middleware/validate.js';
import { log, ACTIONS } from '../services/activity.js';

export const addressesRouter = Router();

/**
 * Champs exigés à l'enregistrement : exactement ceux que l'API Shipping
 * réclame pour un destinataire. Une adresse du carnet est donc toujours
 * expédiable — impossible d'y stocker un brouillon inutilisable.
 */
const REQUIRED = ['label', 'name', 'addressLine1', 'city', 'postalCode', 'country'];

/** Violation d'unicité PostgreSQL : le nom est déjà pris. */
const UNIQUE_VIOLATION = '23505';

/**
 * Sans base, le carnet est indisponible comme l'historique des envois —
 * le reste de l'application continue de fonctionner.
 */
addressesRouter.use((req, res, next) => {
  if (!isDbEnabled()) {
    return next(
      Object.assign(
        new Error('Le carnet d\'adresses nécessite une base PostgreSQL. Renseignez DATABASE_URL.'),
        { status: 503, code: 'DB_NOT_CONFIGURED' },
      ),
    );
  }
  next();
});

/* -------------------------------- Groupes ------------------------------- */
// Déclarés avant /:id, sinon "groups" serait interprété comme un identifiant.

/** GET /api/addresses/groups — groupes et nombre d'adresses */
addressesRouter.get(
  '/groups',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await listGroups() });
  }),
);

/** POST /api/addresses/groups — crée un groupe */
addressesRouter.post(
  '/groups',
  asyncHandler(async (req, res) => {
    requireFields(req.body, ['name'], 'groupe');
    const name = String(req.body.name).trim();
    if (!name) throw badRequest('Le nom du groupe ne peut pas être vide.');

    try {
      const group = await createGroup({ name });

      await log(req, {
        action: ACTIONS.GROUP_CREATE,
        entityType: 'group',
        entityId: group.id,
        summary: `Groupe d'adresses « ${group.name} » créé`,
      });

      res.status(201).json({ success: true, data: group });
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) {
        throw badRequest(`Un groupe nommé « ${name} » existe déjà.`, ['name']);
      }
      throw err;
    }
  }),
);

/** PUT /api/addresses/groups/:id — renomme ou réordonne */
addressesRouter.put(
  '/groups/:id',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id, 'groupe');
    const patch = {};

    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) throw badRequest('Le nom du groupe ne peut pas être vide.');
      patch.name = name;
    }
    if (req.body.position !== undefined) patch.position = Number(req.body.position);

    try {
      const group = await updateGroup(id, patch);
      if (!group) throw notFoundError('Groupe introuvable.');

      await log(req, {
        action: ACTIONS.GROUP_UPDATE,
        entityType: 'group',
        entityId: group.id,
        summary: `Groupe d'adresses « ${group.name} » modifié`,
      });

      res.json({ success: true, data: group });
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) {
        throw badRequest(`Un groupe nommé « ${patch.name} » existe déjà.`, ['name']);
      }
      throw err;
    }
  }),
);

/**
 * DELETE /api/addresses/groups/:id
 * Les adresses du groupe sont conservées : elles deviennent « sans groupe ».
 */
addressesRouter.delete(
  '/groups/:id',
  asyncHandler(async (req, res) => {
    const group = await deleteGroup(parseId(req.params.id, 'groupe'));
    if (!group) throw notFoundError('Groupe introuvable.');

    await log(req, {
      action: ACTIONS.GROUP_DELETE,
      entityType: 'group',
      entityId: group.id,
      summary: `Groupe d'adresses « ${group.name} » supprimé`,
    });

    res.json({
      success: true,
      data: group,
      message: 'Groupe supprimé. Ses adresses sont conservées, sans groupe.',
    });
  }),
);

/* ------------------------------- Adresses ------------------------------- */

/** GET /api/addresses — liste, avec recherche et filtre par groupe */
addressesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { search, groupId, includeArchived } = req.query;
    const addresses = await listAddresses({
      search: search ? String(search) : undefined,
      groupId: groupId ? String(groupId) : undefined,
      includeArchived: includeArchived === 'true',
    });
    res.json({ success: true, data: { addresses, count: addresses.length } });
  }),
);

/** POST /api/addresses — enregistre une adresse */
addressesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = await validateAddressInput(req.body, { partial: false });
    try {
      const address = await createAddress(input);

      await log(req, {
        action: ACTIONS.ADDRESS_CREATE,
        entityType: 'address',
        entityId: address.id,
        summary: `Adresse « ${address.label} » ajoutée au carnet`,
        metadata: { city: address.city, country: address.country, groupId: address.groupId },
      });

      res.status(201).json({ success: true, data: address });
    } catch (err) {
      throw translateWriteError(err, input.label);
    }
  }),
);

/** GET /api/addresses/:id */
addressesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const address = await getAddress(parseId(req.params.id, 'adresse'));
    if (!address) throw notFoundError('Adresse introuvable.');
    res.json({ success: true, data: address });
  }),
);

/** PUT /api/addresses/:id — modification partielle */
addressesRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id, 'adresse');
    const input = await validateAddressInput(req.body, { partial: true });

    try {
      const address = await updateAddress(id, input);
      if (!address) throw notFoundError('Adresse introuvable.');

      await log(req, {
        action: ACTIONS.ADDRESS_UPDATE,
        entityType: 'address',
        entityId: address.id,
        summary: `Adresse « ${address.label} » modifiée`,
        // Les champs touchés situent la modification sans dupliquer l'adresse.
        metadata: { fields: Object.keys(input) },
      });

      res.json({ success: true, data: address });
    } catch (err) {
      throw translateWriteError(err, input.label);
    }
  }),
);

/** DELETE /api/addresses/:id — archive par défaut, ?hard=true pour supprimer */
addressesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const hard = req.query.hard === 'true';
    const address = await archiveAddress(parseId(req.params.id, 'adresse'), { hard });
    if (!address) throw notFoundError('Adresse introuvable ou déjà archivée.');

    await log(req, {
      action: hard ? ACTIONS.ADDRESS_DELETE : ACTIONS.ADDRESS_ARCHIVE,
      entityType: 'address',
      entityId: address.id,
      summary: `Adresse « ${address.label} » ${hard ? 'supprimée' : 'archivée'}`,
    });

    res.json({
      success: true,
      data: address,
      message: hard ? 'Adresse supprimée.' : 'Adresse archivée.',
    });
  }),
);

/** POST /api/addresses/:id/restore */
addressesRouter.post(
  '/:id/restore',
  asyncHandler(async (req, res) => {
    try {
      const address = await restoreAddress(parseId(req.params.id, 'adresse'));
      if (!address) throw notFoundError('Adresse introuvable.');

      await log(req, {
        action: ACTIONS.ADDRESS_RESTORE,
        entityType: 'address',
        entityId: address.id,
        summary: `Adresse « ${address.label} » restaurée`,
      });

      res.json({ success: true, data: address });
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) {
        throw badRequest(
          'Une adresse active porte déjà ce nom. Renommez-la avant de restaurer celle-ci.',
          ['label'],
        );
      }
      throw err;
    }
  }),
);

/**
 * POST /api/addresses/:id/use — enregistre une utilisation.
 * Alimente le tri par fréquence ; n'échoue jamais l'appel appelant.
 */
addressesRouter.post(
  '/:id/use',
  asyncHandler(async (req, res) => {
    const address = await markUsed(parseId(req.params.id, 'adresse'));
    if (!address) throw notFoundError('Adresse introuvable.');
    res.json({ success: true, data: address });
  }),
);

/* -------------------------------- Utils --------------------------------- */

function parseId(raw, label) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw badRequest(`Identifiant de ${label} invalide.`);
  }
  return id;
}

function notFoundError(message) {
  return Object.assign(new Error(message), { status: 404, code: 'NOT_FOUND' });
}

/**
 * Valide et normalise le corps d'une requête d'écriture.
 * En modification partielle, seuls les champs présents sont contrôlés.
 */
async function validateAddressInput(body, { partial }) {
  if (!body || typeof body !== 'object') throw badRequest('Corps de requête invalide.');

  if (!partial) {
    requireFields(body, REQUIRED, 'adresse');
  } else {
    // Un champ obligatoire explicitement vidé doit être refusé, pas enregistré.
    const emptied = REQUIRED.filter(
      (f) => body[f] !== undefined && String(body[f]).trim() === '',
    );
    if (emptied.length) {
      throw badRequest(`Ces champs ne peuvent pas être vidés : ${emptied.join(', ')}`, emptied);
    }
  }

  const input = { ...body };

  for (const key of ['label', 'name', 'attentionName', 'city', 'addressLine1', 'addressLine2', 'phone']) {
    if (typeof input[key] === 'string') input[key] = input[key].trim();
  }

  if (typeof input.country === 'string') {
    input.country = input.country.trim().toUpperCase();
    if (input.country && input.country.length !== 2) {
      throw badRequest('Le pays doit être un code ISO à 2 lettres (FR, BE, DE…).', ['country']);
    }
  }
  if (typeof input.state === 'string') input.state = input.state.trim().toUpperCase();
  if (typeof input.postalCode === 'string') input.postalCode = input.postalCode.trim();

  // Une référence vers un groupe inexistant serait acceptée par la base
  // (group_id est nullable) : on la refuse explicitement.
  if (input.groupId !== undefined && input.groupId !== null && input.groupId !== '') {
    const groupId = Number(input.groupId);
    if (!Number.isInteger(groupId) || groupId <= 0) {
      throw badRequest('Identifiant de groupe invalide.', ['groupId']);
    }
    if (!(await groupExists(groupId))) {
      throw badRequest('Le groupe indiqué n\'existe pas.', ['groupId']);
    }
    input.groupId = groupId;
  }

  return input;
}

/** Traduit une contrainte d'unicité en message lisible. */
function translateWriteError(err, label) {
  if (err.code === UNIQUE_VIOLATION) {
    return badRequest(
      `Une adresse nommée « ${label} » existe déjà. Choisissez un autre nom.`,
      ['label'],
    );
  }
  return err;
}
