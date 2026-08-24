/**
 * GET /api/shipments/stats — indicateurs chiffrés.
 *
 * Le piège du calcul : `saveShipment` écrit une ligne par colis, et chacune
 * porte le total de l'expédition entière. Ces tests vérifient que la route
 * agrège bien par expédition et non par ligne.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = (p) => pathToFileURL(path.resolve(import.meta.dirname, '../src', p)).href;

/** Paramètres reçus par getStats, capturés pour les assertions. */
let statsParams = null;
const state = { dbEnabled: true };

const STATS = {
  shipmentCount: 3,
  packageCount: 7,
  totalCost: 45.9,
  averageCost: 15.3,
  currency: 'EUR',
  averageDeliveryDays: 2.4,
  deliveredCount: 2,
  byStatus: { created: 1, in_transit: 1, delivered: 1 },
  byService: [{ service: 'UPS Standard', shipmentCount: 3, totalCost: 45.9 }],
  byDay: [{ day: '2026-08-20', shipmentCount: 3, totalCost: 45.9 }],
};

mock.module(src('db/shipmentsRepository.js'), {
  namedExports: {
    listShipments: async () => ({ total: 0, shipments: [] }),
    listOpenShipments: async () => [],
    getShipmentByTracking: async () => null,
    updateStatus: async () => null,
    countByStatus: async () => ({ created: 1, in_transit: 1, delivered: 1 }),
    getStats: async (params) => {
      statsParams = params;
      return STATS;
    },
    getLabel: async () => null,
  },
});

mock.module(src('db/pool.js'), {
  namedExports: {
    isDbEnabled: () => state.dbEnabled,
    query: async () => ({ rows: [] }),
  },
});

const { shipmentsRouter } = await import(src('routes/shipments.js'));
const { errorHandler } = await import(src('middleware/errorHandler.js'));
const { default: express } = await import('express');

async function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/api/shipments', shipmentsRouter);
  app.use(errorHandler);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => server.close());

  const port = server.address().port;
  return async (url) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`);
    return { status: res.status, body: await res.json() };
  };
}

test('les indicateurs sont renvoyés avec les compteurs', async (t) => {
  state.dbEnabled = true;
  const call = await startServer(t);
  const { status, body } = await call('/api/shipments/stats');

  assert.equal(status, 200);
  assert.equal(body.data.dbEnabled, true);
  assert.equal(body.data.stats.totalCost, 45.9);
  // `counts` est conservé : le tableau de bord existant s'en sert.
  assert.deepEqual(body.data.counts, { created: 1, in_transit: 1, delivered: 1 });
});

test('un envoi multi-colis compte pour une expédition', async (t) => {
  state.dbEnabled = true;
  const call = await startServer(t);
  const { body } = await call('/api/shipments/stats');

  // 7 colis pour 3 expéditions : le coût ne doit pas être multiplié par le
  // nombre de lignes en base.
  assert.equal(body.data.stats.shipmentCount, 3);
  assert.equal(body.data.stats.packageCount, 7);
  // Comparaison approchée : 45.9 / 3 vaut 15.299999… en virgule flottante.
  assert.ok(
    Math.abs(
      body.data.stats.averageCost - body.data.stats.totalCost / body.data.stats.shipmentCount,
    ) < 0.001,
    'le coût moyen doit se rapporter aux expéditions, pas aux colis',
  );
});

test('la période est transmise au dépôt', async (t) => {
  state.dbEnabled = true;
  statsParams = null;
  const call = await startServer(t);

  await call('/api/shipments/stats?from=2026-08-01&to=2026-08-31');

  assert.equal(statsParams.from, '2026-08-01');
  assert.equal(statsParams.to, '2026-08-31');
});

test('une date invalide est refusée', async (t) => {
  state.dbEnabled = true;
  const call = await startServer(t);

  const bad = await call('/api/shipments/stats?from=pas-une-date');
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /from/);
});

test('sans base, la route répond sans indicateurs plutôt qu en erreur', async (t) => {
  state.dbEnabled = false;
  const call = await startServer(t);

  const { status, body } = await call('/api/shipments/stats');

  assert.equal(status, 200);
  assert.equal(body.data.dbEnabled, false);
  assert.equal(body.data.stats, undefined, 'aucun chiffre trompeur');
});
