/**
 * API machine — /api/v1.
 *
 * Le point sensible est la clé : chaque appel accepté engage une facturation
 * UPS. Un appel non authentifié ne doit donc jamais atteindre UPS, et la clé
 * ne doit apparaître dans aucune réponse.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = (p) => pathToFileURL(path.resolve(import.meta.dirname, '../src', p)).href;

const KEY = 'cle-secrete-de-test';

// Défini avant l'import de config.js, qui lit l'environnement au chargement.
process.env.API_KEYS = `antennes:${KEY}`;

/** Appels parvenus jusqu'à UPS. Vide = rien n'a été facturé. */
const upsCalls = [];
/** Envois enregistrés en base. */
const saved = [];
/** Entrées de journal. */
const logged = [];

mock.module(src('services/shipping.js'), {
  namedExports: {
    LABEL_FORMATS: {
      GIF: { code: 'GIF', mime: 'image/gif', ext: 'gif' },
      PDF: { code: 'PDF', mime: 'application/pdf', ext: 'pdf' },
    },
    createShipment: async (payload) => {
      upsCalls.push(payload);
      if (payload.shipTo?.name === 'ADRESSE REFUSEE') {
        throw Object.assign(new Error('Adresse invalide'), { upsCodes: ['120205'] });
      }
      return {
        shipmentIdentificationNumber: '1ZSHIP001',
        packages: [
          { trackingNumber: '1ZPKG001', label: { base64: 'QUFB', mime: 'image/gif', ext: 'gif' } },
        ],
        totalCharges: 12.5,
        currency: 'EUR',
        billingWeight: '2 KGS',
        shipper: { name: 'Selfizee' },
      };
    },
    voidShipment: async (id) => ({ success: true, shipmentId: id }),
  },
});

mock.module(src('db/shipmentsRepository.js'), {
  namedExports: {
    saveShipment: async (payload) => {
      saved.push(payload);
      return [{ localShipmentId: 'local-api-1' }];
    },
    markVoided: async () => [{ localShipmentId: 'local-api-1' }],
    getShipmentByTracking: async (id) =>
      id === 'local-api-1'
        ? {
            localShipmentId: 'local-api-1',
            shipmentId: '1ZSHIP001',
            trackingNumber: '1ZPKG001',
            status: 'created',
            recipientName: 'Antenne Lyon',
            recipientCity: 'Lyon',
            recipientPostal: '69001',
            recipientCountry: 'FR',
            createdAt: '2026-09-02T10:00:00Z',
          }
        : null,
    listPackagesOfShipment: async () => [{ trackingNumber: '1ZPKG001' }],
    getLabel: async () => null,
    listLabelsOfShipment: async (id) =>
      id === 'local-api-1'
        ? [{ trackingNumber: '1ZPKG001', format: 'GIF', base64: 'QUFB' }]
        : [],
    listShipments: async () => ({ total: 0, shipments: [] }),
    listOpenShipments: async () => [],
    updateStatus: async () => null,
    countByStatus: async () => ({}),
    getStats: async () => ({}),
    isPlaceholderTracking: (t) => /X{6,}/i.test(String(t ?? '')),
  },
});

mock.module(src('db/batchesRepository.js'), {
  namedExports: {
    listBatches: async () => ({ total: 0, batches: [] }),
    getBatch: async (id) =>
      id === 'batch-connu'
        ? {
            batchId: 'batch-connu',
            createdAt: '2026-09-02T10:00:00Z',
            shipmentCount: 1,
            counts: { created: 1, inTransit: 0, delivered: 0, exception: 0, voided: 0 },
            completed: false,
            shipments: [
              {
                localShipmentId: 'local-api-1',
                shipmentId: '1ZSHIP001',
                trackingNumber: '1ZPKG001',
                status: 'created',
                recipientName: 'Antenne Lyon',
                recipientCity: 'Lyon',
                recipientPostal: '69001',
                recipientCountry: 'FR',
                createdAt: '2026-09-02T10:00:00Z',
              },
            ],
          }
        : null,
  },
});

mock.module(src('db/packageTypesRepository.js'), {
  namedExports: {
    findByLabel: async (label) =>
      String(label).toLowerCase() === 'ds620'
        ? { weight: '12.5', length: '45', width: '35', height: '30', description: 'Imprimante', packagingType: '02' }
        : null,
  },
});

mock.module(src('db/pool.js'), {
  namedExports: {
    isDbEnabled: () => true,
    query: async () => ({ rows: [] }),
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
  },
});

mock.module(src('services/timeInTransit.js'), {
  namedExports: { getTransitTimes: async () => ({ services: [] }) },
});

