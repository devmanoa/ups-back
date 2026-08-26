/**
 * GET /api/shipping/shipper — adresse d'expédition par défaut.
 *
 * Elle vient des variables SHIPPER_* et n'apparaissait nulle part : rien ne
 * disait d'où le colis partait, ni que l'adresse était incomplète — l'échec
 * ne se découvrait qu'au moment de créer l'étiquette.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = (p) => pathToFileURL(path.resolve(import.meta.dirname, '../src', p)).href;

process.env.SHIPPER_NAME = 'Konitys';
process.env.SHIPPER_ATTENTION_NAME = 'Service Expédition';
process.env.SHIPPER_PHONE = '0102030405';
process.env.SHIPPER_ADDRESS_LINE = '12 rue de la Paix';
process.env.SHIPPER_CITY = 'Rennes';
process.env.SHIPPER_POSTAL_CODE = '35000';
process.env.SHIPPER_COUNTRY = 'FR';

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
  return async (url) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`);
    return { status: res.status, body: await res.json() };
  };
}

test('l adresse expediteur est renvoyee', async (t) => {
  const call = await startServer(t);
  const { status, body } = await call('/api/shipping/shipper');

  assert.equal(status, 200);
  assert.equal(body.data.shipper.name, 'Konitys');
  assert.equal(body.data.shipper.city, 'Rennes');
  assert.equal(body.data.configured, true);
  assert.deepEqual(body.data.missing, []);
});

test('le telephone n est pas expose', async (t) => {
  const call = await startServer(t);
  const { body } = await call('/api/shipping/shipper');

  // Il ne sert qu'à UPS : l'afficher n'apprendrait rien et l'exposerait
  // sans raison.
  assert.ok(!('phone' in body.data.shipper), 'le telephone ne doit pas sortir');
});

test('shipper est route comme un mot-cle, pas comme une ressource', async (t) => {
  const call = await startServer(t);

  // Si /shipper était capté par un motif générique, la réponse ne serait pas
  // celle attendue.
  const { status, body } = await call('/api/shipping/shipper');
  assert.equal(status, 200);
  assert.ok('configured' in body.data);
});
