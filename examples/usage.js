/**
 * Exemples d'utilisation du client, exécutables tels quels :
 *
 *   UPS_API_URL=https://ups.example.com UPS_API_KEY=... node examples/usage.js
 *
 * Attention : avec UPS_ENV=production côté backend, ces appels créent des
 * étiquettes réellement facturées.
 */
import { writeFile } from 'node:fs/promises';
import { createUpsClient, UpsApiError } from './ups-client.js';

const ups = createUpsClient({
  baseUrl: process.env.UPS_API_URL,
  // Jamais en dur dans le code : une clé commitée reste dans l'historique
  // Git même après suppression.
  apiKey: process.env.UPS_API_KEY,
});

const destinataire = {
  name: 'Antenne Lyon',
  attentionName: 'Marie Dupont',
  addressLine1: '10 rue Victor Hugo',
  city: 'Lyon',
  postalCode: '69001',
  country: 'FR',
  phone: '0472000000',
};

/** 1. Vérifier la configuration sans rien facturer. */
async function verifier() {
  const { client, environment } = await ups.ping();
  console.log(`Connecté en tant que « ${client} » (environnement UPS : ${environment})`);

  if (environment === 'test') {
    // En bac à sable, UPS renvoie 1ZXXXXXXXXXXXXXXXX pour tous les envois et
    // imprime « SAMPLE » au lieu d'un code-barres.
    console.log('→ Bac à sable : numéros de suivi factices, étiquettes non valides.');
  }
}

/** 2. Créer une étiquette et l'enregistrer sur disque. */
async function creerEtiquette() {
  const envoi = await ups.createShipment({
    shipTo: destinataire,
    packages: [{ weight: '2.5', length: '30', width: '20', height: '15' }],
    serviceCode: '11',
    reference: 'CMD-4321',
  });

  console.log(`Étiquette créée — suivi ${envoi.trackingNumbers[0]}`);

  // L'étiquette arrive déjà en base64 : inutile de la redemander.
  const [etiquette] = envoi.labels;
  await writeFile(`etiquette-${envoi.trackingNumbers[0]}.gif`, Buffer.from(etiquette.base64, 'base64'));

  // `id` est l'identifiant à conserver : en bac à sable le numéro de suivi
  // est identique pour tous les envois et ne les distingue pas.
  return envoi.id;
}

/** 3. Créer une commande de plusieurs expéditions. */
async function creerCommande() {
  const commande = await ups.createOrder({
    serviceCode: '11',
    shipments: [
      { shipTo: destinataire, packages: [{ weight: '1' }], reference: 'CMD-1' },
      {
        shipTo: { ...destinataire, name: 'Antenne Paris', city: 'Paris', postalCode: '75001' },
        packages: [{ weight: '2' }],
        reference: 'CMD-2',
      },
    ],
  });

  console.log(`Commande ${commande.orderId} : ${commande.created} créée(s), ${commande.failed} en échec`);

  if (commande.partial) {
    // Les étiquettes réussies sont facturées : relancer toute la commande
    // créerait des doublons. Seules les lignes en échec sont à reprendre.
    const aReprendre = commande.results.filter((r) => !r.ok);
    for (const ligne of aReprendre) {
      console.warn(`  ✗ ${ligne.reference} : ${ligne.error} ${ligne.upsCodes.join(', ')}`);
    }
  }

  return commande.orderId;
}

/** 4. Suivre l'avancement d'une commande. */
async function suivreCommande(orderId) {
  const commande = await ups.getOrder(orderId);

  console.log(`Commande ${orderId} — ${commande.total} envoi(s)`);
  for (const envoi of commande.shipments) {
    console.log(`  ${envoi.recipient.name} : ${envoi.status} (${envoi.trackingNumbers.join(', ')})`);
  }

  // `completed` passe à true quand tout est livré ou annulé : c'est le
  // signal pour cesser d'interroger.
  if (commande.completed) console.log('→ Commande terminée.');
}

/** 5. Récupérer une étiquette plus tard, en fichier prêt à imprimer. */
async function retelecharger(id) {
  const { buffer, mime } = await ups.getLabelFile(id);
  const ext = mime.includes('pdf') ? 'pdf' : 'gif';
  await writeFile(`reimpression-${id}.${ext}`, buffer);
  console.log(`Étiquette retéléchargée (${mime}).`);
}

try {
  await verifier();
  const id = await creerEtiquette();
  await retelecharger(id);

  const orderId = await creerCommande();
  await suivreCommande(orderId);

  // Annulation : l'identifiant attendu est celui d'UPS, pas l'`id` local.
  // const { shipmentId } = await ups.getShipment(id);
  // await ups.voidShipment(shipmentId);
} catch (err) {
  if (err instanceof UpsApiError) {
    // 400 = rien n'a été créé ni facturé ; 502 = UPS a refusé ou est en panne.
    console.error(`Échec (${err.status} ${err.code}) : ${err.message}`);
    if (err.upsCodes.length) console.error(`Codes UPS : ${err.upsCodes.join(', ')}`);
    process.exit(1);
  }
  throw err;
}
