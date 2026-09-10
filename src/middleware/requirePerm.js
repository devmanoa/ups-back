import { config } from '../config.js';

/**
 * Contrôle d'accès Konitys : vérifie un droit auprès de la passerelle du Hub.
 *
 * Contrat décrit dans PERMISSIONS_APP_INTEGRATION.md. Quatre règles se
 * cumulent, dans cet ordre :
 *
 *   1. rôle Keycloak `admin` → tout est permis ;
 *   2. contrôle désactivé pour cette app → tout est permis ;
 *   3. droit accordé au profil → permis ;
 *   4. sinon refusé : 403 JSON pour l'API, page HTML pour une page.
 *
 * Tolérant à la panne : passerelle injoignable, l'accès est accordé. C'est
 * la règle imposée par la plateforme — un contrôle d'accès qui tombe ne doit
 * pas rendre les applications inutilisables.
 */

/** Cache court : la passerelle ne doit pas être appelée à chaque requête. */
const CACHE_TTL_MS = 30_000;
const cache = new Map();

/** Au-delà, le cache retiendrait autant d'entrées que de jetons émis. */
const MAX_CACHE_ENTRIES = 500;

/**
 * Bloc de configuration, avec des valeurs sûres par défaut.
 *
 * `config` peut être remplacé par un mock qui n'expose que ce dont un test a
 * besoin : lire ce bloc sans précaution ferait échouer des tests sans
 * rapport avec les droits.
 */
function perms() {
  return config.permissions ?? { gatewayUrl: '', appKey: 'ups', plateformUrl: '' };
}

export function isPermissionsConfigured() {
  return Boolean(perms().gatewayUrl);
}

async function loadMe(token) {
  const res = await fetch(`${perms().gatewayUrl}/api/permissions/me`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`permissions/me : HTTP ${res.status}`);
  return (await res.json()).data;
}

/**
 * Droits de l'appelant, mis en cache par jeton.
 *
 * La clé est le jeton et non l'identifiant : deux jetons du même utilisateur
 * peuvent porter des droits différents, et un cache par identifiant servirait
 * les droits d'une session révoquée.
 */
async function meFor(token) {
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const data = await loadMe(token);

  // Purge grossière mais suffisante : les entrées expirées d'abord, puis la
  // plus ancienne si le cache reste plein.
  if (cache.size >= MAX_CACHE_ENTRIES) {
    for (const [key, entry] of cache) {
      if (Date.now() - entry.at >= CACHE_TTL_MS) cache.delete(key);
    }
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  }

  cache.set(token, { at: Date.now(), data });
  return data;
}

/**
 * Le contrôle est-il actif pour cette application ?
 *
 * Deux modes exclusifs côté Hub : activé globalement sauf exceptions, ou
 * désactivé sauf applications explicitement listées.
 */
function isEnforced(enforcement, appKey) {
  if (!enforcement) return false;

  if (enforcement.globally_enabled) {
    return !(enforcement.disabled_apps ?? []).includes(appKey);
  }

  return (enforcement.enabled_apps ?? []).includes(appKey);
}

/** L'utilisateur décrit par `me` détient-il ce droit sur cette application ? */
export function canFor(me, appKey, permKey) {
  // Pas de réponse de la passerelle : on n'invente pas un refus.
  if (!me) return true;
  if (me.is_admin) return true;
  if (!isEnforced(me.enforcement, appKey)) return true;

  return Boolean(me.apps?.[appKey]?.[permKey]);
}

/**
 * Où renvoyer l'utilisateur depuis la page de refus.
 *
 * Règle imposée par la plateforme : sans accès à l'application, retour au
 * Hub — et sans accès au Hub non plus, aucun bouton, car il n'y a nulle part
 * où aller.
 */
function redirectForDenial(me, permKey) {
  const appKey = perms().appKey;
  const lacksAppAccess = permKey === 'app.access' || !canFor(me, appKey, 'app.access');

  if (lacksAppAccess) {
    if (perms().plateformUrl && canFor(me, 'hub', 'app.access')) {
      return { url: perms().plateformUrl, label: 'Retour au Hub' };
    }
    return null;
  }

  return { url: '/', label: "Retour à l'accueil" };
}

