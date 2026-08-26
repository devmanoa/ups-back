/**
 * L'adresse de départ vient du carnet quand une adresse y est marquée
 * « départ par défaut ».
 *
 * Le carnet prime sur les variables SHIPPER_* : il se change depuis
 * l'interface, là où la configuration exige un redéploiement.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = (p) => pathToFileURL(path.resolve(import.meta.dirname, '../src', p)).href;

process.env.SHIPPER_NAME = 'Adresse de configuration';
process.env.SHIPPER_ADDRESS_LINE = '1 rue Config';
process.env.SHIPPER_CITY = 'Config-Ville';
process.env.SHIPPER_POSTAL_CODE = '00000';

const state = { addresses: [], dbEnabled: true, fail: false };

mock.module(src('db/pool.js'), {
  namedExports: {
    isDbEnabled: () => state.dbEnabled,
    query: async () => ({ rows: [] }),
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
  },
});

mock.module(src('db/addressesRepository.js'), {
  namedExports: {
    listAddresses: async () => {
      if (state.fail) throw new Error('carnet injoignable');
      return { addresses: state.addresses, count: state.addresses.length };
    },
  },
});

const { shippingRouter } = await import(src('routes/shipping.js'));
const { errorHandler } = await import(src('middleware/errorHandler.js'));
const { default: express } = await import('express');

async function call(t) {
  const app = express();
  app.use('/api/shipping', shippingRouter);
  app.use(errorHandler);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/shipping/shipper`);
  return res.json();
}

test('une adresse du carnet marquee prime sur la configuration', async (t) => {
  state.fail = false;
  state.addresses = [
    { id: 1, name: 'Autre depot', addressLine1: '9 rue A', city: 'Lyon', postalCode: '69001', country: 'FR', isDefaultShipper: false },
    { id: 2, name: 'SAS KONITYS', addressLine1: '2 place Konrad Adenauer', city: 'Plerin', postalCode: '22190', country: 'FR', isDefaultShipper: true },
  ];

  const body = await call(t);

  assert.equal(body.data.shipper.name, 'SAS KONITYS');
  assert.equal(body.data.source, 'address-book');
  assert.equal(body.data.addressId, 2);
});

test('sans adresse marquee, la configuration sert de repli', async (t) => {
  state.fail = false;
  state.addresses = [
    { id: 1, name: 'Un client', addressLine1: '9 rue A', city: 'Lyon', postalCode: '69001', country: 'FR', isDefaultShipper: false },
  ];

  const body = await call(t);

  assert.equal(body.data.shipper.name, 'Adresse de configuration');
  assert.equal(body.data.source, 'config');
});

test('un carnet injoignable ne prive pas d adresse de depart', async (t) => {
  state.fail = true;
  state.addresses = [];

  // Le carnet en panne ne doit pas empecher de creer une etiquette : on
  // retombe sur la configuration plutot que de renvoyer une erreur.
  const body = await call(t);

  assert.equal(body.success, true);
  assert.equal(body.data.source, 'config');
});

test('sans base, la configuration est utilisee directement', async (t) => {
  state.dbEnabled = false;
  state.addresses = [];

  const body = await call(t);
  assert.equal(body.data.source, 'config');

  state.dbEnabled = true;
});
