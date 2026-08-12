import { Router } from 'express';
import { config, API_VERSIONS } from '../config.js';
import { getAccessToken, invalidateToken } from '../services/auth.js';
import { upsFetch } from '../services/upsClient.js';
import { asyncHandler } from '../middleware/validate.js';

export const diagnosticRouter = Router();

/** Masque un secret en n'exposant que ses extrémités. */
function mask(value) {
  if (!value) return null;
  if (value.length <= 8) return `${value.length} caractères`;
  return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} caractères)`;
}

/**
 * GET /api/diagnostic
 *
 * Teste séparément chaque étape de la chaîne UPS pour identifier laquelle
 * échoue : configuration, obtention du jeton, puis appel réel d'une API.
 * Le cache de jeton est vidé au préalable pour tester les identifiants
 * actuellement configurés, et non un jeton obtenu avant un changement de
 * variables d'environnement.
 */
diagnosticRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const steps = [];

    // 1. Configuration
    const suspiciousChars = [];
    for (const [name, value] of [
      ['UPS_CLIENT_ID', process.env.UPS_CLIENT_ID],
      ['UPS_CLIENT_SECRET', process.env.UPS_CLIENT_SECRET],
      ['UPS_ACCOUNT_NUMBER', process.env.UPS_ACCOUNT_NUMBER],
    ]) {
      if (value && value !== value.trim()) {
        suspiciousChars.push(`${name} contient des espaces en début ou fin`);
      }
    }

    steps.push({
      step: '1. Configuration',
      ok: Boolean(config.clientId && config.clientSecret),
      environment: config.env,
      baseUrl: config.baseUrl,
      clientId: mask(config.clientId),
      clientSecret: mask(config.clientSecret),
      accountNumber: config.accountNumber || null,
      warnings: suspiciousChars,
    });

    if (!config.clientId || !config.clientSecret) {
      return res.json({
        success: false,
        conclusion: 'UPS_CLIENT_ID ou UPS_CLIENT_SECRET absent du conteneur.',
        steps,
      });
    }

    // 2. Jeton OAuth — cache vidé pour tester les identifiants actuels.
    invalidateToken();
    let token;
    try {
      token = await getAccessToken();
      steps.push({
        step: '2. Jeton OAuth',
        ok: true,
        endpoint: `${config.baseUrl}/security/v1/oauth/token`,
        tokenPreview: mask(token),
      });
    } catch (err) {
      steps.push({
        step: '2. Jeton OAuth',
        ok: false,
        endpoint: `${config.baseUrl}/security/v1/oauth/token`,
        error: err.message,
        details: err.details || null,
      });
      return res.json({
        success: false,
        conclusion:
          `Les identifiants sont refusés par ${config.baseUrl}. ` +
          `Vérifiez qu'ils proviennent bien de l'environnement "${config.env}" : ` +
          `les identifiants CIE (test) et Production ne sont pas interchangeables.`,
        steps,
      });
    }

    // 3. Appel réel d'une API métier : le jeton peut être valide mais l'API
    // non autorisée pour cette application UPS.
    const probes = [
      {
        name: 'Locator (points relais)',
        run: () =>
          upsFetch(`/locations/${API_VERSIONS.locator}/search/availabilities/64`, {
            method: 'POST',
            body: {
              LocatorRequest: {
                Request: { RequestAction: 'Locator' },
                OriginAddress: {
                  AddressKeyFormat: { PostcodePrimaryLow: '75002', CountryCode: 'FR' },
                  MaximumListSize: '1',
                },
                Translate: { LanguageCode: 'FRA', Locale: 'fr_FR' },
                UnitOfMeasurement: { Code: 'KM' },
                LocationSearchCriteria: { MaximumListSize: '1', SearchRadius: '10' },
              },
            },
          }),
      },
      {
        name: 'Address Validation',
        run: () =>
          upsFetch(`/addressvalidation/${API_VERSIONS.addressValidation}/1`, {
            method: 'POST',
            body: {
              XAVRequest: {
                AddressKeyFormat: {
                  PoliticalDivision2: 'Timonium',
                  PoliticalDivision1: 'MD',
                  PostcodePrimaryLow: '21093',
                  CountryCode: 'US',
                },
                RequestOption: '1',
              },
            },
          }),
      },
      {
        name: 'QuantumView (synchronisation)',
        run: () =>
          upsFetch(`/quantumview/${API_VERSIONS.quantumView}/events`, {
            method: 'POST',
            body: { QuantumViewRequest: { Request: { RequestAction: 'QVEvents' } } },
          }),
      },
      {
        name: 'Time In Transit (délais)',
        run: () =>
          upsFetch(`/shipments/${API_VERSIONS.timeInTransit}/transittimes`, {
            method: 'POST',
            body: {
              originCountryCode: 'FR',
              originPostalCode: '75002',
              destinationCountryCode: 'FR',
              destinationPostalCode: '69001',
              weight: '1',
              weightUnitOfMeasure: 'KGS',
              shipmentContentsValue: '10',
              shipmentContentsCurrencyCode: 'EUR',
              billType: '03',
              shipDate: new Date().toISOString().slice(0, 10),
              numberOfPackages: '1',
              avvFlag: true,
            },
          }),
      },
      {
        name: 'Rating (tarifs)',
        run: () =>
          upsFetch(`/rating/${API_VERSIONS.rating}/Shop`, {
            method: 'POST',
            body: {
              RateRequest: {
                Request: { RequestOption: 'Shop' },
                Shipment: {
                  Shipper: { Name: 'Test', Address: { City: 'Paris', PostalCode: '75002', CountryCode: 'FR' } },
                  ShipTo: { Name: 'Test', Address: { City: 'Lyon', PostalCode: '69001', CountryCode: 'FR' } },
                  ShipFrom: { Name: 'Test', Address: { City: 'Paris', PostalCode: '75002', CountryCode: 'FR' } },
                  Package: [
                    {
                      PackagingType: { Code: '02' },
                      PackageWeight: { UnitOfMeasurement: { Code: 'KGS' }, Weight: '1' },
                    },
                  ],
                },
              },
            },
          }),
      },
    ];

    // Les sondes sont indépendantes : en série, cinq appels UPS risqueraient
    // de dépasser le délai d'attente du client.
    const results = await Promise.all(
      probes.map(async (probe) => {
        try {
          await probe.run();
          return { api: probe.name, ok: true };
        } catch (err) {
          return {
            api: probe.name,
            ok: false,
            status: err.status,
            code: err.code,
            upsCodes: err.upsCodes || [],
            error: err.message,
          };
        }
      }),
    );

    steps.push({ step: '3. Appels API', results });

    const failed = results.filter((r) => !r.ok);
    let conclusion;

    if (failed.length === 0) {
      conclusion = 'Tout fonctionne : jeton obtenu et APIs accessibles.';
    } else if (failed.length === results.length) {
      conclusion =
        'Le jeton est obtenu mais toutes les APIs le refusent. ' +
        `Vérifiez que l'environnement "${config.env}" correspond bien à celui de vos identifiants.`;
    } else {
      // Le code 250002 signifie « API non autorisée », malgré son libellé
      // trompeur « Invalid Authentication Information ».
      const notSubscribed = failed.filter((f) => f.upsCodes?.includes('250002'));

      conclusion =
        notSubscribed.length > 0
          ? `Le jeton fonctionne, mais ${notSubscribed.length} API(s) sont refusées : ` +
            `${notSubscribed.map((f) => f.api).join(', ')}. ` +
            `Ajoutez-les à votre application sur developer.ups.com (Edit App), ` +
            `puis redémarrez le backend pour renouveler le jeton.`
          : `Le jeton fonctionne, mais ${failed.map((f) => f.api).join(', ')} échoue. ` +
            `Consultez le détail de chaque appel ci-dessous.`;
    }

    res.json({ success: failed.length === 0, conclusion, steps });
  }),
);
