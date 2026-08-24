import { Router } from 'express';
import { getContact, isAntennesConfigured } from '../services/antennes.js';
import { asyncHandler, badRequest } from '../middleware/validate.js';

export const antennesRouter = Router();

/**
 * GET /api/antennes/:contactId — adresse d'une antenne, prête à préremplir.
 *
 * Appelée quand l'utilisateur arrive depuis l'application Antennes par un
 * lien `/shipping?antenne=10`. Le jeton d'accès reste côté serveur.
 */
antennesRouter.get(
  '/:contactId',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.contactId);
    if (!Number.isInteger(id) || id < 1) {
      throw badRequest("L'identifiant d'antenne doit être un entier positif.");
    }

    const contact = await getContact(id);
    res.json({ success: true, data: contact });
  }),
);

/** GET /api/antennes — état de l'intégration, pour le diagnostic. */
antennesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: { configured: isAntennesConfigured() } });
  }),
);
