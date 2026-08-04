import { Router } from 'express';
import { validateAddress, REQUEST_OPTIONS } from '../services/addressValidation.js';
import { asyncHandler, badRequest, requireFields } from '../middleware/validate.js';

export const addressRouter = Router();

/** POST /api/address/validate */
addressRouter.post(
  '/validate',
  asyncHandler(async (req, res) => {
    const { address, requestOption = REQUEST_OPTIONS.BOTH, maxSuggestions = 5 } = req.body;

    if (!address) throw badRequest('Le champ "address" est obligatoire.');
    requireFields(address, ['country'], 'champ address');

    if (!address.postalCode && !address.city) {
      throw badRequest('Renseignez au minimum un code postal ou une ville.');
    }

    const option = Number(requestOption);
    if (![1, 2, 3].includes(option)) {
      throw badRequest('requestOption doit valoir 1 (validation), 2 (classification) ou 3 (les deux).');
    }

    const result = await validateAddress(address, {
      requestOption: option,
      maxSuggestions: Number(maxSuggestions) || 5,
    });

    res.json({ success: true, data: result });
  }),
);
