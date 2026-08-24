/**
 * Intégration Antennes : préremplissage d'une étiquette depuis un lien
 * `/shipping?antenne=10`.
 *
 * L'API distante est simulée : les tests ne doivent dépendre ni du réseau ni
 * de la disponibilité de l'application Antennes.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = (p) => pathToFileURL(path.resolve(import.meta.dirname, '../src', p)).href;

process.env.ANTENNES_API_URL = 'https://antennes.test';
process.env.ANTENNES_WS_TOKEN = 'jeton-de-test';

/** Réponse type de l'API Antennes, copiée d'un appel réel. */
const CONTACT = {
  id: 10,
  civilite: 'mr',
  nom: 'Samel',
  prenom: 'Christophe',
  raison_sociale: 'SAM PROD',
  email: 'christophesamel@gmail.com',
  tel_portable: '06 03 47 61 62',
  tel_fixe: '',
  adresse: '16 Impasse Saint-Arnaud',
  adresse_complementaire: '',
  cp: '47000',
  ville: 'Agen',
  pays_nom: 'France',
  addr_lat: '44.2175234',
  addr_lng: '0.6419439',
  antenne_id: 169,
  antenne_ville: 'Agen',
  qualification: 'antenne_principale',
  etat: 'actif',
};

/** Réponse programmable par test, et URL capturée pour les assertions. */
let nextResponse = { status: 200, body: { data: CONTACT } };
let lastUrl = '';

globalThis.fetch = async (url) => {
  lastUrl = String(url);
  const { status, body } = nextResponse;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
};

const { antennesRouter } = await import(src('routes/antennes.js'));
const { errorHandler } = await import(src('middleware/errorHandler.js'));
const { default: express } = await import('express');

async function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/api/antennes', antennesRouter);
  app.use(errorHandler);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => server.close());

  const port = server.address().port;
  return async (url) => {
    // `fetch` global est remplacé par le simulacre d'Antennes : les appels au
    // routeur passent donc par node:http, sans quoi ils seraient interceptés.
    const { request } = await import('node:http');
    return new Promise((resolve) => {
      const req = request({ port, path: url, method: 'GET' }, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      });
      req.end();
    });
  };
}

test('le contact est traduit en destinataire', async (t) => {
  nextResponse = { status: 200, body: { data: CONTACT } };
  const call = await startServer(t);

  const { status, body } = await call('/api/antennes/10');

  assert.equal(status, 200);
  // La société prend le nom, la personne devient le contact : une étiquette
  // part vers SAM PROD, à l'attention de Christophe Samel.
  assert.equal(body.data.recipient.name, 'SAM PROD');
  assert.equal(body.data.recipient.attentionName, 'Christophe Samel');
  assert.equal(body.data.recipient.postalCode, '47000');
  assert.equal(body.data.antenneId, 169);
});

test('le pays en toutes lettres devient un code ISO', async (t) => {
  nextResponse = { status: 200, body: { data: { ...CONTACT, pays_nom: 'Belgique' } } };
  const call = await startServer(t);

  const { body } = await call('/api/antennes/10');
  assert.equal(body.data.recipient.country, 'BE', 'UPS attend un code ISO 2');
});

test('un pays inconnu retombe sur FR plutot que de bloquer', async (t) => {
  nextResponse = { status: 200, body: { data: { ...CONTACT, pays_nom: 'Atlantide' } } };
  const call = await startServer(t);

  const { body } = await call('/api/antennes/10');
  assert.equal(body.data.recipient.country, 'FR');
});

test('sans raison sociale, la personne devient le destinataire', async (t) => {
  nextResponse = { status: 200, body: { data: { ...CONTACT, raison_sociale: '' } } };
  const call = await startServer(t);

  const { body } = await call('/api/antennes/10');
  assert.equal(body.data.recipient.name, 'Christophe Samel');
  assert.equal(body.data.recipient.attentionName, '');
});

test('le jeton est transmis a Antennes, jamais renvoye au client', async (t) => {
  nextResponse = { status: 200, body: { data: CONTACT } };
  const call = await startServer(t);

  const { body } = await call('/api/antennes/10');

  assert.match(lastUrl, /ws_token=jeton-de-test/, 'le backend doit porter le jeton');
  assert.ok(
    !JSON.stringify(body).includes('jeton-de-test'),
    'le jeton ne doit jamais atteindre le navigateur',
  );
});

test('une antenne inconnue renvoie 404', async (t) => {
  nextResponse = { status: 404, body: {} };
  const call = await startServer(t);

  const { status, body } = await call('/api/antennes/999999');
  assert.equal(status, 404);
  assert.equal(body.error.code, 'ANTENNE_NOT_FOUND');
});

test('un jeton refuse est signale comme un probleme de configuration', async (t) => {
  nextResponse = { status: 403, body: {} };
  const call = await startServer(t);

  const { status, body } = await call('/api/antennes/10');

  // 502 et non 403 : ce n'est pas l'utilisateur qui est refuse, c'est notre
  // jeton qui est mauvais. Le message doit designer ce qu'il faut corriger.
  assert.equal(status, 502);
  assert.match(body.error.message, /ANTENNES_WS_TOKEN/);
});

test('un identifiant non numerique est refuse avant tout appel', async (t) => {
  lastUrl = '';
  const call = await startServer(t);

  const { status } = await call('/api/antennes/abc');
  assert.equal(status, 400);
  assert.equal(lastUrl, '', 'aucun appel ne doit partir vers Antennes');
});

test('les coordonnees sont conservees pour eviter un geocodage', async (t) => {
  nextResponse = { status: 200, body: { data: CONTACT } };
  const call = await startServer(t);

  const { body } = await call('/api/antennes/10');
  assert.equal(body.data.coordinates.lat, 44.2175234);
  assert.equal(body.data.coordinates.lng, 0.6419439);
});
