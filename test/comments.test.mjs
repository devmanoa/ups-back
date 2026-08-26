/**
 * Commentaires attachés à un envoi.
 *
 * Le point sensible est la suppression : un commentaire n'appartient qu'à son
 * auteur, et sans identité vérifiée personne ne doit pouvoir en effacer un.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = (p) => pathToFileURL(path.resolve(import.meta.dirname, '../src', p)).href;

const state = { dbEnabled: true, actor: null, comments: [], nextId: 1 };

mock.module(src('db/pool.js'), {
  namedExports: {
    isDbEnabled: () => state.dbEnabled,
    query: async () => ({ rows: [] }),
  },
});

mock.module(src('db/commentsRepository.js'), {
  namedExports: {
    MAX_BODY: 2000,
    listComments: async (tracking) => state.comments.filter((c) => c.trackingNumber === tracking),
    addComment: async ({ trackingNumber, body, actor }) => {
      const comment = {
        id: state.nextId++,
        trackingNumber,
        body,
        createdAt: new Date().toISOString(),
        actor: actor ? { id: actor.id, name: actor.name, email: actor.email } : null,
      };
      state.comments.push(comment);
      return comment;
    },
    deleteComment: async (id, actorId) => {
      const found = state.comments.find((c) => c.id === id);
      if (!found) return 'not_found';
      if (!actorId || found.actor?.id !== actorId) return 'forbidden';
      state.comments = state.comments.filter((c) => c.id !== id);
      return 'deleted';
    },
    countByTracking: async () => ({}),
  },
});

mock.module(src('db/activityRepository.js'), {
  namedExports: {
    findCreator: async () => null,
    findCreators: async () => ({}),
    // Journal de deux envois distincts : le mock filtre réellement, sinon le
    // test ne prouverait rien sur le filtrage de la route.
    listActivity: async ({ entityType, entityId }) => {
      const all = [
        { id: 1, entityType: 'shipment', entityId: 'local-1', summary: 'Cet envoi' },
        { id: 2, entityType: 'shipment', entityId: 'local-2', summary: 'Un autre envoi' },
      ];
      const entries = all.filter((e) => e.entityType === entityType && e.entityId === entityId);
      return { total: entries.length, entries };
    },
  },
});

mock.module(src('db/shipmentsRepository.js'), {
  namedExports: {
    listShipments: async () => ({ total: 0, shipments: [] }),
    listOpenShipments: async () => [],
    getShipmentByTracking: async (t) =>
      t === '1Z999' ? { trackingNumber: '1Z999', shipmentId: '1Z9SHIP', localShipmentId: 'local-1', status: 'created' } : null,
    // Expédition de deux colis : la page doit les montrer tous les deux.
    listPackagesOfShipment: async (id) =>
      id === 'local-1'
        ? [
            { trackingNumber: '1Z999', shipmentId: '1Z9SHIP', billingWeight: '2.5 KGS' },
            { trackingNumber: '1Z998', shipmentId: '1Z9SHIP', billingWeight: '1.0 KGS' },
          ]
        : [],
    updateStatus: async () => null,
    countByStatus: async () => ({}),
    getStats: async () => ({}),
    getLabel: async () => null,
    listLabelsOfShipment: async (id) =>
      id === '1Z999'
        ? [
            { base64: 'AAA', format: 'GIF', trackingNumber: '1Z999' },
            { base64: 'BBB', format: 'GIF', trackingNumber: '1Z998' },
          ]
        : [],
  },
});

const { shipmentsRouter } = await import(src('routes/shipments.js'));
const { errorHandler } = await import(src('middleware/errorHandler.js'));
const { default: express } = await import('express');

async function startServer(t) {
  const app = express();
  app.use(express.json());
  // Simule attachActor : le vrai middleware dépend de Keycloak.
  app.use((req, res, next) => {
    req.actor = state.actor;
    next();
  });
  app.use('/api/shipments', shipmentsRouter);
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
  state.dbEnabled = true;
  state.actor = null;
  state.comments = [];
  state.nextId = 1;
}

test('un commentaire est ajouté avec son auteur', async (t) => {
  reset();
  state.actor = { id: 'u1', name: 'Sébastien', email: 's@konitys.fr' };
  const call = await startServer(t);

  const { status, body } = await call('POST', '/api/shipments/1Z999/comments', {
    body: 'Client prévenu par téléphone.',
  });

  assert.equal(status, 201);
  assert.equal(body.data.body, 'Client prévenu par téléphone.');
  assert.equal(body.data.actor.name, 'Sébastien');
});

test('un commentaire vide est refusé', async (t) => {
  reset();
  const call = await startServer(t);

  const { status } = await call('POST', '/api/shipments/1Z999/comments', { body: '   ' });
  assert.equal(status, 400);
});

test('un commentaire trop long est refusé', async (t) => {
  reset();
  const call = await startServer(t);

  const { status, body } = await call('POST', '/api/shipments/1Z999/comments', {
    body: 'x'.repeat(2001),
  });
  assert.equal(status, 400);
  assert.match(body.error.message, /2000/);
});

test('la route comments echappe au motif generique', async (t) => {
  reset();
  const call = await startServer(t);

  // Sans déclaration préalable, « comments » serait lu comme un numéro de
  // suivi et la réponse serait un 404 d'envoi introuvable.
  const { status, body } = await call('GET', '/api/shipments/1Z999/comments');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.data.comments));
});

test('l auteur peut supprimer son commentaire', async (t) => {
  reset();
  state.actor = { id: 'u1', name: 'Sébastien' };
  const call = await startServer(t);

  const created = await call('POST', '/api/shipments/1Z999/comments', { body: 'A supprimer' });
  const { status } = await call('DELETE', `/api/shipments/1Z999/comments/${created.body.data.id}`);

  assert.equal(status, 200);
  assert.equal(state.comments.length, 0);
});

test('un autre utilisateur ne peut pas supprimer le commentaire', async (t) => {
  reset();
  state.actor = { id: 'u1', name: 'Sébastien' };
  const call = await startServer(t);
  const created = await call('POST', '/api/shipments/1Z999/comments', { body: 'Le mien' });

  state.actor = { id: 'u2', name: 'Quelqu un autre' };
  const { status } = await call('DELETE', `/api/shipments/1Z999/comments/${created.body.data.id}`);

  assert.equal(status, 403);
  assert.equal(state.comments.length, 1, 'le commentaire doit survivre');
});

test('sans identite, aucune suppression possible', async (t) => {
  reset();
  state.actor = { id: 'u1', name: 'Sébastien' };
  const call = await startServer(t);
  const created = await call('POST', '/api/shipments/1Z999/comments', { body: 'Le mien' });

  // Keycloak absent : req.actor est null sur la requête de suppression.
  state.actor = null;
  const { status } = await call('DELETE', `/api/shipments/1Z999/comments/${created.body.data.id}`);

  assert.equal(status, 403);
  assert.equal(state.comments.length, 1);
});

test('supprimer un commentaire inexistant renvoie 404', async (t) => {
  reset();
  state.actor = { id: 'u1' };
  const call = await startServer(t);

  const { status } = await call('DELETE', '/api/shipments/1Z999/comments/999');
  assert.equal(status, 404);
});

test('un identifiant non numerique est refuse', async (t) => {
  reset();
  const call = await startServer(t);

  const { status } = await call('DELETE', '/api/shipments/1Z999/comments/abc');
  assert.equal(status, 400);
});

test('sans base, les commentaires repondent 503 et non 500', async (t) => {
  reset();
  state.dbEnabled = false;
  const call = await startServer(t);

  const { status, body } = await call('GET', '/api/shipments/1Z999/comments');
  assert.equal(status, 503);
  assert.equal(body.error.code, 'DB_NOT_CONFIGURED');
});

test('le detail rassemble envoi, auteur, journal et commentaires', async (t) => {
  reset();
  const call = await startServer(t);

  const { status, body } = await call('GET', '/api/shipments/1Z999');

  assert.equal(status, 200);
  assert.equal(body.data.shipment.trackingNumber, '1Z999');
  assert.ok('creator' in body.data);
  assert.ok(Array.isArray(body.data.activity));
  assert.ok(Array.isArray(body.data.comments));
});

test('les colis freres de l expedition sont tous renvoyes', async (t) => {
  reset();
  const call = await startServer(t);

  const { body } = await call('GET', '/api/shipments/1Z999');

  // Une expédition multi-colis occupe plusieurs lignes sous un même
  // shipment_id : n'en renvoyer qu'une masquerait les autres colis.
  assert.equal(body.data.packages.length, 2);
  assert.deepEqual(
    body.data.packages.map((p) => p.trackingNumber),
    ['1Z999', '1Z998'],
  );
});

test('un envoi inconnu renvoie 404', async (t) => {
  reset();
  const call = await startServer(t);

  const { status, body } = await call('GET', '/api/shipments/1Z000');
  assert.equal(status, 404);
  assert.equal(body.error.code, 'SHIPMENT_NOT_FOUND');
});

test('un commentaire enrichi conserve sa mise en forme', async (t) => {
  reset();
  const call = await startServer(t);

  const { status, body } = await call('POST', '/api/shipments/1Z999/comments', {
    body: '<b>Client</b> prevenu, <i>rappeler demain</i>',
  });

  assert.equal(status, 201);
  assert.match(body.data.body, /<b>Client<\/b>/);
});

test('un editeur vide envoie du HTML sans texte : refuse', async (t) => {
  reset();
  const call = await startServer(t);

  // trim() ne suffit pas : ces corps ne sont pas vides au sens des chaines.
  for (const empty of ['<p></p>', '<br>', '<div><br></div>', '&nbsp;']) {
    const { status } = await call('POST', '/api/shipments/1Z999/comments', { body: empty });
    assert.equal(status, 400, `« ${empty} » doit etre refuse`);
  }
});

test('une liste sans texte reste acceptee', async (t) => {
  reset();
  const call = await startServer(t);

  const { status } = await call('POST', '/api/shipments/1Z999/comments', {
    body: '<ul><li>Point</li></ul>',
  });
  assert.equal(status, 201);
});

test('un commentaire ecrit par UUID se relit dans le detail', async (t) => {
  reset();
  const call = await startServer(t);

  // Le bug corrige : l'ecriture utilisait le parametre d'URL (un UUID) et la
  // lecture le numero de suivi. Le commentaire restait invisible.
  await call('POST', '/api/shipments/1Z999/comments', { body: 'Visible ?' });

  const detail = await call('GET', '/api/shipments/1Z999');
  assert.equal(detail.body.data.comments.length, 1, 'le commentaire doit apparaitre');
  assert.equal(detail.body.data.comments[0].body, 'Visible ?');

  const list = await call('GET', '/api/shipments/1Z999/comments');
  assert.equal(list.body.data.comments.length, 1, 'et dans la liste dediee');
});

test('les etiquettes de tous les colis sont renvoyees', async (t) => {
  reset();
  const call = await startServer(t);

  // Un envoi de deux colis a deux etiquettes : n'en renvoyer qu'une
  // laisserait le second colis sans son etiquette a l'impression.
  const { status, body } = await call('GET', '/api/shipments/1Z999/labels');

  assert.equal(status, 200);
  assert.equal(body.data.count, 2);
  assert.deepEqual(
    body.data.labels.map((l) => l.trackingNumber),
    ['1Z999', '1Z998'],
  );
});

test('un envoi sans etiquette renvoie 404', async (t) => {
  reset();
  const call = await startServer(t);

  const { status, body } = await call('GET', '/api/shipments/1Z000/labels');
  assert.equal(status, 404);
  assert.equal(body.error.code, 'LABEL_NOT_FOUND');
});

test('le journal ne montre que les actions de cet envoi', async (t) => {
  reset();
  const call = await startServer(t);

  const { body } = await call('GET', '/api/shipments/1Z999');

  // Filtre sur l'identifiant local : en CIE le numero de suivi est partage
  // par tous les envois, et le journal les listerait tous.
  assert.equal(body.data.activity.length, 1, 'un seul envoi concerne');
  assert.equal(body.data.activity[0].summary, 'Cet envoi');
});
