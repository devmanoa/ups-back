/**
 * POST /api/shipping/bulk — résolution des types de colis nommés.
 *
 * Une ligne peut désigner « DS620 » au lieu de répéter son poids ; le
 * catalogue et UPS sont simulés par des mocks de modules.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = (p) => pathToFileURL(path.resolve(import.meta.dirname, '../src', p)).href;

const CATALOGUE = {
  ds620: {
    id: 1,
    label: 'DS620',
    weight: '12.5',
    length: '45',
    width: '35',
    height: '30',
    description: 'Imprimante photo DS620',
    packagingType: '02',
    reference: null,
  },
  'borne spherik': {
    id: 2,
    label: 'Borne Spherik',
    weight: '80',
    length: '',
    width: '',
    height: '',
    description: null,
    packagingType: '30',
    reference: null,
  },
};

/** Colis transmis à UPS, capturés pour les assertions. */
const sentPackages = [];
/** Appels complets a createShipment : sert aux assertions sur shipFrom. */
const shipmentCalls = [];

mock.module(src('db/packageTypesRepository.js'), {
  namedExports: {
    findByLabel: async (label) => CATALOGUE[String(label).toLowerCase()] ?? null,
  },
});

mock.module(src('services/shipping.js'), {
  namedExports: {
    LABEL_FORMATS: { GIF: { code: 'GIF', mime: 'image/gif', ext: 'gif' } },
    createShipment: async (payload) => {
      const { packages } = payload;
      shipmentCalls.push(payload);
      sentPackages.push(...packages);
      return {
        shipmentIdentificationNumber: '1ZBULK000000000',
        packages: [{ trackingNumber: '1ZBULK000000001' }],
        totalCharges: 10,
        currency: 'EUR',
      };
    },
    voidShipment: async () => ({ success: true }),
  },
});

mock.module(src('db/shipmentsRepository.js'), {
  namedExports: { saveShipment: async () => [], markVoided: async () => null },
});

mock.module(src('db/pool.js'), {
  namedExports: {
    isDbEnabled: () => true,
    query: async () => ({ rows: [] }),
    // Le mock remplace tout le module : un export manquant casse l'import
    // du routeur, même si ce test ne s'en sert pas.
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
  },
});

mock.module(src('services/activity.js'), {
  namedExports: {
    log: async () => {},
    ACTIONS: { BULK_CREATE: 'bulk.create', SHIPMENT_CREATE: 'shipment.create', SHIPMENT_VOID: 'shipment.void' },
    describeRecipient: () => 'destinataire',
  },
});

const { shippingRouter } = await import(src('routes/shipping.js'));
const { errorHandler } = await import(src('middleware/errorHandler.js'));
const { default: express } = await import('express');

async function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/api/shipping', shippingRouter);
  app.use(errorHandler);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => server.close());

  const port = server.address().port;
  return async (body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/shipping/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
}

const shipTo = {
  name: 'Antenne Lyon',
  addressLine1: '10 rue Victor Hugo',
  city: 'Lyon',
  postalCode: '69001',
  country: 'FR',
};

test('un type nommé fournit poids et dimensions', async (t) => {
  sentPackages.length = 0;
  const call = await startServer(t);

  const res = await call({
    shipments: [{ shipTo, packages: [{ packageType: 'DS620' }] }],
  });

  assert.equal(res.status, 201);
  assert.equal(sentPackages[0].weight, '12.5');
  assert.equal(sentPackages[0].length, '45');
  assert.equal(sentPackages[0].description, 'Imprimante photo DS620');
  // Le nom du type ne doit pas partir chez UPS.
  assert.equal(sentPackages[0].packageType, undefined);
});

test('la casse du nom est ignorée', async (t) => {
  sentPackages.length = 0;
  const call = await startServer(t);

  const res = await call({
    shipments: [{ shipTo, packages: [{ packageType: 'ds620' }] }],
  });

  assert.equal(res.status, 201);
  assert.equal(sentPackages[0].weight, '12.5');
});

test('une valeur explicite l emporte sur celle du type', async (t) => {
  sentPackages.length = 0;
  const call = await startServer(t);

  const res = await call({
    shipments: [{ shipTo, packages: [{ packageType: 'DS620', weight: '20' }] }],
  });

  assert.equal(res.status, 201);
  assert.equal(sentPackages[0].weight, '20', 'le poids de la ligne doit primer');
  assert.equal(sentPackages[0].length, '45', 'les autres champs viennent du type');
});

test('le code d emballage du type est transmis (palette)', async (t) => {
  sentPackages.length = 0;
  const call = await startServer(t);

  const res = await call({
    shipments: [{ shipTo, packages: [{ packageType: 'Borne Spherik' }] }],
  });

  assert.equal(res.status, 201);
  assert.equal(sentPackages[0].weight, '80');
  assert.equal(sentPackages[0].packagingType, '30');
  // Dimensions absentes du catalogue : rien ne doit être inventé.
  assert.equal(sentPackages[0].length, undefined);
});

test('un type introuvable est signalé avant toute création', async (t) => {
  sentPackages.length = 0;
  const call = await startServer(t);

  const res = await call({
    shipments: [
      { shipTo, packages: [{ packageType: 'DS620' }] },
      { shipTo, packages: [{ packageType: 'Inexistant' }] },
    ],
  });

  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /Inexistant/);
  assert.match(res.body.error.message, /introuvable/);
  // Rien ne doit être facturé si une ligne est invalide.
  assert.equal(sentPackages.length, 0, 'aucune étiquette ne doit être créée');
});

test('sans type nommé, le comportement d origine est inchangé', async (t) => {
  sentPackages.length = 0;
  const call = await startServer(t);

  const res = await call({
    shipments: [{ shipTo, packages: [{ weight: '2' }] }],
  });

  assert.equal(res.status, 201);
  assert.equal(sentPackages[0].weight, '2');
});

test('shipFrom vaut pour tout le lot', async (t) => {
  shipmentCalls.length = 0;
  const call = await startServer(t);

  const { status } = await call({
    shipFrom: {
      name: 'Depot Lyon',
      addressLine1: '9 rue A',
      city: 'Lyon',
      postalCode: '69001',
      country: 'FR',
    },
    shipments: [
      { shipTo: { name: 'A', addressLine1: '1 r', city: 'V', postalCode: '1', country: 'FR' }, packages: [{ weight: '1' }] },
      { shipTo: { name: 'B', addressLine1: '2 r', city: 'V', postalCode: '2', country: 'FR' }, packages: [{ weight: '1' }] },
    ],
  });

  assert.equal(status, 201);
  // Les deux expeditions partent de la meme adresse : elle n'est saisie
  // qu'une fois, au niveau du lot.
  assert.equal(shipmentCalls.length, 2);
  assert.equal(shipmentCalls[0].shipFrom.name, 'Depot Lyon');
  assert.equal(shipmentCalls[1].shipFrom.name, 'Depot Lyon');
});

test('un shipFrom incomplet est refuse avant tout appel UPS', async (t) => {
  shipmentCalls.length = 0;
  const call = await startServer(t);

  const { status } = await call({
    shipFrom: { name: 'Sans adresse' },
    shipments: [
      { shipTo: { name: 'A', addressLine1: '1 r', city: 'V', postalCode: '1', country: 'FR' }, packages: [{ weight: '1' }] },
    ],
  });

  assert.equal(status, 400);
  assert.equal(shipmentCalls.length, 0, 'aucune etiquette ne doit etre creee');
});