/**
 * Exige un droit sur une route.
 *
 * `page: true` sert les routes rendues à l'écran : elles reçoivent la page
 * HTML standard plutôt qu'un JSON. Notre API étant consommée par le front,
 * le défaut est le JSON.
 */
export function requirePerm(permKey, { page = false } = {}) {
  return async (req, res, next) => {
    // Passerelle non configurée : rien à contrôler. Permet de déployer le
    // schéma et les gardes avant que la plateforme ne soit branchée.
    if (!isPermissionsConfigured()) return next();

    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    let me = null;
    if (token) {
      try {
        me = await meFor(token);
      } catch (err) {
        // Tolérance à la panne imposée par la plateforme.
        console.warn(`[perms] Passerelle injoignable, accès accordé : ${err.message}`);
        return next();
      }
    }

    if (canFor(me, perms().appKey, permKey)) return next();

    // La clé technique n'est jamais montrée à l'utilisateur : elle ne sert
    // qu'aux journaux, et l'exposer renseignerait sur la structure interne.
    console.warn(`[perms] Refus de « ${permKey} » pour ${me?.user_id ?? 'anonyme'}`);

    const wantsJson =
      !page &&
      (req.path.startsWith('/api/') || (req.headers.accept || '').includes('application/json'));

    if (wantsJson) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Accès non autorisé. Contactez votre administrateur.',
        },
      });
    }

    const redirect = redirectForDenial(me, permKey);
    res.status(403).type('html').send(renderDeniedPage(redirect));
  };
}

/**
 * Vrai si l'appelant détient ce droit, sans rien bloquer.
 *
 * Sert les cas où le droit nuance un traitement au lieu de l'interdire —
 * modérer un commentaire plutôt que supprimer le sien. Renvoie `false` en
 * cas de panne : une permission élargie ne doit pas s'accorder par accident,
 * contrairement à `requirePerm` qui, lui, laisse passer l'action ordinaire.
 */
export async function hasPerm(req, permKey) {
  if (!isPermissionsConfigured()) return false;

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return false;

  try {
    const me = await meFor(token);
    if (!me) return false;
    if (me.is_admin) return true;
    if (!isEnforced(me.enforcement, perms().appKey)) return false;
    return Boolean(me.apps?.[perms().appKey]?.[permKey]);
  } catch {
    return false;
  }
}

/** Vide le cache des droits. Réservé aux tests. */
export function resetPermissionsCache() {
  cache.clear();
}

/**
 * Page de refus.
 *
 * Le thème est servi par la passerelle et personnalisable depuis l'admin ;
 * tant qu'il n'est pas synchronisé, ce rendu par défaut respecte la
 * structure attendue — icône, titre, message neutre, bouton conditionnel.
 */
function renderDeniedPage(redirect) {
  const button = redirect
    ? `<a href="${escapeHtml(redirect.url)}">
         <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>
         ${escapeHtml(redirect.label)}
       </a>`
    : '';

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Accès non autorisé</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:linear-gradient(135deg,#f8fafc 0%,#eef2f7 100%);color:#0f172a}
.card{background:#fff;border-radius:20px;padding:40px;max-width:440px;width:100%;text-align:center;box-shadow:0 20px 50px rgba(15,23,42,.08),0 2px 8px rgba(15,23,42,.04)}
.icon-wrap{width:88px;height:88px;border-radius:50%;background:linear-gradient(135deg,#fee2e2 0%,#fecaca 100%);margin:0 auto 24px;display:flex;align-items:center;justify-content:center;position:relative;color:#dc2626}
.icon-wrap::before{content:'';position:absolute;inset:-6px;border-radius:50%;border:2px dashed #dc262655;opacity:.6}
h1{font-size:22px;font-weight:700;margin-bottom:12px;letter-spacing:-.01em}
p{color:#64748b;font-size:14px;line-height:1.6;margin-bottom:28px}
a{display:inline-flex;align-items:center;gap:8px;padding:11px 22px;background:#0f172a;color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:14px;transition:all .15s;box-shadow:0 4px 12px #0f172a40}
a:hover{background:#1e293b;transform:translateY(-1px)}
</style></head>
<body><div class="card">
<div class="icon-wrap"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
<h1>Accès non autorisé</h1>
<p>Accès non autorisé. Contactez votre administrateur.</p>
${button}
</div></body></html>`;
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
