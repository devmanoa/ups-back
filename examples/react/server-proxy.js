/**
 * Proxy Express à placer dans le backend de l'application appelante.
 *
 * **Pourquoi un proxy plutôt qu'un appel direct depuis React ?**
 *
 * La clé d'API engage un compte UPS facturé. Tout ce qui atteint le
 * navigateur est lisible : une clé dans du code React, dans une variable
 * `VITE_*` ou dans un appel `fetch` se retrouve dans le bundle, l'onglet
 * Réseau et le cache du navigateur. N'importe quel visiteur pourrait alors
 * créer des étiquettes à vos frais.
 *
 * Le navigateur appelle donc ce proxy, qui seul détient la clé. C'est le
 * même raisonnement que pour ANTENNES_WS_TOKEN, gardé côté serveur.
 *
 * Le proxy authentifie ses propres utilisateurs — ici un simple exemple avec
 * `req.user` : sans cela, il devient une API UPS ouverte à tout Internet.
 */
import { Router } from 'express';
import { createUpsClient, UpsApiError } from '../ups-client.js';

export const upsProxyRouter = Router();

const ups = createUpsClient({
  baseUrl: process.env.UPS_API_URL,
  apiKey: process.env.UPS_API_KEY,
});

/** Un proxy sans contrôle d'accès expose le compte UPS à tout Internet. */
upsProxyRouter.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, error: { message: 'Non connecté.' } });
  next();
});

/** Traduit une UpsApiError en réponse HTTP, sans divulguer la clé. */
function handle(res, err) {
  if (err instanceof UpsApiError) {
    return res.status(err.status ?? 502).json({
      success: false,
      error: { message: err.message, code: err.code, upsCodes: err.upsCodes },
    });
  }
  console.error('[ups] Erreur inattendue :', err);
  res.status(500).json({ success: false, error: { message: 'Erreur interne.' } });
}

/** POST /api/ups/shipments — crée une étiquette pour l'utilisateur connecté. */
upsProxyRouter.post('/shipments', async (req, res) => {
  try {
    const { shipTo, packages, serviceCode, labelFormat } = req.body;

    const envoi = await ups.createShipment({
      shipTo,
      packages,
      serviceCode,
      labelFormat,
      // La référence relie l'envoi à vos propres données : ne la laissez pas
      // au client, qui pourrait désigner la commande d'un autre utilisateur.
      reference: `USER-${req.user.id}-${Date.now()}`,
    });

    res.status(201).json({ success: true, data: envoi });
  } catch (err) {
    handle(res, err);
  }
});

/** GET /api/ups/shipments/:id/label — sert l'étiquette au navigateur. */
upsProxyRouter.get('/shipments/:id/label', async (req, res) => {
  try {
    const { buffer, mime } = await ups.getLabelFile(req.params.id);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="etiquette-${req.params.id}"`);
    res.send(buffer);
  } catch (err) {
    handle(res, err);
  }
});

/** GET /api/ups/shipments/:id — état d'un envoi. */
upsProxyRouter.get('/shipments/:id', async (req, res) => {
  try {
    res.json({ success: true, data: await ups.getShipment(req.params.id) });
  } catch (err) {
    handle(res, err);
  }
});
