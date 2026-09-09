/**
 * Nettoyage du HTML d'un commentaire, côté serveur.
 *
 * Le front nettoie déjà à l'affichage, mais s'en remettre à lui seul fait
 * dépendre la sécurité d'un unique point : une requête forgée envoyée
 * directement à l'API stockerait le HTML tel quel, et il suffirait qu'un
 * futur écran l'affiche sans nettoyer pour exécuter le script.
 *
 * Sans dépendance : l'ensemble autorisé est petit et fermé, et une
 * bibliothèque complète serait disproportionnée. On procède par liste
 * blanche — tout ce qui n'est pas explicitement permis disparaît.
 */

/** Balises de mise en forme conservées. Alignées sur celles de l'éditeur. */
const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'br', 'p', 'div',
  'ul', 'ol', 'li', 'a', 'span',
]);

/** Identifiants Keycloak : UUID ou forme fédérée. */
const USER_ID = /^[\w:-]{1,128}$/;

/** Liens : seuls http et https. `javascript:` s'exécuterait au clic. */
const SAFE_HREF = /^https?:\/\//i;

function escapeText(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Réécrit une balise ouvrante à partir de zéro plutôt que de retirer ce qui
 * gêne : un attribut inattendu ne peut donc pas survivre par oubli.
 *
 * Renvoie la chaîne vide quand la balise est refusée — son texte, lui, est
 * conservé par l'appelant.
 */
function rebuildTag(rawTag, tagName) {
  if (tagName === 'br') return '<br>';

  if (tagName === 'a') {
    const href = /\shref\s*=\s*["']([^"']*)["']/i.exec(rawTag)?.[1] ?? '';
    if (!SAFE_HREF.test(href)) return '';
    return `<a href="${escapeText(href)}" target="_blank" rel="noreferrer">`;
  }

  if (tagName === 'span') {
    const id = /\sdata-mention\s*=\s*["']([^"']*)["']/i.exec(rawTag)?.[1] ?? '';
    // Un span sans mention valide n'apporte rien : il disparaît, son texte
    // reste — comme le fait l'éditeur.
    if (!USER_ID.test(id)) return '';
    return `<span data-mention="${escapeText(id)}" class="mention">`;
  }

  return `<${tagName}>`;
}

/** Nettoie le HTML d'un commentaire. */
export function sanitizeComment(html) {
  const input = String(html ?? '');
  let out = '';
  let index = 0;

  // Les contenus de script et de style sont retirés entiers : ne supprimer
  // que la balise laisserait leur code en texte visible.
  const stripped = input.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');

  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let match;

  // Balises ouvertes et effectivement écrites. Une fermeture n'est reprise
  // que si son ouverture l'a été : sinon un span refusé laisserait un
  // « </span> » orphelin, qui fermerait la balise d'un voisin légitime.
  const open = [];

  while ((match = tagPattern.exec(stripped)) !== null) {
    // Le texte entre deux balises est échappé : c'est lui qui porterait un
    // « < » ouvrant une balise que l'analyse aurait manquée.
    out += escapeText(stripped.slice(index, match.index));
    index = match.index + match[0].length;

    const tagName = match[1].toLowerCase();
    if (!ALLOWED_TAGS.has(tagName)) continue;

    if (match[0].startsWith('</')) {
      // Fermeture sans ouverture correspondante : ignorée.
      const at = open.lastIndexOf(tagName);
      if (at === -1) continue;
      open.splice(at, 1);
      out += `</${tagName}>`;
      continue;
    }

    const rebuilt = rebuildTag(match[0], tagName);
    if (!rebuilt) continue;

    // `br` ne se ferme pas : l'empiler laisserait une fermeture en trop.
    if (tagName !== 'br') open.push(tagName);
    out += rebuilt;
  }

  out += escapeText(stripped.slice(index));

  // Balises restées ouvertes : refermées dans l'ordre inverse. Un « <p> »
  // non refermé absorberait sinon la mise en page qui suit le commentaire.
  while (open.length) out += `</${open.pop()}>`;

  return out;
}
