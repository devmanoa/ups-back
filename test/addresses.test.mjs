/**
 * /api/addresses — validation et comportement du carnet d'adresses.
 *
 * Le dépôt est simulé par des mocks de modules : aucune base PostgreSQL
 * n'est nécessaire. Lancement : npm test.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = (p) => pathToFileURL(path.resolve(import.meta.dirname, '../src', p)).href;

/** Violation d'unicité PostgreSQL, telle que la remonte le pilote pg. */
function uniqueViolation() {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
  });
}

/** État partagé entre les mocks et les assertions, remis à zéro par test. */
const calls = { create: [], update: [], archive: [], markUsed: [], list: [] };
const state = { groups: [1], createThrows: null, addressExists: true };

const SAMPLE = {
  id: 7,
  label: 'Antenne Lyon',
  groupId: 1,
  name: 'Antenne Lyon Part-Dieu',
  addressLine1: '10 rue Victor Hugo',
  city: 'Lyon',
  postalCode: '69001',
  country: 'FR',
  isDefault: false,
  usageCount: 0,
};

mock.module(src('db/addressesRepository.js'), {
  namedExports: {
    listAddresses: async (params) => {
      calls.list.push(params);
      return [SAMPLE];
    },
    getAddress: async () => (state.addressExists ? SAMPLE : null),
    createAddress: async (input) => {
      calls.create.push(input);
      if (state.createThrows) throw state.createThrows;
      return { ...SAMPLE, ...input };
    },
    updateAddress: async (id, input) => {
      calls.update.push({ id, ...input });
      return state.addressExists ? { ...SAMPLE, ...input } : null;
    },
    archiveAddress: async (id, opts) => {
      calls.archive.push({ id, ...opts });
      return state.addressExists ? SAMPLE : null;
    },
    restoreAddress: async () => SAMPLE,
    markUsed: async (id) => {
      calls.markUsed.push(id);
      return state.addressExists ? { ...SAMPLE, usageCount: 1 } : null;
    },
    listGroups: async () => [{ id: 1, name: 'Antennes', addressCount: 3 }],
    createGroup: async ({ name }) => ({ id: 2, name, position: 1 }),
    updateGroup: async (id, patch) => ({ id, ...patch }),
    getGroup: async (id) => ({ id, name: 'Antennes' }),
    deleteGroup: async (id) => ({ id, name: 'Antennes' }),
    groupExists: async (id) => state.groups.includes(Number(id)),
  },
});

mock.module(src('db/pool.js'), {
  namedExports: {
    isDbEnabled: () => true,
    query: async () => ({ rows: [] }),
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
  },
});

const { addressesRouter } = await import(src('routes/addresses.js'));
const { errorHandler } = await import(src('middleware/errorHandler.js'));
const { default: express } = await import('express');

/** Monte le routeur seul et renvoie une fonction d'appel HTTP réelle. */
async function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/api/addresses', addressesRouter);
  app.use(errorHandler);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => server.close());

  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
}

function reset() {
  for (const key of Object.keys(calls)) calls[key].length = 0;
  state.groups = [1];
  state.createThrows = null;
  state.addressExists = true;
}

test('création : les champs obligatoires manquants sont refusés', async (t) => {
  reset();
  const call = await startServer(t);
  const { status, body } = await call('POST', '/api/addresses', { label: 'Antenne Lyon' });

  assert.equal(status, 400);
  assert.equal(body.success, false);
  // Les champs exigés sont ceux que l'API Shipping réclame.
  assert.deepEqual(body.error.fields.sort(), ['addressLine1', 'city', 'country', 'name', 'postalCode']);
  assert.equal(calls.create.length, 0, 'aucune écriture ne doit être tentée');
});

test('création : normalise le pays et rogne les espaces', async (t) => {
  reset();
  const call = await startServer(t);
  const { status } = await call('POST', '/api/addresses', {
    label: '  Antenne Lyon  ',
    name: '  Antenne Lyon Part-Dieu ',
    addressLine1: '10 rue Victor Hugo',
    city: ' Lyon ',
    postalCode: ' 69001 ',
    country: 'fr',
  });

  assert.equal(status, 201);
  assert.equal(calls.create[0].label, 'Antenne Lyon');
  assert.equal(calls.create[0].name, 'Antenne Lyon Part-Dieu');
  assert.equal(calls.create[0].city, 'Lyon');
  assert.equal(calls.create[0].postalCode, '69001');
  assert.equal(calls.create[0].country, 'FR');
});

