/**
 * POST /api/shipments/sync — bascule automatique QuantumView → Tracking.
 *
 * UPS est simulé par des mocks de modules : aucun identifiant ni réseau
 * n'est nécessaire. Lancement : npm test (exige le drapeau
 * --experimental-test-module-mocks, posé dans le script npm).
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = (p) => pathToFileURL(path.resolve(import.meta.dirname, '../src', p)).href;

/** Erreur telle que la construit upsClient à partir d'une réponse UPS. */
function upsError(code, message) {
  return Object.assign(new Error(message), { status: 400, code, upsCodes: [code] });
}

const OPEN_SHIPMENTS = [
  { trackingNumber: '1ZTEST0000000001', status: 'created' },
  { trackingNumber: '1ZTEST0000000002', status: 'in_transit' },
];

/** État partagé entre les mocks et les assertions, remis à zéro par test. */
const calls = { getEvents: 0, track: [], updateStatus: [] };
let getEventsImpl = () => {
  throw new Error('getEvents non configuré pour ce test');
};

mock.module(src('services/quantumView.js'), {
  namedExports: {
    getEvents: (...args) => {
      calls.getEvents += 1;
      return getEventsImpl(...args);
    },
    latestStatusByTracking: (events) => {
      const map = new Map();
      for (const e of events) map.set(e.trackingNumber, e);
      return map;
    },
  },
});

mock.module(src('services/tracking.js'), {
  namedExports: {
    trackByNumber: async (n) => {
      calls.track.push(n);
      return {
        packages: [
          {
            trackingNumber: n,
            shipmentInquiryNumber: n,
            currentStatus: 'In Transit',
            currentStatusCode: '',
            activities: [{ date: '2026-08-18T10:00:00' }],
          },
        ],
        matched: true,
      };
    },
    // Reproduit le contrat réel : correspondance sur le numéro du colis.
    findMatchingPackage: (packages, n) => packages.find((p) => p.trackingNumber === n),
  },
});

mock.module(src('db/shipmentsRepository.js'), {
  namedExports: {
    listShipments: async () => ({ total: 0, shipments: [] }),
    listOpenShipments: async (limit) => OPEN_SHIPMENTS.slice(0, limit),
    getShipmentByTracking: async () => null,
    listPackagesOfShipment: async () => [],
    updateStatus: async (trackingNumber, fields) => {
      calls.updateStatus.push({ trackingNumber, ...fields });
      return { trackingNumber, ...fields };
    },
    countByStatus: async () => ({}),
    // Le mock remplace tout le module : un export manquant casse l'import
    // du routeur, même si ce test ne s'en sert pas.
    getStats: async () => ({}),
    getLabel: async () => null,
  },
});

mock.module(src('db/pool.js'), {
  namedExports: { isDbEnabled: () => true, query: async () => ({ rows: [] }) },
});

const { shipmentsRouter } = await import(src('routes/shipments.js'));
const { default: express } = await import('express');

/** Monte le routeur seul et renvoie une fonction d'appel HTTP réelle. */
async function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/api/shipments', shipmentsRouter);
  // Copie minimale du gestionnaire d'erreurs de l'application.
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ success: false, error: { message: err.message } });
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => server.close());

  return (body) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/shipments/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
}

function resetCalls() {
  calls.getEvents = 0;
  calls.track.length = 0;
  calls.updateStatus.length = 0;
}

test('330052 (QVD inactif) → repli Tracking sur les envois ouverts', async (t) => {
  resetCalls();
  getEventsImpl = () => {
    throw upsError('330052', 'The user has been blocked from downloading subscription files...');
  };

  const res = await (await startServer(t))();
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.mode, 'tracking');
  assert.equal(body.data.checked, 2);
  assert.equal(body.data.updated, 2);
  assert.equal(body.data.failed, 0);
  assert.equal(body.data.hasMore, false);
  assert.deepEqual(calls.track, ['1ZTEST0000000001', '1ZTEST0000000002']);
  assert.equal(calls.updateStatus.length, 2);
  assert.equal(calls.updateStatus[0].status, 'in_transit');
});

test('250002 (API non souscrite) → repli Tracking également', async (t) => {
  resetCalls();
  getEventsImpl = () => {
    throw upsError('250002', 'Invalid Authentication Information.');
  };

  const res = await (await startServer(t))();
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.data.mode, 'tracking');
  assert.equal(body.data.updated, 2);
});

test('autre erreur UPS → renvoyée au client, pas de repli silencieux', async (t) => {
  resetCalls();
  getEventsImpl = () => {
    throw upsError('10500', 'Panne UPS quelconque');
  };

  const res = await (await startServer(t))();
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.success, false);
  assert.equal(calls.track.length, 0, 'le repli ne doit pas se déclencher');
});

test('QuantumView disponible → mode quantumview, aucun appel Tracking', async (t) => {
  resetCalls();
  getEventsImpl = async () => ({
    events: [
      {
        trackingNumber: '1ZTEST0000000001',
        status: 'delivered',
        description: 'Livré',
        date: '2026-08-18T09:00:00',
      },
    ],
    bookmark: null,
  });

  const res = await (await startServer(t))();
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.data.mode, 'quantumview');
  assert.equal(body.data.eventsRead, 1);
  assert.equal(body.data.updated, 1);
  assert.equal(calls.track.length, 0);
});
