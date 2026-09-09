import { findUsersByIds } from './directory.js';

/**
 * Extraction des mentions « @quelqu'un » d'un commentaire.
 *
 * L'éditeur enregistre chaque mention comme un SPAN portant l'identifiant
 * Keycloak du collègue cité. On relit ces identifiants côté serveur plutôt
 * que de faire confiance à une liste envoyée par le client : sinon
 * n'importe qui pourrait déclencher une notification vers n'importe qui, en
 * modifiant simplement la requête.
 */

/** Identifiants Keycloak : UUID, ou forme fédérée « f:<uuid>:<id> ». */
const USER_ID = /^[\w:-]{1,128}$/;

/** Au-delà, c'est un envoi en masse déguisé, pas une conversation. */
const MAX_MENTIONS = 20;

/**
 * Lit les identifiants mentionnés dans le HTML d'un commentaire.
 * Aucune dépendance : une expression régulière suffit sur un attribut dont
 * le format est contraint, et le HTML est de toute façon renettoyé ailleurs.
 */
export function parseMentionIds(html) {
  const ids = new Set();
  const pattern = /<span[^>]*\sdata-mention=["']([^"']+)["'][^>]*>/gi;

  for (const match of String(html ?? '').matchAll(pattern)) {
    const id = match[1].trim();
    if (USER_ID.test(id)) ids.add(id);
    if (ids.size >= MAX_MENTIONS) break;
  }

  return [...ids];
}

/**
 * Résout les identifiants mentionnés en utilisateurs réels.
 *
 * Un identifiant inconnu de Keycloak est écarté sans erreur : le commentaire
 * doit rester publiable même si un compte a été supprimé entre-temps.
 *
 * L'auteur est retiré de la liste — se notifier soi-même n'a pas d'usage.
 */
export async function resolveMentions(html, { authorId } = {}) {
  const ids = parseMentionIds(html);
  if (!ids.length) return [];

  const users = await findUsersByIds(ids);
  return users.filter((user) => user.id !== authorId);
}
