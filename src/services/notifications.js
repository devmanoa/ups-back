import { config } from '../config.js';

/**
 * Envoi des notifications vers l'application dédiée.
 *
 * Tout l'appel sortant est isolé ici : le format exact du service de
 * notifications n'est pas encore arrêté, et seule la fonction `send` est à
 * réécrire le jour où il le sera. Le reste de l'application appelle
 * `notifyMention` sans rien savoir du protocole.
 *
 * Le jeton reste côté serveur, comme celui d'Antennes.
 */

/** Un envoi lent ne doit pas retenir la réponse au commentaire. */
const TIMEOUT_MS = 8_000;

export function isNotificationsConfigured() {
  return Boolean(config.notifications.apiUrl && config.notifications.token);
}

function notifyError(message, code, status = 502) {
  return Object.assign(new Error(message), { status, code });
}

/**
 * Poste une notification.
 *
 * Le corps suit une forme volontairement générique — destinataire, type,
 * titre, lien — que la plupart des services de notification acceptent. À
 * ajuster une fois le contrat connu.
 */
async function send(payload) {
  const url = `${config.notifications.apiUrl}/notifications`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.notifications.token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' ? 'délai dépassé' : err.message;
    throw notifyError(`Service de notifications injoignable : ${reason}`, 'NOTIFY_UNREACHABLE', 503);
  }

  if (res.status === 401 || res.status === 403) {
    // Notre configuration est en cause, pas la requête de l'utilisateur.
    throw notifyError(
      'Service de notifications : jeton refusé. Vérifiez NOTIFICATIONS_TOKEN.',
      'NOTIFY_FORBIDDEN',
    );
  }

  if (!res.ok) {
    throw notifyError(`Service de notifications : HTTP ${res.status}`, 'NOTIFY_ERROR');
  }

  return res.json().catch(() => ({}));
}

/**
 * Notifie une personne mentionnée dans un commentaire.
 *
 * `appUrl` permet au destinataire d'ouvrir directement l'envoi concerné :
 * une notification sans lien oblige à retrouver l'envoi à la main.
 */
export async function notifyMention({ mention, author, excerpt, appUrl }) {
  if (!isNotificationsConfigured()) return { sent: false, reason: 'not_configured' };

  await send({
    // Application émettrice : le service en héberge plusieurs.
    source: 'ups',
    type: 'mention',
    recipient: {
      userId: mention.user.id,
      email: mention.user.email,
    },
    title: `${author?.name ?? 'Quelqu’un'} vous a mentionné`,
    body: excerpt,
    url: appUrl,
    // Rattache la notification à l'envoi : le service peut regrouper.
    reference: mention.trackingNumber,
  });

  return { sent: true };
}

/** Texte brut résumé d'un commentaire, pour le corps de la notification. */
export function excerptOf(html, max = 200) {
  const text = String(html ?? '')
    // Les balises disparaissent, leur texte reste.
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
