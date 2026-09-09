/**
 * Mentions « @collègue » dans un commentaire.
 *
 * Le point sensible est la provenance des destinataires : ils sont relus
 * depuis le HTML et vérifiés auprès de Keycloak, jamais reçus du client.
 * Sans cela, n'importe qui pourrait notifier n'importe qui.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = (p) => pathToFileURL(path.resolve(import.meta.dirname, '../src', p)).href;

/** Annuaire simulé : seuls ces comptes existent. */
const ANNUAIRE = {
  'uid-julie': { id: 'uid-julie', name: 'Julie Rault', email: 'julie@x.fr' },
  'uid-seb': { id: 'uid-seb', name: 'Sébastien Mahé', email: 'seb@x.fr' },
};

const state = { actor: null, mentions: [], notified: [], notifyFails: false, nextId: 1 };

mock.module(src('services/directory.js'), {
  namedExports: {
    isDirectoryConfigured: () => true,
    searchUsers: async (term) =>
      Object.values(ANNUAIRE).filter((u) => u.name.toLowerCase().includes(term.toLowerCase())),
    findUsersByIds: async (ids) => ids.map((id) => ANNUAIRE[id]).filter(Boolean),
    directoryStatus: () => ({ configured: true }),
  },
});

mock.module(src('services/notifications.js'), {
  namedExports: {
    isNotificationsConfigured: () => true,
    notifyMention: async ({ mention }) => {
      if (state.notifyFails) throw new Error('service indisponible');
      state.notified.push(mention.user.id);
      return { sent: true };
    },
    excerptOf: (html) => String(html).replace(/<[^>]+>/g, ''),
  },
});

mock.module(src('db/mentionsRepository.js'), {
  namedExports: {
    addMentions: async ({ commentId, trackingNumber, users }) => {
      const created = users.map((user) => ({
        id: state.nextId++,
        commentId,
        trackingNumber,
        user,
        notifiedAt: null,
      }));
      state.mentions.push(...created);
      return created;
    },
    listByComments: async () => ({}),
    listByComment: async () => [],
    markNotified: async () => {},
    markNotifyError: async () => {},
    listPendingNotifications: async () => [],
  },
});

mock.module(src('db/commentsRepository.js'), {
  namedExports: {
    MAX_BODY: 2000,
    listComments: async () => [],
    addComment: async ({ trackingNumber, body, actor }) => ({
      id: 42,
      trackingNumber,
      body,
      createdAt: new Date().toISOString(),
      actor,
    }),
    deleteComment: async () => 'not_found',
    countByTracking: async () => ({}),
  },
});

mock.module(src('db/pool.js'), {
  namedExports: {
    isDbEnabled: () => true,
    query: async () => ({ rows: [] }),
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
  },
});

mock.module(src('db/activityRepository.js'), {
  namedExports: {
    findCreator: async () => null,
    findCreators: async () => ({}),
    listActivity: async () => ({ total: 0, entries: [] }),
  },
});

mock.module(src('db/shipmentsRepository.js'), {
  namedExports: {
    listShipments: async () => ({ total: 0, shipments: [] }),
    listOpenShipments: async () => [],
    getShipmentByTracking: async () => ({ trackingNumber: '1Z999', localShipmentId: 'local-1' }),
    listPackagesOfShipment: async () => [],
    updateStatus: async () => null,
    countByStatus: async () => ({}),
    getStats: async () => ({}),
    getLabel: async () => null,
    listLabelsOfShipment: async () => [],
    isPlaceholderTracking: (t) => /X{6,}/i.test(String(t ?? '')),
  },
});

const { shipmentsRouter } = await import(src('routes/shipments.js'));
const { usersRouter } = await import(src('routes/users.js'));
const { errorHandler } = await import(src('middleware/errorHandler.js'));
const { parseMentionIds } = await import(src('services/mentions.js'));
const { default: express } = await import('express');

