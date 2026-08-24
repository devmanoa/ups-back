/**
 * Le schéma SQL vit dans un template literal JavaScript.
 *
 * Un backtick dans un commentaire SQL y termine la chaîne : le fichier ne
 * compile plus, et l'erreur ne se voit qu'au démarrage du serveur — donc en
 * production. C'est arrivé deux fois. Ce test la fait apparaître avant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const srcDir = path.resolve(import.meta.dirname, '../src');

test('migrate.js se charge sans erreur de syntaxe', async () => {
  // L'import échouerait sur un backtick mal placé, comme au démarrage.
  const mod = await import(pathToFileURL(path.join(srcDir, 'db/migrate.js')).href);
  assert.equal(typeof mod.migrate, 'function');
});

test('le schema SQL ne contient aucun backtick', async () => {
  const source = await readFile(path.join(srcDir, 'db/migrate.js'), 'utf8');

  const start = source.indexOf('const SCHEMA = `');
  assert.notEqual(start, -1, 'le schema doit rester dans une constante SCHEMA');

  const body = source.slice(start + 'const SCHEMA = `'.length);
  const end = body.indexOf('\n`;');
  assert.notEqual(end, -1, 'la constante SCHEMA doit se fermer');

  const sql = body.slice(0, end);
  assert.ok(
    !sql.includes('`'),
    'un backtick dans le SQL termine le template literal : citez les noms de ' +
      'colonnes sans backticks dans les commentaires.',
  );
});

test('les modules de la couche base se chargent', async () => {
  // `server.js` est délibérément exclu : l'importer ouvrirait un port que
  // rien ne referme, et la suite de tests resterait suspendue.
  for (const entry of [
    'db/migrate.js',
    'db/shipmentsRepository.js',
    'db/commentsRepository.js',
    'db/activityRepository.js',
    'db/addressesRepository.js',
    'db/packageTypesRepository.js',
  ]) {
    await import(pathToFileURL(path.join(srcDir, entry)).href);
  }
});
