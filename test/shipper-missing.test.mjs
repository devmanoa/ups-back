/**
 * Adresse expéditeur incomplète.
 *
 * Fichier séparé : `config.js` lit les variables d'environnement à son
 * chargement, et un même processus ne peut pas les avoir à la fois définies
 * et absentes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = (p) => pathToFileURL(path.resolve(import.meta.dirname, '../src', p)).href;

// Ville et code postal renseignés, le reste manquant.
process.env.SHIPPER_NAME = '';
process.env.SHIPPER_ADDRESS_LINE = '';
process.env.SHIPPER_CITY = 'Rennes';
process.env.SHIPPER_POSTAL_CODE = '35000';

const { shippingRouter } = await import(src('routes/shipping.js'));
const { errorHandler } = await import(src('middleware/errorHandler.js'));
const { default: express } = await import('express');

test('une adresse incomplete est signalee champ par champ', async (t) => {
  const app = express();
  app.use('/api/shipping', shippingRouter);
  app.use(errorHandler);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/shipping/shipper`);
  const body = await res.json();

  assert.equal(body.data.configured, false);
  // Nommer les champs manquants evite d'avoir a deviner ce qui bloque.
  assert.ok(body.data.missing.includes('name'));
  assert.ok(body.data.missing.includes('addressLine'));
  assert.ok(!body.data.missing.includes('city'), 'la ville est renseignee');
});
