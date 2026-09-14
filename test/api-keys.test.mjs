/**
 * Clés de l'API machine, créées depuis l'admin panel.
 *
 * Trois points sensibles : la génération exige le rôle admin, le jeton
 * complet n'apparaît qu'une fois, et une clé révoquée cesse d'ouvrir l'API.
 *
 * Le dépôt est simulé : sans base locale, le SQL réel n'est pas exécuté ici.
 * Le mock garde les règles au minimum (empreinte, filtre des révoquées) ;
 * la règle « générer révoque la précédente » est celle du dépôt, et
 * reproduite ici pour que les tests d'API la traversent.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = (p) => pathToFileURL(path.resolve(import.meta.dirname, '../src', p)).href;

const sha = (t) => createHash('sha256').update(t).digest('hex');

/** Table api_keys simulée, avec empreintes comme en base. */
const state = { keys: [], nextId: 1, dbEnabled: true, dbDown: false, actor: null };

const ADMIN = { id: 'u-admin', name: 'Sébastien', roles: ['admin'] };
const SIMPLE = { id: 'u-simple', name: 'Julie', roles: ['user'] };

mock.module(src('db/pool.js'), {
  namedExports: {
    isDbEnabled: () => state.dbEnabled,
    query: async () => ({ rows: [] }),
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
  },
});

const publicOf = (k) => ({
  id: k.id,
  clientName: k.clientName,
  preview: `${k.prefix}… (jeton masqué, affiché à la création)`,
  revokedAt: k.revokedAt,
  lastUsedAt: k.lastUsedAt,
  useCount: k.useCount,
  createdAt: k.createdAt,
});

