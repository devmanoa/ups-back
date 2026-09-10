/**
 * Clés de l'API machine, créées depuis l'admin panel.
 *
 * Deux points sensibles : le jeton complet ne doit apparaître qu'une fois, et
 * une clé révoquée doit cesser d'ouvrir l'API.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = (p) => pathToFileURL(path.resolve(import.meta.dirname, '../src', p)).href;

/** Table api_keys simulée. */
const state = { keys: [], nextId: 1, dbEnabled: true };

mock.module(src('db/pool.js'), {
  namedExports: {
    isDbEnabled: () => state.dbEnabled,
    query: async () => ({ rows: [] }),
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
  },
});

mock.module(src('db/apiKeysRepository.js'), {
  namedExports: {
    generateToken: () => 'jeton-' + Math.random().toString(16).slice(2),
    previewOf: (t) => (t ? `${String(t).slice(0, 8)}••••` : null),
    latestKey: async () => {
      const active = state.keys.filter((k) => !k.revokedAt);
      const last = active[active.length - 1];
      return last ? { ...last, preview: `${last.token.slice(0, 8)}••••` } : null;
    },
    listKeys: async () =>
      state.keys
        .filter((k) => !k.revokedAt)
        .map((k) => ({ ...k, preview: `${k.token.slice(0, 8)}••••` })),
    createKey: async (clientName) => {
      // Comme le vrai dépôt : la clé précédente du même appelant est révoquée.
      for (const k of state.keys) {
        if (k.clientName.toLowerCase() === clientName.toLowerCase() && !k.revokedAt) {
          k.revokedAt = new Date().toISOString();
        }
      }
      const key = {
        id: state.nextId++,
        clientName,
        token: 'jeton-secret-' + state.nextId,
        revokedAt: null,
        useCount: 0,
        lastUsedAt: null,
        createdAt: new Date().toISOString(),
      };
      state.keys.push(key);
      return key;
    },
    revokeKey: async (id) => {
      const key = state.keys.find((k) => k.id === id && !k.revokedAt);
      if (!key) return null;
      key.revokedAt = new Date().toISOString();
      return key;
    },
    findByToken: async (token) => {
      const key = state.keys.find((k) => k.token === token && !k.revokedAt);
      return key ? { id: key.id, name: key.clientName } : null;
    },
    touchKey: (id) => {
      const key = state.keys.find((k) => k.id === id);
      if (key) key.useCount += 1;
    },
  },
});

const { adminWsRouter } = await import(src('routes/adminWs.js'));
const { resolveApiClient, requireApiKey } = await import(src('middleware/apiKey.js'));
const { errorHandler } = await import(src('middleware/errorHandler.js'));
const { default: express } = await import('express');

async function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/adminpanel/ws', adminWsRouter);
  app.use(errorHandler);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => server.close());

  const port = server.address().port;
  return async (method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
}

function reset() {
  state.keys = [];
  state.nextId = 1;
  state.dbEnabled = true;
}

test('la generation renvoie le jeton complet, une seule fois', async (t) => {
  reset();
  const call = await startServer(t);

  const created = await call('POST', '/adminpanel/ws/token', { client: 'antennes' });
  assert.equal(created.status, 201);
  assert.ok(created.body.token, 'le jeton doit etre renvoye a la creation');
  assert.equal(created.body.client, 'antennes');

  // Relu ensuite, seul l'apercu doit apparaitre : cette route n'a pas
  // d'authentification propre.
  const read = await call('GET', '/adminpanel/ws/token');
  assert.notEqual(read.body.token, created.body.token, 'le jeton complet ne doit plus sortir');
  assert.match(read.body.token, /••••/, 'un apercu masque doit etre renvoye');
});

test('sans nom, la cle porte un appelant par defaut', async (t) => {
  reset();
  const call = await startServer(t);

  // L'admin panel poste sans corps : une cle anonyme serait illisible dans
  // le journal des envois.
  const created = await call('POST', '/adminpanel/ws/token');
  assert.equal(created.status, 201);
  assert.ok(created.body.client, 'un nom d appelant est obligatoire');
});