mock.module(src('services/activity.js'), {
  namedExports: {
    log: async (req, entry) => {
      logged.push({ ...entry, actor: req?.actor ?? null });
    },
    ACTIONS: {
      SHIPMENT_CREATE: 'shipment.create',
      SHIPMENT_VOID: 'shipment.void',
      BULK_CREATE: 'bulk.create',
    },
    describeRecipient: (s) => s?.name ?? 'destinataire',
  },
});

const { publicApiRouter } = await import(src('routes/publicApi.js'));
const { errorHandler } = await import(src('middleware/errorHandler.js'));
const { default: express } = await import('express');

async function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', publicApiRouter);
  app.use(errorHandler);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => server.close());

  const port = server.address().port;
  return async (method, url, { body, key } = {}) => {
    const headers = {};
    if (body) headers['content-type'] = 'application/json';
    if (key) headers['x-api-key'] = key;

    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      text,
      body: text.startsWith('{') ? JSON.parse(text) : null,
    };
  };
}

function reset() {
  upsCalls.length = 0;
  saved.length = 0;
  logged.length = 0;
}

const shipTo = {
  name: 'Antenne Lyon',
  addressLine1: '10 rue Victor Hugo',
  city: 'Lyon',
  postalCode: '69001',
  country: 'FR',
};

test('sans cle, aucun appel n atteint UPS', async (t) => {
  reset();
  const call = await startServer(t);

  const { status } = await call('POST', '/api/v1/shipments', {
    body: { shipTo, packages: [{ weight: '2' }] },
  });

  assert.equal(status, 401);
  // Le point vital : une etiquette creee est facturee, meme refusee ensuite.
  assert.equal(upsCalls.length, 0, 'aucune etiquette ne doit etre facturee');
});

test('une mauvaise cle est refusee', async (t) => {
  reset();
  const call = await startServer(t);

  const { status, body } = await call('POST', '/api/v1/shipments', {
    key: 'mauvaise-cle',
    body: { shipTo, packages: [{ weight: '2' }] },
  });

  assert.equal(status, 401);
  assert.equal(body.error.code, 'INVALID_API_KEY');
  assert.equal(upsCalls.length, 0);
});

test('la cle valide n apparait dans aucune reponse', async (t) => {
  reset();
  const call = await startServer(t);

  const ping = await call('GET', '/api/v1/ping', { key: KEY });
  const refus = await call('POST', '/api/v1/shipments', { key: 'mauvaise-cle', body: {} });

  assert.equal(ping.status, 200);
  // Renvoyer la cle, meme dans un message d'erreur, la ferait fuir dans les
  // journaux de l'application appelante.
  assert.ok(!ping.text.includes(KEY), 'la cle ne doit pas etre renvoyee');
  assert.ok(!refus.text.includes(KEY), 'la cle ne doit pas fuiter dans une erreur');
});

test('une etiquette est creee et renvoyee en base64 et par URL', async (t) => {
  reset();
  const call = await startServer(t);

  const { status, body } = await call('POST', '/api/v1/shipments', {
    key: KEY,
    body: { shipTo, packages: [{ weight: '2' }], serviceCode: '11' },
  });

  assert.equal(status, 201);
  assert.equal(body.data.trackingNumbers[0], '1ZPKG001');
  assert.equal(body.data.labels[0].base64, 'QUFB', 'base64 pour impression immediate');
  assert.equal(
    body.data.labelUrl,
    '/api/v1/shipments/local-api-1/label',
    'URL pour la recuperer plus tard',
  );
});

test('l application appelante est nommee dans le journal', async (t) => {
  reset();
  const call = await startServer(t);

  await call('POST', '/api/v1/shipments', {
    key: KEY,
    body: { shipTo, packages: [{ weight: '2' }] },
  });

  // Sans cela, les envois d'une autre application seraient anonymes dans
  // l'historique, exactement comme le « Utilisateur inconnu » de Keycloak.
  assert.equal(logged[0].actor.name, 'antennes');
  assert.equal(logged[0].metadata.client, 'antennes');
});

test('la reference de l appelant est conservee', async (t) => {
  reset();
  const call = await startServer(t);

  await call('POST', '/api/v1/shipments', {
    key: KEY,
    body: { shipTo, packages: [{ weight: '2' }], reference: 'CMD-4321' },
  });

  // C'est par elle que l'application appelante relie l'envoi a sa commande.
  assert.equal(saved[0].shipTo.reference, 'CMD-4321');
});

