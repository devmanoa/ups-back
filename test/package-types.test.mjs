/**
 * /api/package-types — catalogue du matériel expédié régulièrement.
 *
 * Le dépôt est simulé par des mocks de modules : aucune base nécessaire.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = (p) => pathToFileURL(path.resolve(import.meta.dirname, '../src', p)).href;

function uniqueViolation() {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
  });
}

const calls = { create: [], update: [], archive: [], markUsed: [] };
const state = { exists: true, createThrows: null };

const SAMPLE = {
  id: 3,
  label: 'DS620',
  weight: '12.5',
  length: '45',
  width: '35',
  height: '30',
  description: 'Imprimante photo DS620',
  packagingType: '02',
  isDefault: false,
  usageCount: 0,
};

mock.module(src('db/packageTypesRepository.js'), {
  namedExports: {
    listPackageTypes: async () => [SAMPLE],
    getPackageType: async () => (state.exists ? SAMPLE : null),
    createPackageType: async (input) => {
      calls.create.push(input);
      if (state.createThrows) throw state.createThrows;
      return { ...SAMPLE, ...input };
    },
    updatePackageType: async (id, input) => {
      calls.update.push({ id, ...input });
      return state.exists ? { ...SAMPLE, ...input } : null;
    },
    archivePackageType: async (id, opts) => {
      calls.archive.push({ id, ...opts });
      return state.exists ? SAMPLE : null;
    },
    restorePackageType: async () => SAMPLE,
    markUsed: async (id) => {
      calls.markUsed.push(id);
      return state.exists ? { ...SAMPLE, usageCount: 1 } : null;
    },
    findByLabel: async () => SAMPLE,
  },
});

mock.module(src('db/pool.js'), {
  namedExports: {
    isDbEnabled: () => true,
    query: async () => ({ rows: [] }),
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
  },
});

const { packageTypesRouter } = await import(src('routes/packageTypes.js'));
const { errorHandler } = await import(src('middleware/errorHandler.js'));
const { default: express } = await import('express');

async function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/api/package-types', packageTypesRouter);
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
  state.exists = true;
  state.createThrows = null;
}

test('création : le poids est obligatoire, les dimensions non', async (t) => {
  reset();
  const call = await startServer(t);

  const sansPoids = await call('POST', '/api/package-types', { label: 'DS620' });
  assert.equal(sansPoids.status, 400);
  assert.deepEqual(sansPoids.body.error.fields, ['weight']);

  // Un type sans dimensions reste utilisable : UPS ne les exige que si les
  // trois sont fournies.
  const sansDimensions = await call('POST', '/api/package-types', {
    label: 'Magnets',
    weight: '0.5',
  });
  assert.equal(sansDimensions.status, 201);
});

test('création : poids nul ou négatif refusé', async (t) => {
  reset();
  const call = await startServer(t);

  for (const weight of ['0', '-2']) {
    const res = await call('POST', '/api/package-types', { label: 'X', weight });
    assert.equal(res.status, 400, `poids ${weight} doit être refusé`);
    assert.deepEqual(res.body.error.fields, ['weight']);
  }
});

test('création : la virgule décimale est acceptée', async (t) => {
  reset();
  const call = await startServer(t);
  const res = await call('POST', '/api/package-types', { label: 'QW410', weight: '12,5' });

  assert.equal(res.status, 201);
  assert.equal(calls.create[0].weight, 12.5);
});

test('création : code d emballage inconnu refusé', async (t) => {
  reset();
  const call = await startServer(t);
  const res = await call('POST', '/api/package-types', {
    label: 'Borne',
    weight: '80',
    packagingType: '99',
  });

  assert.equal(res.status, 400);
  assert.deepEqual(res.body.error.fields, ['packagingType']);
  assert.equal(calls.create.length, 0);
});

test('création : code d emballage valide accepté (palette)', async (t) => {
  reset();
  const call = await startServer(t);
  const res = await call('POST', '/api/package-types', {
    label: 'Borne Spherik',
    weight: '80',
    packagingType: '30',
  });

  assert.equal(res.status, 201);
  assert.equal(calls.create[0].packagingType, '30');
});

test('création : un nom déjà pris renvoie un message lisible', async (t) => {
  reset();
  state.createThrows = uniqueViolation();
  const call = await startServer(t);
  const res = await call('POST', '/api/package-types', { label: 'DS620', weight: '12.5' });

  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /existe déjà/);
  assert.deepEqual(res.body.error.fields, ['label']);
});

test('modification : partielle, les champs absents ne sont pas touchés', async (t) => {
  reset();
  const call = await startServer(t);
  const res = await call('PUT', '/api/package-types/3', { weight: '13' });

  assert.equal(res.status, 200);
  assert.equal(calls.update[0].weight, 13);
  assert.equal(calls.update[0].label, undefined, 'le nom ne doit pas être réécrit');
});

test('modification : vider le poids est refusé', async (t) => {
  reset();
  const call = await startServer(t);
  const res = await call('PUT', '/api/package-types/3', { weight: '  ' });

  assert.equal(res.status, 400);
  assert.deepEqual(res.body.error.fields, ['weight']);
  assert.equal(calls.update.length, 0);
});

test('suppression : archive par défaut, supprime avec ?hard=true', async (t) => {
  reset();
  const call = await startServer(t);

  const archived = await call('DELETE', '/api/package-types/3');
  assert.equal(archived.status, 200);
  assert.equal(calls.archive[0].hard, false);
  assert.match(archived.body.message, /archivé/);

  const hard = await call('DELETE', '/api/package-types/3?hard=true');
  assert.equal(calls.archive[1].hard, true);
  assert.match(hard.body.message, /supprimé/);
});

test('type absent → 404 et non 500', async (t) => {
  reset();
  state.exists = false;
  const call = await startServer(t);

  assert.equal((await call('GET', '/api/package-types/3')).status, 404);
  assert.equal((await call('POST', '/api/package-types/3/use')).status, 404);
  assert.equal((await call('DELETE', '/api/package-types/3')).status, 404);
});

test('/packaging-codes est routé comme une liste, pas comme un identifiant', async (t) => {
  reset();
  const call = await startServer(t);
  const res = await call('GET', '/api/package-types/packaging-codes');

  assert.equal(res.status, 200);
  const codes = res.body.data.map((c) => c.code);
  assert.ok(codes.includes('02'), 'le colis client doit être proposé');
  assert.ok(codes.includes('30'), 'la palette doit être proposée');
});

test('utilisation : incrémente le compteur', async (t) => {
  reset();
  const call = await startServer(t);
  const res = await call('POST', '/api/package-types/3/use');

  assert.equal(res.status, 200);
  assert.deepEqual(calls.markUsed, [3]);
  assert.equal(res.body.data.usageCount, 1);
});
