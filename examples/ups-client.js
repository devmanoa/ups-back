/**
 * Client Node.js pour l'API machine UPS (`/api/v1`).
 *
 * À copier dans l'application appelante. Aucune dépendance : `fetch` est
 * natif depuis Node 18.
 *
 * **Ce fichier ne doit jamais être importé par du code navigateur.** La clé
 * appelle un compte UPS facturé : quiconque la lit peut créer des étiquettes
 * à vos frais. Elle reste sur le serveur, dans une variable d'environnement.
 */

/** Erreur portant le code applicatif et, s'il existe, le code UPS. */
export class UpsApiError extends Error {
  constructor(message, { status, code, upsCodes = [] } = {}) {
    super(message);
    this.name = 'UpsApiError';
    this.status = status;
    this.code = code;
    // Le code UPS identifie la cause exacte (120205 = adresse invalide…) et
    // sert à décider si un réessai a un sens.
    this.upsCodes = upsCodes;
  }
}

export function createUpsClient({ baseUrl, apiKey, timeoutMs = 30_000 } = {}) {
  if (!baseUrl) throw new Error('baseUrl est obligatoire (ex. https://ups.example.com).');
  if (!apiKey) throw new Error('apiKey est obligatoire — voir la variable API_KEYS du backend.');

  const root = baseUrl.replace(/\/$/, '');

  async function request(path, { method = 'GET', body, raw = false } = {}) {
    // Sans délai maximal, une panne réseau bloquerait la requête de
    // l'utilisateur jusqu'au timeout TCP, soit plusieurs minutes.
    const abort = AbortSignal.timeout(timeoutMs);

    let res;
    try {
      res = await fetch(`${root}/api/v1${path}`, {
        method,
        headers: {
          'X-API-Key': apiKey,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: abort,
      });
    } catch (cause) {
      const reason = cause?.name === 'TimeoutError' ? 'délai dépassé' : 'serveur injoignable';
      throw new UpsApiError(`Appel vers ${root} impossible — ${reason}.`, { code: 'NETWORK_ERROR' });
    }

    // Étiquette binaire : le corps n'est pas du JSON.
    if (raw) {
      if (!res.ok) throw new UpsApiError(`Erreur HTTP ${res.status}`, { status: res.status });
      return {
        buffer: Buffer.from(await res.arrayBuffer()),
        mime: res.headers.get('content-type') ?? 'application/octet-stream',
      };
    }

    const data = await res.json().catch(() => null);

    if (!res.ok || data?.success === false) {
      throw new UpsApiError(data?.error?.message || `Erreur HTTP ${res.status}`, {
        status: res.status,
        code: data?.error?.code,
        upsCodes: data?.error?.upsCodes ?? [],
      });
    }

    // Le statut compte pour les commandes : 207 signale un lot partiellement
    // créé, que le corps seul ne distingue pas d'un succès complet.
    return { status: res.status, data: data?.data ?? data };
  }

  return {
    /** Vérifie la clé sans créer d'étiquette facturée. */
    async ping() {
      const { data } = await request('/ping');
      return data;
    },

    /** Codes de service et formats d'étiquette acceptés. */
    async getServices() {
      const { data } = await request('/services');
      return data;
    },

    /**
     * Crée une étiquette.
     *
     * `reference` est votre identifiant de commande : c'est par lui que vous
     * relierez l'envoi à vos propres données.
     */
    async createShipment({ shipTo, packages, serviceCode, labelFormat, shipFrom, description, reference }) {
      const { data } = await request('/shipments', {
        method: 'POST',
        body: { shipTo, packages, serviceCode, labelFormat, shipFrom, description, reference },
      });
      return data;
    },

    /**
     * Crée une commande : plusieurs expéditions en un appel (50 maximum).
     *
     * `partial` vaut true quand certaines lignes ont échoué : les étiquettes
     * obtenues sont déjà facturées, ne réessayez que les lignes en échec.
     */
    async createOrder({ shipments, shipFrom, serviceCode, labelFormat, description, reference }) {
      const { status, data } = await request('/orders', {
        method: 'POST',
        body: { shipments, shipFrom, serviceCode, labelFormat, description, reference },
      });
      return { ...data, partial: status === 207 };
    },

    /** État d'un envoi. */
    async getShipment(id) {
      const { data } = await request(`/shipments/${encodeURIComponent(id)}`);
      return data;
    },

    /** État d'une commande. `completed` = plus rien ne bouge. */
    async getOrder(orderId) {
      const { data } = await request(`/orders/${encodeURIComponent(orderId)}`);
      return data;
    },

    /** Étiquettes en base64. */
    async getLabels(id) {
      const { data } = await request(`/shipments/${encodeURIComponent(id)}/label`);
      return data.labels;
    },

    /** Étiquette en fichier binaire, prête à écrire sur disque ou imprimer. */
    async getLabelFile(id) {
      return request(`/shipments/${encodeURIComponent(id)}/label?format=binary`, { raw: true });
    },

    /** Annule une expédition. L'identifiant attendu est celui d'UPS. */
    async voidShipment(shipmentId, trackingNumbers = []) {
      const query = trackingNumbers.length
        ? `?trackingNumbers=${encodeURIComponent(trackingNumbers.join(','))}`
        : '';
      const { data } = await request(`/shipments/${encodeURIComponent(shipmentId)}${query}`, {
        method: 'DELETE',
      });
      return data;
    },
  };
}
