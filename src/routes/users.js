import { Router } from 'express';
import { searchUsers, isDirectoryConfigured } from '../services/directory.js';
import { listPendingNotifications, markNotified, markNotifyError } from '../db/mentionsRepository.js';
import { notifyMention, isNotificationsConfigured } from '../services/notifications.js';
import { asyncHandler } from '../middleware/validate.js';
import { requireActor } from '../middleware/auth.js';
import { isDbEnabled } from '../db/pool.js';

export const usersRouter = Router();

// L'annuaire expose les noms et courriels de tout le realm — plus de
// soixante personnes, dont certaines étrangères à cette application. Une
// identité est exigée ici même quand AUTH_REQUIRED laisse le reste ouvert :
// sans cela, quiconque atteint le backend pourrait le parcourir.
usersRouter.use(requireActor);

/**
 * GET /api/users?search=jul — annuaire pour les mentions.
 *
 * Les identifiants et noms suffisent à composer une mention ; rien de plus
 * n'est exposé, l'annuaire d'un realm n'ayant pas à transiter en entier.
 */
usersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    if (!isDirectoryConfigured()) {
      // 200 et liste vide plutôt qu'une erreur : le champ de commentaire
      // reste utilisable, seules les mentions sont indisponibles.
      return res.json({
        success: true,
        data: {
          users: [],
          configured: false,
          missing: ['KEYCLOAK_ADMIN_CLIENT_ID', 'KEYCLOAK_ADMIN_CLIENT_SECRET'],
        },
      });
    }

    const users = await searchUsers(String(req.query.search ?? ''));
    res.json({ success: true, data: { users, configured: true } });
  }),
);

/**
 * POST /api/users/mentions/retry — relance les notifications non parties.
 *
 * Une panne du service de notifications laisse des mentions en attente : ce
 * point d'entrée les rejoue, sans jamais notifier deux fois puisque seules
 * les mentions sans date d'envoi sont reprises.
 */
usersRouter.post(
  '/mentions/retry',
  asyncHandler(async (req, res) => {
    if (!isDbEnabled() || !isNotificationsConfigured()) {
      return res.json({ success: true, data: { retried: 0, sent: 0, configured: false } });
    }

    const pending = await listPendingNotifications(50);

    const results = await Promise.all(
      pending.map(async (mention) => {
        try {
          const result = await notifyMention({
            mention,
            author: null,
            excerpt: 'Vous avez été mentionné dans un commentaire.',
            appUrl: null,
          });
          if (result.sent) {
            await markNotified(mention.id);
            return true;
          }
          return false;
        } catch (err) {
          await markNotifyError(mention.id, err.message).catch(() => {});
          return false;
        }
      }),
    );

    res.json({
      success: true,
      data: {
        retried: pending.length,
        sent: results.filter(Boolean).length,
        configured: true,
      },
    });
  }),
);