test('generer a nouveau revoque la cle precedente du meme appelant', async (t) => {
  reset();
  const call = await startServer(t);

  const first = await call('POST', '/adminpanel/ws/token', { client: 'antennes' });
  const second = await call('POST', '/adminpanel/ws/token', { client: 'antennes' });

  assert.notEqual(first.body.token, second.body.token);
  // Sinon deux cles vaudraient pour le meme appelant, et en revoquer une ne
  // fermerait rien.
  assert.equal(await resolveApiClient(first.body.token), null, 'l ancienne doit etre fermee');
  assert.ok(await resolveApiClient(second.body.token), 'la nouvelle doit ouvrir');
});

test('deux applications gardent chacune leur cle', async (t) => {
  reset();
  const call = await startServer(t);

  const a = await call('POST', '/adminpanel/ws/token', { client: 'antennes' });
  const b = await call('POST', '/adminpanel/ws/token', { client: 'crm' });

  const clientA = await resolveApiClient(a.body.token);
  const clientB = await resolveApiClient(b.body.token);

  assert.equal(clientA?.name, 'antennes');
  assert.equal(clientB?.name, 'crm', 'la cle d une app ne doit pas revoquer celle d une autre');
});

test('une cle revoquee n ouvre plus l API', async (t) => {
  reset();
  const call = await startServer(t);

  const created = await call('POST', '/adminpanel/ws/token', { client: 'antennes' });
  assert.ok(await resolveApiClient(created.body.token));

  const keys = await call('GET', '/adminpanel/ws/token');
  const id = keys.body.keys[0].id;

  const removed = await call('DELETE', `/adminpanel/ws/token/${id}`);
  assert.equal(removed.status, 200);
  assert.equal(await resolveApiClient(created.body.token), null);
});

test('un jeton inconnu n ouvre rien', async (t) => {
  reset();
  await startServer(t);
  assert.equal(await resolveApiClient('jeton-invente'), null);
  assert.equal(await resolveApiClient(''), null);
});

test('l usage de la cle est compte a chaque appel authentifie', async (t) => {
  reset();
  const call = await startServer(t);

  const created = await call('POST', '/adminpanel/ws/token', { client: 'antennes' });

  // Compte par le middleware et non par la resolution : c'est l'appel a
  // l'API qui doit etre mesure, pas la simple recherche du jeton.
  const next = () => {};
  const res = { status: () => res, json: () => res };
  for (let i = 0; i < 2; i++) {
    await requireApiKey({ headers: { 'x-api-key': created.body.token } }, res, next);
  }

  const keys = await call('GET', '/adminpanel/ws/token');
  // Repere une cle jamais utilisee, ou toujours active alors qu'elle ne
  // sert plus.
  assert.equal(keys.body.keys[0].useCount, 2);
});

test('sans base, la generation est refusee explicitement', async (t) => {
  reset();
  state.dbEnabled = false;
  const call = await startServer(t);

  const res = await call('POST', '/adminpanel/ws/token', { client: 'antennes' });
  // Un 503 explicite plutot qu'une cle qui semble creee et disparait.
  assert.equal(res.status, 503);
});

test('une cle revoquee ne bloque pas la reprise du meme nom', async (t) => {
  reset();
  const call = await startServer(t);

  const first = await call('POST', '/adminpanel/ws/token', { client: 'antennes' });
  const keys = await call('GET', '/adminpanel/ws/token');
  await call('DELETE', `/adminpanel/ws/token/${keys.body.keys[0].id}`);

  const again = await call('POST', '/adminpanel/ws/token', { client: 'antennes' });
  assert.equal(again.status, 201, 'le nom doit rester reutilisable apres revocation');
  assert.notEqual(again.body.token, first.body.token);
});
