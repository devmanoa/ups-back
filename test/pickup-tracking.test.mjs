/**
 * POST /api/pickup — rattachement des numéros de suivi.
 *
 * Le champ TrackingData de la spec UPS n'était pas envoyé : rien ne reliait
 * un enlèvement aux étiquettes créées. UPS est simulé par un mock de module.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = (p) => pathToFileURL(path.resolve(import.meta.dirname, '../src', p)).href;

/** Corps réellement transmis à UPS, capturé pour les assertions. */
let sentBody = null;

mock.module(src('services/upsClient.js'), {
  namedExports: {
    upsFetch: async (_path, { body }) => {
      sentBody = body;
      return {
        PickupCreationResponse: {
          PRN: '2968show',
          RateResult: { GrandTotalOfAllCharge: '0.00', CurrencyCode: 'EUR' },
        },
      };
    },
  },
});

mock.module(src('config.js'), {
  namedExports: {
    config: {
      accountNumber: 'A1B2C3',
      shipper: { name: 'Ma Societe', attentionName: 'Expedition', phone: '0102030405', country: 'FR' },
    },
    API_VERSIONS: { pickup: 'v2409' },
    assertCredentials: () => {},
  },
});

mock.module(src('services/activity.js'), {
  namedExports: {
    log: async () => {},
    ACTIONS: { PICKUP_CREATE: 'pickup.create', PICKUP_CANCEL: 'pickup.cancel' },
  },
});

const { pickupRouter } = await import(src('routes/pickup.js'));
const { errorHandler } = await import(src('middleware/errorHandler.js'));
const { default: express } = await import('express');

async function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/api/pickup', pickupRouter);
  app.use(errorHandler);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => server.close());

  const port = server.address().port;
  return async (body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/pickup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
}

const BASE = {
  address: { addressLine1: '1 rue de la Paix', city: 'Paris', postalCode: '75002', country: 'FR' },
  pickupDate: '2026-08-25',
  pieces: [{ quantity: '2' }],
};

test('les numéros de suivi sont transmis dans TrackingData', async (t) => {
  sentBody = null;
  const call = await startServer(t);

  const res = await call({
    ...BASE,
    trackingNumbers: ['1Z12345E1512345676', '1Z12345E1512345677'],
  });

  assert.equal(res.status, 201);
  assert.deepEqual(sentBody.PickupCreationRequest.TrackingData, [
    { TrackingNumber: '1Z12345E1512345676' },
    { TrackingNumber: '1Z12345E1512345677' },
  ]);
  // L'appelant doit savoir ce qui a été retenu.
  assert.equal(res.body.data.trackingNumbers.length, 2);
});

test('sans numéro, TrackingData est absent plutôt que vide', async (t) => {
  sentBody = null;
  const call = await startServer(t);

  const res = await call(BASE);

  assert.equal(res.status, 201);
  assert.equal(
    'TrackingData' in sentBody.PickupCreationRequest,
    false,
    'un tableau vide pourrait être refusé par UPS',
  );
});

test('AlternateAddressIndicator est toujours envoyé (champ requis)', async (t) => {
  sentBody = null;
  const call = await startServer(t);

  await call(BASE);

  assert.equal(sentBody.PickupCreationRequest.AlternateAddressIndicator, 'N');
});

test('les doublons sont retirés', async (t) => {
  sentBody = null;
  const call = await startServer(t);

  const res = await call({
    ...BASE,
    trackingNumbers: ['1Z12345E1512345676', '1Z12345E1512345676'],
  });

  assert.equal(res.status, 201);
  assert.equal(sentBody.PickupCreationRequest.TrackingData.length, 1);
});

test('les espaces autour du numéro sont retirés', async (t) => {
  sentBody = null;
  const call = await startServer(t);

  await call({ ...BASE, trackingNumbers: ['  1Z12345E1512345676  '] });

  assert.equal(
    sentBody.PickupCreationRequest.TrackingData[0].TrackingNumber,
    '1Z12345E1512345676',
  );
});

test('plus de 30 numéros est refusé, la limite venant de la spec UPS', async (t) => {
  sentBody = null;
  const call = await startServer(t);

  const many = Array.from({ length: 31 }, (_, i) => `1Z1234500000000${String(i).padStart(3, '0')}`);
  const res = await call({ ...BASE, trackingNumbers: many });

  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /30 numéros/);
  assert.equal(sentBody, null, 'aucun appel UPS ne doit partir');
});

test('un numéro trop long est refusé avant l appel UPS', async (t) => {
  sentBody = null;
  const call = await startServer(t);

  const res = await call({ ...BASE, trackingNumbers: ['1Z12345E1512345676TROPLONG'] });

  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /18 caractères/);
  assert.equal(sentBody, null);
});

test('un numéro vide est refusé', async (t) => {
  sentBody = null;
  const call = await startServer(t);

  const res = await call({ ...BASE, trackingNumbers: ['1Z12345E1512345676', '  '] });

  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /vide/);
});

test('trackingNumbers doit être un tableau', async (t) => {
  sentBody = null;
  const call = await startServer(t);

  const res = await call({ ...BASE, trackingNumbers: '1Z12345E1512345676' });

  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /tableau/);
});

test('le numéro de confirmation est bien lu (PRN)', async (t) => {
  const call = await startServer(t);
  const res = await call(BASE);

  // Le journal d'activité lisait result.prn, toujours undefined.
  assert.equal(res.body.data.confirmationNumber, '2968show');
});