mock.module(src('db/apiKeysRepository.js'), {
  namedExports: {
    listKeys: async () => {
      if (state.dbDown) throw new Error('connexion refusée');
      return state.keys.filter((k) => !k.revokedAt).reverse().map(publicOf);
    },
    hasActiveKeys: async () => {
      if (state.dbDown) throw new Error('connexion refusée');
      return state.keys.some((k) => !k.revokedAt);
    },
    createKey: async (clientName) => {
      for (const k of state.keys) {
        if (k.clientName.toLowerCase() === clientName.toLowerCase() && !k.revokedAt) {
          k.revokedAt = new Date().toISOString();
        }
      }
      const token = `jeton-secret-${state.nextId}-${Math.random().toString(16).slice(2)}`;
      const key = {
        id: state.nextId++,
        clientName,
        hash: sha(token),
        prefix: token.slice(0, 8),
        revokedAt: null,
        useCount: 0,
        lastUsedAt: null,
        createdAt: new Date().toISOString(),
      };
      state.keys.push(key);
      return { ...publicOf(key), token };
    },
    revokeKey: async (id) => {
      const key = state.keys.find((k) => k.id === id && !k.revokedAt);
      if (!key) return null;
      key.revokedAt = new Date().toISOString();
      return publicOf(key);
    },
    findByToken: async (token) => {
      if (state.dbDown) throw new Error('connexion refusée');
      const key = state.keys.find((k) => k.hash === sha(String(token)) && !k.revokedAt);
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
  // Simule attachActor, qui dépend de Keycloak.
  app.use((req, res, next) => {
    req.actor = state.actor;
    next();
  });
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
  state.dbDown = false;
  state.actor = ADMIN;
}

/** Joue requireApiKey et capture ce qu'il transmet à next(). */
async function authenticate(token) {
  let passed = null;
  const req = { headers: token ? { 'x-api-key': token } : {} };
  await requireApiKey(req, {}, (err) => {
    passed = err ?? 'ok';
  });
  return { outcome: passed, actor: req.actor };
}

test('la liste des routes reste publique', async (t) => {
  reset();
  state.actor = null;
  const call = await startServer(t);

  const res = await call('GET', '/adminpanel/ws/endpoints');
  assert.equal(res.status, 200);
  assert.ok(res.body.count > 0);
});

test('sans identite, la gestion des cles est refusee', async (t) => {
  reset();
  state.actor = null;
  const call = await startServer(t);

  // Une cle ouvre un compte UPS facture : sa fabrication ne peut pas
  // dependre d'une protection situee dans un autre depot.
  const created = await call('POST', '/adminpanel/ws/token', { client: 'pirate' });
  assert.equal(created.status, 401);
  assert.equal(state.keys.length, 0, 'aucune cle ne doit avoir ete creee');

  const listed = await call('GET', '/adminpanel/ws/token');
  assert.equal(listed.status, 401);

  const removed = await call('DELETE', '/adminpanel/ws/token/1');
  assert.equal(removed.status, 401);
});

test('un utilisateur sans le role admin est refuse', async (t) => {
  reset();
  state.actor = SIMPLE;
  const call = await startServer(t);

  const res = await call('POST', '/adminpanel/ws/token', { client: 'antennes' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'ADMIN_REQUIRED');
  assert.equal(state.keys.length, 0);
});

test('la generation renvoie le jeton complet, une seule fois', async (t) => {
  reset();
  const call = await startServer(t);

  const created = await call('POST', '/adminpanel/ws/token', { client: 'antennes' });
  assert.equal(created.status, 201);
  assert.ok(created.body.token, 'le jeton doit etre renvoye a la creation');
  assert.equal(created.body.client, 'antennes');

  // Relu ensuite : le jeton n'est pas stocke, seul un apercu explicite
  // apparait, pour qu'un copier-coller ne passe pas pour un jeton valide.
  const read = await call('GET', '/adminpanel/ws/token');
  assert.notEqual(read.body.token, created.body.token);
  assert.match(read.body.token, /masqué/);
  assert.doesNotMatch(JSON.stringify(read.body), new RegExp(created.body.token));
});

test('sans nom, la cle porte un appelant par defaut', async (t) => {
  reset();
  const call = await startServer(t);

  // L'admin panel poste sans corps : une cle anonyme serait illisible dans
  // le journal des envois.
  const created = await call('POST', '/adminpanel/ws/token');
  assert.equal(created.status, 201);
  assert.ok(created.body.client);
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

  assert.equal((await resolveApiClient(a.body.token))?.name, 'antennes');
  assert.equal((await resolveApiClient(b.body.token))?.name, 'crm');
});

test('une cle revoquee n ouvre plus l API', async (t) => {
  reset();
  const call = await startServer(t);

  const created = await call('POST', '/adminpanel/ws/token', { client: 'antennes' });
  assert.ok(await resolveApiClient(created.body.token));

  const keys = await call('GET', '/adminpanel/ws/token');
  const removed = await call('DELETE', `/adminpanel/ws/token/${keys.body.keys[0].id}`);
  assert.equal(removed.status, 200);
  assert.equal(await resolveApiClient(created.body.token), null);
});

test('un identifiant invalide est une erreur de validation', async (t) => {
  reset();
  const call = await startServer(t);

  const res = await call('DELETE', '/adminpanel/ws/token/abc');
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});

test('une cle inconnue a la revocation est un 404 code', async (t) => {
  reset();
  const call = await startServer(t);

  const res = await call('DELETE', '/adminpanel/ws/token/999');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
});

test('l usage de la cle est compte a chaque appel authentifie', async (t) => {
  reset();
  const call = await startServer(t);

  const created = await call('POST', '/adminpanel/ws/token', { client: 'antennes' });
  await authenticate(created.body.token);
  await authenticate(created.body.token);

  const keys = await call('GET', '/adminpanel/ws/token');
  assert.equal(keys.body.keys[0].useCount, 2);
});

test('la cle authentifiee devient l auteur des actions', async (t) => {
  reset();
  const call = await startServer(t);

  const created = await call('POST', '/adminpanel/ws/token', { client: 'antennes' });
  const { outcome, actor } = await authenticate(created.body.token);

  assert.equal(outcome, 'ok');
  assert.equal(actor?.name, 'antennes');
  assert.equal(actor?.type, 'api');
});

test('un jeton faux est un 401, quand des cles existent', async (t) => {
  reset();
  const call = await startServer(t);
  await call('POST', '/adminpanel/ws/token', { client: 'antennes' });

  const { outcome } = await authenticate('jeton-invente');
  assert.equal(outcome.status, 401);
  assert.equal(outcome.code, 'INVALID_API_KEY');
});

test('sans aucune cle, l API repond non configuree plutot que cle invalide', async (t) => {
  reset();
  await startServer(t);

  // Dire << cle invalide >> enverrait l'integrateur verifier un jeton
  // correct, alors que c'est le serveur qui n'en a aucune.
  const { outcome } = await authenticate('nimporte-quoi');
  assert.equal(outcome.status, 503);
  assert.equal(outcome.code, 'API_KEYS_NOT_CONFIGURED');
});

test('base en panne : 503, jamais << cle invalide >>', async (t) => {
  reset();
  const call = await startServer(t);
  const created = await call('POST', '/adminpanel/ws/token', { client: 'antennes' });

  state.dbDown = true;
  // Un partenaire a la cle valide ne doit pas la croire fausse pendant une
  // panne : il la ferait tourner pour rien, ou cesserait de reessayer.
  const { outcome } = await authenticate(created.body.token);
  assert.equal(outcome.status, 503);
  assert.equal(outcome.code, 'API_KEYS_UNAVAILABLE');
});

test('sans base, la generation est refusee explicitement', async (t) => {
  reset();
  state.dbEnabled = false;
  const call = await startServer(t);

  const res = await call('POST', '/adminpanel/ws/token', { client: 'antennes' });
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'DB_NOT_CONFIGURED');
});

test('une cle revoquee ne bloque pas la reprise du meme nom', async (t) => {
  reset();
  const call = await startServer(t);

  const first = await call('POST', '/adminpanel/ws/token', { client: 'antennes' });
  const keys = await call('GET', '/adminpanel/ws/token');
  await call('DELETE', `/adminpanel/ws/token/${keys.body.keys[0].id}`);

  const again = await call('POST', '/adminpanel/ws/token', { client: 'antennes' });
  assert.equal(again.status, 201);
  assert.notEqual(again.body.token, first.body.token);
});
