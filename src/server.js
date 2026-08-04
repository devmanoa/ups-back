import express from 'express';
import cors from 'cors';
import { config, API_VERSIONS } from './config.js';
import { tokenStatus, getAccessToken } from './services/auth.js';
import { trackingRouter } from './routes/tracking.js';
import { ratingRouter } from './routes/rating.js';
import { shippingRouter } from './routes/shipping.js';
import { addressRouter } from './routes/addressValidation.js';
import { locatorRouter } from './routes/locator.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { asyncHandler } from './middleware/validate.js';

const app = express();

app.use(cors({ origin: config.corsOrigin }));
// Les étiquettes en base64 peuvent être volumineuses.
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    environment: config.env,
    baseUrl: config.baseUrl,
    credentialsConfigured: Boolean(config.clientId && config.clientSecret),
    accountConfigured: Boolean(config.accountNumber),
    apiVersions: API_VERSIONS,
    token: tokenStatus(),
  });
});

/** Vérifie que les identifiants UPS fonctionnent réellement. */
app.get(
  '/api/auth/test',
  asyncHandler(async (req, res) => {
    await getAccessToken();
    res.json({ success: true, message: 'Authentification UPS réussie', token: tokenStatus() });
  }),
);

app.use('/api/tracking', trackingRouter);
app.use('/api/rating', ratingRouter);
app.use('/api/shipping', shippingRouter);
app.use('/api/address', addressRouter);
app.use('/api/locator', locatorRouter);

app.use(notFound);
app.use(errorHandler);

// 0.0.0.0 est indispensable en conteneur : sur localhost, le port ne serait
// pas joignable depuis l'extérieur du conteneur.
app.listen(config.port, '0.0.0.0', () => {
  console.log(`\n  Backend UPS démarré`);
  console.log(`  → http://localhost:${config.port}`);
  console.log(`  → Environnement UPS : ${config.env} (${config.baseUrl})`);

  if (!config.clientId || !config.clientSecret) {
    console.warn(`  ⚠  UPS_CLIENT_ID / UPS_CLIENT_SECRET absents — copiez .env.example vers .env`);
  }
  if (!config.accountNumber) {
    console.warn(`  ⚠  UPS_ACCOUNT_NUMBER absent — Shipping et tarifs négociés indisponibles`);
  }

  console.log(`  → CORS autorisé pour : ${config.corsOrigin.join(', ')}`);
  // En production, oublier CORS_ORIGIN est l'erreur la plus fréquente :
  // le frontend se charge mais tous ses appels sont bloqués par le navigateur.
  if (process.env.NODE_ENV === 'production' && config.corsOrigin.some((o) => o.includes('localhost'))) {
    console.warn(`  ⚠  CORS_ORIGIN pointe encore vers localhost — définissez le domaine du frontend`);
  }
  console.log('');
});
