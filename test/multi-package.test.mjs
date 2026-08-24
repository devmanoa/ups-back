/**
 * Envoi multi-colis en environnement CIE.
 *
 * UPS y renvoie le même numéro factice (1ZXXXXXXXXXXXXXXXX) pour tous les
 * colis d'une expédition. Le garde-fou anti-rejeu, qui cherchait ce numéro
 * sans regarder l'expédition, prenait le colis 2 pour un rejeu du colis 1 :
 * les colis suivants n'étaient jamais enregistrés.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = (p) => pathToFileURL(path.resolve(import.meta.dirname, '../src', p)).href;

/** Table shipments simulée, avec juste ce que saveShipment manipule. */
const rows = [];
let nextId = 1;

mock.module(src('db/pool.js'), {
  namedExports: {
    isDbEnabled: () => true,
    query: async (sql, params = []) => {
      if (/^SELECT \* FROM shipments WHERE tracking_number/i.test(sql)) {
        const [tracking] = params;
        return { rows: rows.filter((r) => r.tracking_number === tracking) };
      }

      if (/^INSERT INTO shipments/i.test(sql)) {
        const row = {
          id: nextId++,
          shipment_id: params[0],
          tracking_number: params[1],
          service_code: params[2],
          service_name: params[3],
          recipient_name: params[4],
          billing_weight: params[14],
          total_charges: params[12],
        };
        rows.push(row);
        return { rows: [row] };
      }

      return { rows: [] };
    },
  },
});

const { saveShipment } = await import(src('db/shipmentsRepository.js'));

function reset() {
  rows.length = 0;
  nextId = 1;
}

/** Expédition de trois colis partageant le numéro factice de CIE. */
function cieShipment(shipmentId = '1Z9SHIP') {
  return {
    shipment: {
      shipmentIdentificationNumber: shipmentId,
      totalCharges: 106.51,
      currency: 'EUR',
      billingWeight: '30.0 KGS',
      packages: [
        { trackingNumber: '1ZXXXXXXXXXXXXXXXX', label: { base64: 'a' } },
        { trackingNumber: '1ZXXXXXXXXXXXXXXXX', label: { base64: 'b' } },
        { trackingNumber: '1ZXXXXXXXXXXXXXXXX', label: { base64: 'c' } },
      ],
    },
    shipTo: { name: 'Razaf', city: 'Paris', postalCode: '75001', country: 'FR' },
    serviceCode: '11',
    serviceName: 'UPS Standard',
  };
}

test('les trois colis sont enregistres malgre un numero factice partage', async () => {
  reset();

  const saved = await saveShipment(cieShipment());

  assert.equal(saved.length, 3, 'les trois colis doivent exister');
  assert.equal(rows.length, 3, 'trois lignes en base');
});

test('deux envois CIE successifs sont tous deux enregistres', async () => {
  reset();

  // Le cas signalé : tous les envois CIE portent 1ZXXXXXXXXXXXXXXXX. Le
  // deuxième envoi était pris pour un rejeu du premier et n'apparaissait
  // jamais dans l'historique.
  await saveShipment(cieShipment('1ZSHIP_A'));
  await saveShipment(cieShipment('1ZSHIP_B'));

  assert.equal(rows.length, 6, 'trois colis par envoi, deux envois');
  assert.equal(new Set(rows.map((r) => r.shipment_id)).size, 2, 'deux expeditions distinctes');
});

test('un envoi CIE d un seul colis apparait aussi', async () => {
  reset();
  await saveShipment(cieShipment('1ZSHIP_A'));

  const single = {
    shipment: {
      shipmentIdentificationNumber: '1ZSHIP_SOLO',
      packages: [{ trackingNumber: '1ZXXXXXXXXXXXXXXXX' }],
    },
    shipTo: { name: 'Solo' },
  };
  const saved = await saveShipment(single);

  assert.equal(saved.length, 1);
  assert.equal(
    rows.filter((r) => r.shipment_id === '1ZSHIP_SOLO').length,
    1,
    'l envoi d un colis doit exister en base',
  );
});

test('un numero deja vu sous une AUTRE expedition est bien un rejeu', async () => {
  reset();

  // Un vrai numéro de production, enregistré une première fois.
  await saveShipment({
    shipment: {
      shipmentIdentificationNumber: '1ZAAA',
      packages: [{ trackingNumber: '1Z8A615A6890739179' }],
    },
    shipTo: { name: 'Premier' },
  });

  // Le même numéro réapparaît sous une autre expédition : c'est un rejeu,
  // la ligne existante doit être réutilisée plutôt que dupliquée.
  const saved = await saveShipment({
    shipment: {
      shipmentIdentificationNumber: '1ZBBB',
      packages: [{ trackingNumber: '1Z8A615A6890739179' }],
    },
    shipTo: { name: 'Second' },
  });

  assert.equal(rows.length, 1, 'aucune ligne supplementaire');
  assert.equal(saved[0].recipient.name, 'Premier', 'la ligne d origine est conservee');
});

test('les colis d une expedition partagent le meme shipment_id', async () => {
  reset();
  await saveShipment(cieShipment('1ZSHIP42'));

  assert.ok(
    rows.every((r) => r.shipment_id === '1ZSHIP42'),
    'le regroupement de la page de detail en depend',
  );
});