test('un type de colis nomme evite de repeter poids et dimensions', async (t) => {
  reset();
  const call = await startServer(t);

  const { status } = await call('POST', '/api/v1/shipments', {
    key: KEY,
    body: { shipTo, packages: [{ packageType: 'DS620' }] },
  });

  assert.equal(status, 201);
  assert.equal(upsCalls[0].packages[0].weight, '12.5');
  // Le nom du type ne doit pas partir chez UPS.
  assert.equal(upsCalls[0].packages[0].packageType, undefined);
});

test('un colis sans poids ni type est refuse avant UPS', async (t) => {
  reset();
  const call = await startServer(t);

  const { status } = await call('POST', '/api/v1/shipments', {
    key: KEY,
    body: { shipTo, packages: [{}] },
  });

  assert.equal(status, 400);
  assert.equal(upsCalls.length, 0);
});

test('une commande cree plusieurs expeditions en un appel', async (t) => {
  reset();
  const call = await startServer(t);

  const { status, body } = await call('POST', '/api/v1/orders', {
    key: KEY,
    body: {
      shipments: [
        { shipTo, packages: [{ weight: '1' }] },
        { shipTo: { ...shipTo, name: 'Antenne Paris' }, packages: [{ weight: '1' }] },
      ],
    },
  });

  assert.equal(status, 201);
  assert.equal(body.data.created, 2);
  assert.equal(body.data.failed, 0);
  assert.ok(body.data.orderId);
});

test('une commande partiellement en echec renvoie 207', async (t) => {
  reset();
  const call = await startServer(t);

  const { status, body } = await call('POST', '/api/v1/orders', {
    key: KEY,
    body: {
      shipments: [
        { shipTo, packages: [{ weight: '1' }] },
        { shipTo: { ...shipTo, name: 'ADRESSE REFUSEE' }, packages: [{ weight: '1' }] },
      ],
    },
  });

  // 201 laisserait croire que tout est passe, 502 ferait ignorer l'etiquette
  // deja facturee : les deux menent a un doublon au reessai.
  assert.equal(status, 207);
  assert.equal(body.data.created, 1);
  assert.equal(body.data.failed, 1);
  assert.equal(body.data.results[1].ok, false);
  assert.deepEqual(body.data.results[1].upsCodes, ['120205']);
});

test('une ligne invalide annule la commande avant tout appel UPS', async (t) => {
  reset();
  const call = await startServer(t);

  const { status } = await call('POST', '/api/v1/orders', {
    key: KEY,
    body: {
      shipments: [
        { shipTo, packages: [{ weight: '1' }] },
        { shipTo: { name: 'Sans adresse' }, packages: [{ weight: '1' }] },
      ],
    },
  });

  assert.equal(status, 400);
  // La premiere ligne est valide : sans validation prealable, son etiquette
  // serait facturee avant que la seconde n'echoue.
  assert.equal(upsCalls.length, 0, 'aucune etiquette ne doit etre facturee');
});

test('l etiquette se recupere en binaire', async (t) => {
  reset();
  const call = await startServer(t);

  const { status, contentType, text } = await call(
    'GET',
    '/api/v1/shipments/local-api-1/label?format=binary',
    { key: KEY },
  );

  assert.equal(status, 200);
  assert.equal(contentType, 'image/gif');
  // « QUFB » est « AAA » en base64 : l'appelant recoit le fichier decode.
  assert.equal(text, 'AAA');
});

test('l etiquette se recupere aussi en base64', async (t) => {
  reset();
  const call = await startServer(t);

  const { status, body } = await call('GET', '/api/v1/shipments/local-api-1/label', { key: KEY });

  assert.equal(status, 200);
  assert.equal(body.data.labels[0].base64, 'QUFB');
});

test('un envoi inconnu renvoie 404', async (t) => {
  reset();
  const call = await startServer(t);

  const { status } = await call('GET', '/api/v1/shipments/inexistant', { key: KEY });
  assert.equal(status, 404);
});

test('une commande se relit apres coup', async (t) => {
  reset();
  const call = await startServer(t);

  const { status, body } = await call('GET', '/api/v1/orders/batch-connu', { key: KEY });

  assert.equal(status, 200);
  assert.equal(body.data.total, 1);
  assert.equal(body.data.completed, false);
  assert.equal(body.data.shipments[0].trackingNumbers[0], '1ZPKG001');
});

test('une expedition s annule', async (t) => {
  reset();
  const call = await startServer(t);

  const { status, body } = await call('DELETE', '/api/v1/shipments/1ZSHIP001', { key: KEY });

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(logged[0].action, 'shipment.void');
  assert.equal(logged[0].actor.name, 'antennes');
});

test('l annulation exige aussi la cle', async (t) => {
  reset();
  const call = await startServer(t);

  const { status } = await call('DELETE', '/api/v1/shipments/1ZSHIP001');
  assert.equal(status, 401);
});
