import express from 'express';
import cors from 'cors';
import { config, API_VERSIONS } from './config.js';
import { tokenStatus, getAccessToken } from './services/auth.js';
import { trackingRouter } from './routes/tracking.js';
import { ratingRouter } from './routes/rating.js';
import { shippingRouter } from './routes/shipping.js';
import { locatorRouter } from './routes/locator.js';
import { diagnosticRouter } from './routes/diagnostic.js';
import { timeInTransitRouter } from './routes/timeInTransit.js';
import { landedCostRouter } from './routes/landedCost.js';
import { pickupRouter } from './routes/pickup.js';
import { paperlessRouter } from './routes/paperless.js';
import { shipmentsRouter } from './routes/shipments.js';
import { addressesRouter } from './routes/addresses.js';
import { activityRouter } from './routes/activity.js';
import { batchesRouter } from './routes/batches.js';
import { packageTypesRouter } from './routes/packageTypes.js';
import { attachActor } from './middleware/auth.js';
import { jwksStatus } from './services/keycloak.js';
import { migrate } from './db/migrate.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { asyncHandler } from './middleware/validate.js';

const app = express();

app.use(cors({ origin: config.corsOrigin }));
// Étiquettes et documents douaniers transitent en base64 : un document de
// 10 Mo (limite UPS) pèse environ 13,3 Mo une fois encodé.
app.use(express.json({ limit: '16mb' }));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    environment: config.env,
    baseUrl: config.baseUrl,
    credentialsConfigured: Boolean(config.clientId && config.clientSecret),
    accountConfigured: Boolean(config.accountNumber),
    apiVersions: API_VERSIONS,
    token: tokenStatus(),
    auth: jwksStatus(),
  });
});

// Identifie l'appelant à partir du jeton Keycloak, pour nommer les auteurs
// dans le journal d'activité. Placé après /health, qui doit rester joignable
// sans authentification pour le healthcheck Coolify.
app.use(attachActor);

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
app.use('/api/locator', locatorRouter);
app.use('/api/diagnostic', diagnosticRouter);
app.use('/api/transit-times', timeInTransitRouter);
app.use('/api/landed-cost', landedCostRouter);
app.use('/api/pickup', pickupRouter);
app.use('/api/paperless', paperlessRouter);
app.use('/api/shipments', shipmentsRouter);
app.use('/api/addresses', addressesRouter);
app.use('/api/activity', activityRouter);
app.use('/api/batches', batchesRouter);
app.use('/api/package-types', packageTypesRouter);

app.use(notFound);
app.use(errorHandler);

// La migration est lancée avant l'écoute, mais son échec n'empêche pas le
// démarrage : sans base, seul l'historique des envois est indisponible.
await migrate();

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

  if (!config.auth.keycloakUrl) {
    console.warn(`  ⚠  KEYCLOAK_URL absent — actions journalisées sans auteur`);
  } else {
    console.log(
      `  → Keycloak : realm ${config.auth.realm}` +
        (config.auth.required ? ' (jeton obligatoire)' : ' (jeton vérifié si fourni)'),
    );
  }

  console.log(`  → CORS autorisé pour : ${config.corsOrigin.join(', ')}`);
  // En production, oublier CORS_ORIGIN est l'erreur la plus fréquente :
  // le frontend se charge mais tous ses appels sont bloqués par le navigateur.
  if (process.env.NODE_ENV === 'production' && config.corsOrigin.some((o) => o.includes('localhost'))) {
    console.warn(`  ⚠  CORS_ORIGIN pointe encore vers localhost — définissez le domaine du frontend`);
  }
  console.log('');
});