async function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.actor = state.actor;
    next();
  });
  app.use('/api/shipments', shipmentsRouter);
  app.use('/api/users', usersRouter);
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
  state.actor = { id: 'uid-seb', name: 'Sébastien Mahé' };
  state.mentions = [];
  state.notified = [];
  state.notifyFails = false;
  state.nextId = 1;
}

/** Laisse partir les notifications, envoyées hors du cycle de la requête. */
const settle = () => new Promise((r) => setTimeout(r, 20));

const MENTION_JULIE = '<p>Vu avec <span data-mention="uid-julie">@Julie</span></p>';

test('une mention est extraite du HTML du commentaire', () => {
  assert.deepEqual(parseMentionIds(MENTION_JULIE), ['uid-julie']);
});

test('une personne citee deux fois n est mentionnee qu une fois', () => {
  const html = `${MENTION_JULIE}${MENTION_JULIE}`;
  // Sinon elle recevrait deux notifications pour un seul commentaire.
  assert.deepEqual(parseMentionIds(html), ['uid-julie']);
});

test('un commentaire sans mention n en produit aucune', () => {
  assert.deepEqual(parseMentionIds('<p>Colis parti ce matin</p>'), []);
});

test('la mention est enregistree et notifiee', async (t) => {
  reset();
  const call = await startServer(t);

  const { status, body } = await call('POST', '/api/shipments/1Z999/comments', {
    body: MENTION_JULIE,
  });

  assert.equal(status, 201);
  assert.deepEqual(body.data.mentions.map((m) => m.id), ['uid-julie']);

  await settle();
  assert.deepEqual(state.notified, ['uid-julie']);
});

test('un identifiant inconnu de Keycloak est ignore', async (t) => {
  reset();
  const call = await startServer(t);

  const { status, body } = await call('POST', '/api/shipments/1Z999/comments', {
    body: '<p><span data-mention="uid-inexistant">@Fantome</span></p>',
  });

  // Le commentaire reste publiable : un compte peut avoir ete supprime.
  assert.equal(status, 201);
  assert.equal(body.data.mentions.length, 0);
});

test('le client ne choisit pas les destinataires', async (t) => {
  reset();
  const call = await startServer(t);

  const { status, body } = await call('POST', '/api/shipments/1Z999/comments', {
    body: '<p>Rien a signaler</p>',
    // Champ force dans la requete : il ne doit avoir aucun effet, sinon
    // n'importe qui pourrait notifier n'importe qui.
    mentions: [{ id: 'uid-julie' }],
    mentionIds: ['uid-julie'],
  });

  assert.equal(status, 201);
  assert.equal(body.data.mentions.length, 0, 'seul le HTML fait foi');

  await settle();
  assert.deepEqual(state.notified, [], 'aucune notification ne doit partir');
});

test('l auteur ne se notifie pas lui-meme', async (t) => {
  reset();
  const call = await startServer(t);

  const { body } = await call('POST', '/api/shipments/1Z999/comments', {
    body: '<p><span data-mention="uid-seb">@Sebastien</span> note pour moi</p>',
  });

  assert.equal(body.data.mentions.length, 0);
  await settle();
  assert.deepEqual(state.notified, []);
});

test('une panne des notifications ne perd pas le commentaire', async (t) => {
  reset();
  state.notifyFails = true;
  const call = await startServer(t);

  const { status, body } = await call('POST', '/api/shipments/1Z999/comments', {
    body: MENTION_JULIE,
  });

  // Le commentaire est enregistre malgre l'echec : une panne du service de
  // notifications ne doit pas empecher de commenter.
  assert.equal(status, 201);
  assert.equal(body.data.id, 42);
  assert.equal(body.data.mentions.length, 1);

  await settle();
  assert.deepEqual(state.notified, []);
});

test('l annuaire repond a la recherche', async (t) => {
  reset();
  const call = await startServer(t);

  const { status, body } = await call('GET', '/api/users?search=julie');

  assert.equal(status, 200);
  assert.equal(body.data.configured, true);
  assert.deepEqual(body.data.users.map((u) => u.id), ['uid-julie']);
});
