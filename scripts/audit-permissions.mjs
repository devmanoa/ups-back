#!/usr/bin/env node
/**
 * Détecte les routes d'écriture sans garde de permission.
 *
 * Équivalent du script fourni par PERMISSIONS_APP_INTEGRATION.md, réécrit en
 * Node : la garde est déclarée sur la ligne qui suit la route, et un grep
 * ligne à ligne signalait toutes les routes comme non gardées.
 *
 *   node scripts/audit-permissions.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROUTES_DIR = path.resolve(import.meta.dirname, '../src/routes');

/**
 * Routes volontairement non gardées, avec la raison.
 * Une exemption non justifiée finirait par en couvrir de vraies.
 */
const EXEMPTES = {
  'publicApi.js': 'API machine : gardée par clé (X-API-Key), pas par profil utilisateur',
  'rating.js': 'consultation seule — POST par convention UPS, ne modifie rien',
  'locator.js': 'consultation seule — recherche de points relais',
  'timeInTransit.js': 'consultation seule — estimation de délai',
  'landedCost.js': 'consultation seule — estimation de coût',
  // Joignables uniquement via le proxy de l'admin panel, dont toutes les
  // routes /api exigent le role Keycloak 'admin' (requireAdmin). Ce role
  // passe outre les permissions Konitys : un requirePerm n'ajouterait rien.
  'adminWs.js': 'proxy admin panel : role Keycloak admin exige en amont',
};

let manquantes = 0;

for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js'))) {
  const source = readFileSync(path.join(ROUTES_DIR, file), 'utf8');
  const lines = source.split('\n');
  const trouvees = [];

  // Garde posée sur le routeur entier : elle couvre toutes ses routes, et
  // les répéter une à une n'ajouterait rien.
  const gardeGlobale = /Router\.use\(\s*requirePerm\(/.test(source);

  lines.forEach((line, i) => {
    if (gardeGlobale) return;
    if (!/Router\.(post|put|patch|delete)\(/.test(line)) return;

    // La garde suit la déclaration, avant le gestionnaire. La fenêtre est
    // large : un commentaire explicatif peut s'intercaler entre les deux.
    const suite = lines.slice(i + 1, i + 8).join('\n');
    if (/requirePerm\(/.test(suite) || /requirePerm\(/.test(line)) return;

    const chemin = (suite.match(/'([^']*)'/) ?? [])[1] ?? '?';
    const verbe = (line.match(/\.(post|put|patch|delete)\(/) ?? [])[1] ?? '?';
    trouvees.push(`${verbe.toUpperCase()} ${chemin}  (ligne ${i + 1})`);
  });

  if (!trouvees.length) continue;

  if (EXEMPTES[file]) {
    console.log(`\n○ ${file} — exempté : ${EXEMPTES[file]}`);
    trouvees.forEach((r) => console.log(`    ${r}`));
    continue;
  }

  manquantes += trouvees.length;
  console.log(`\n✗ ${file}`);
  trouvees.forEach((r) => console.log(`    ${r}`));
}

console.log(
  manquantes
    ? `\n${manquantes} route(s) d'écriture sans garde.`
    : '\n✓ Toutes les routes d’écriture sont gardées ou exemptées.',
);

process.exit(manquantes ? 1 : 0);