test('création : un pays hors ISO 2 est refusé', async (t) => {
  reset();
  const call = await startServer(t);
  const { status, body } = await call('POST', '/api/addresses', {
    label: 'X',
    name: 'X',
    addressLine1: 'X',
    city: 'X',
    postalCode: '1',
    country: 'France',
  });

  assert.equal(status, 400);
  assert.deepEqual(body.error.fields, ['country']);
});

test('création : un groupe inexistant est refusé plutôt qu écrit', async (t) => {
  reset();
  const call = await startServer(t);
  const { status, body } = await call('POST', '/api/addresses', {
    ...SAMPLE,
    groupId: 999,
  });

  assert.equal(status, 400);
  assert.deepEqual(body.error.fields, ['groupId']);
  assert.equal(calls.create.length, 0);
});

test('création : un nom déjà pris renvoie un message lisible', async (t) => {
  reset();
  state.createThrows = uniqueViolation();
  const call = await startServer(t);
  const { status, body } = await call('POST', '/api/addresses', SAMPLE);

  assert.equal(status, 400);
  assert.match(body.error.message, /existe déjà/);
  assert.deepEqual(body.error.fields, ['label']);
});

test('modification : un champ obligatoire vidé est refusé', async (t) => {
  reset();
  const call = await startServer(t);
  const { status, body } = await call('PUT', '/api/addresses/7', { city: '   ' });

  assert.equal(status, 400);
  assert.deepEqual(body.error.fields, ['city']);
  assert.equal(calls.update.length, 0);
});

test('modification : partielle, les champs absents ne sont pas touchés', async (t) => {
  reset();
  const call = await startServer(t);
  const { status } = await call('PUT', '/api/addresses/7', { city: 'Villeurbanne' });

  assert.equal(status, 200);
  assert.equal(calls.update[0].city, 'Villeurbanne');
  assert.equal(calls.update[0].name, undefined, 'le nom ne doit pas être réécrit');
});

test('suppression : archive par défaut, supprime avec ?hard=true', async (t) => {
  reset();
  const call = await startServer(t);

  const archived = await call('DELETE', '/api/addresses/7');
  assert.equal(archived.status, 200);
  assert.equal(calls.archive[0].hard, false);
  assert.match(archived.body.message, /archivée/);

  const hard = await call('DELETE', '/api/addresses/7?hard=true');
  assert.equal(hard.status, 200);
  assert.equal(calls.archive[1].hard, true);
  assert.match(hard.body.message, /supprimée/);
});

test('adresse absente → 404 et non 500', async (t) => {
  reset();
  state.addressExists = false;
  const call = await startServer(t);

  assert.equal((await call('GET', '/api/addresses/7')).status, 404);
  assert.equal((await call('POST', '/api/addresses/7/use')).status, 404);
  assert.equal((await call('DELETE', '/api/addresses/7')).status, 404);
});

test('identifiant non numérique → 400 sans appel au dépôt', async (t) => {
  reset();
  const call = await startServer(t);
  const { status, body } = await call('GET', '/api/addresses/abc');

  assert.equal(status, 400);
  assert.match(body.error.message, /invalide/);
});

test('/groups est routé comme un groupe, pas comme un identifiant', async (t) => {
  reset();
  const call = await startServer(t);
  const { status, body } = await call('GET', '/api/addresses/groups');

  assert.equal(status, 200);
  assert.equal(body.data[0].name, 'Antennes');
  assert.equal(body.data[0].addressCount, 3);
});

test('groupe : nom vide refusé, doublon signalé', async (t) => {
  reset();
  const call = await startServer(t);

  const empty = await call('POST', '/api/addresses/groups', { name: '   ' });
  assert.equal(empty.status, 400);

  const missing = await call('POST', '/api/addresses/groups', {});
  assert.equal(missing.status, 400);
});

test('suppression de groupe : annonce que les adresses sont conservées', async (t) => {
  reset();
  const call = await startServer(t);
  const { status, body } = await call('DELETE', '/api/addresses/groups/1');

  assert.equal(status, 200);
  assert.match(body.message, /conservées/);
});

test('utilisation : incrémente le compteur de l adresse', async (t) => {
  reset();
  const call = await startServer(t);
  const { status, body } = await call('POST', '/api/addresses/7/use');

  assert.equal(status, 200);
  assert.deepEqual(calls.markUsed, [7]);
  assert.equal(body.data.usageCount, 1);
});

test('liste : transmet recherche, groupe et archivées au dépôt', async (t) => {
  reset();
  const call = await startServer(t);
  await call('GET', '/api/addresses?search=lyon&groupId=1&includeArchived=true');

  assert.equal(calls.list[0].search, 'lyon');
  assert.equal(calls.list[0].groupId, '1');
  assert.equal(calls.list[0].includeArchived, true);
});
