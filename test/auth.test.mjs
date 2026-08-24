/**
 * Vérification des jetons Keycloak.
 *
 * Une paire de clés RSA est générée à la volée et un faux JWKS est servi par
 * un serveur local : aucun Keycloak réel n'est nécessaire.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import http from 'node:http';

const src = (p) => pathToFileURL(path.resolve(import.meta.dirname, '../src', p)).href;

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';

/** Sert un JWKS contenant la clé publique générée. */
const jwksServer = http.createServer((req, res) => {
  jwksServer.hits += 1;
  const jwk = publicKey.export({ format: 'jwk' });
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ keys: [{ ...jwk, kid: KID, use: 'sig', alg: 'RS256' }] }));
});
jwksServer.hits = 0;

await new Promise((resolve) => jwksServer.listen(0, resolve));
const KEYCLOAK_URL = `http://127.0.0.1:${jwksServer.address().port}`;
const REALM = 'konitys';

// unref() : un serveur en écoute maintiendrait la boucle d'événements ouverte
// et le lanceur de tests ne rendrait jamais la main.
jwksServer.unref();

const base64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Fabrique un JWT signé, avec des claims surchargeables. */
function makeToken(claims = {}, { alg = 'RS256', kid = KID, sign = true } = {}) {
  const header = base64url(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);

  const payload = base64url(
    JSON.stringify({
      sub: randomUUID(),
      iss: `${KEYCLOAK_URL}/realms/${REALM}`,
      exp: now + 300,
      iat: now,
      ...claims,
    }),
  );

  if (!sign) return `${header}.${payload}.${base64url('signature-bidon')}`;

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${base64url(signer.sign(privateKey))}`;
}

// La configuration est lue à l'import : elle doit être posée avant.
mock.module(src('config.js'), {
  namedExports: {
    config: {
      auth: { keycloakUrl: KEYCLOAK_URL, realm: REALM, required: false },
    },
    API_VERSIONS: {},
    assertCredentials: () => {},
  },
});

const { verifyToken, toActor, resetJwksCache, isAuthConfigured } = await import(
  src('services/keycloak.js')
);

test('jeton valide → claims retournés', async () => {
  resetJwksCache();
  const claims = await verifyToken(makeToken({ email: 'marie@selfizee.fr', name: 'Marie Martin' }));

  assert.equal(claims.email, 'marie@selfizee.fr');
  assert.equal(claims.name, 'Marie Martin');
});

test('signature invalide → rejet', async () => {
  resetJwksCache();
  await assert.rejects(
    () => verifyToken(makeToken({}, { sign: false })),
    (err) => err.code === 'TOKEN_BAD_SIGNATURE' && err.status === 401,
  );
});

test('jeton modifié après signature → rejet', async () => {
  resetJwksCache();
  const token = makeToken({ email: 'marie@selfizee.fr' });
  const [header, , signature] = token.split('.');

  // Charge utile remplacée, signature d'origine conservée.
  const forged = base64url(
    JSON.stringify({ sub: 'intrus', email: 'intrus@ailleurs.fr', exp: 9999999999 }),
  );

  await assert.rejects(
    () => verifyToken(`${header}.${forged}.${signature}`),
    (err) => err.code === 'TOKEN_BAD_SIGNATURE',
  );
});

test('algorithme "none" → rejet, jamais accepté', async () => {
  resetJwksCache();
  const header = base64url(JSON.stringify({ alg: 'none', kid: KID, typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ sub: 'intrus', exp: 9999999999 }));

  await assert.rejects(
    () => verifyToken(`${header}.${payload}.`),
    (err) => err.code === 'TOKEN_BAD_ALG',
  );
});

test('jeton expiré → rejet', async () => {
  resetJwksCache();
  const past = Math.floor(Date.now() / 1000) - 3600;

  await assert.rejects(
    () => verifyToken(makeToken({ exp: past })),
    (err) => err.code === 'TOKEN_EXPIRED',
  );
});

test('jeton d un autre realm → rejet', async () => {
  resetJwksCache();
  await assert.rejects(
    () => verifyToken(makeToken({ iss: 'https://keycloak.ailleurs.fr/realms/autre' })),
    (err) => err.code === 'TOKEN_BAD_ISSUER',
  );
});

test('jeton malformé → rejet sans exception non gérée', async () => {
  resetJwksCache();
  for (const bad of ['', 'abc', 'a.b', 'a.b.c.d']) {
    await assert.rejects(
      () => verifyToken(bad),
      (err) => err.code === 'TOKEN_MALFORMED' || err.code === 'TOKEN_BAD_ALG',
    );
  }
});

test('kid inconnu → rejet', async () => {
  resetJwksCache();
  await assert.rejects(
    () => verifyToken(makeToken({}, { kid: 'kid-inexistant' })),
    (err) => err.code === 'TOKEN_UNKNOWN_KEY',
  );
});

test('le JWKS est mis en cache : un seul appel pour plusieurs jetons', async () => {
  resetJwksCache();
  jwksServer.hits = 0;

  await verifyToken(makeToken());
  await verifyToken(makeToken());
  await verifyToken(makeToken());

  assert.equal(jwksServer.hits, 1, 'Keycloak ne doit pas être interrogé à chaque requête');
});

test('toActor : ordre de préférence du nom affiché', () => {
  assert.equal(toActor({ name: 'Marie Martin', email: 'm@x.fr' }).name, 'Marie Martin');
  assert.equal(toActor({ given_name: 'Jean', family_name: 'Dupont' }).name, 'Jean Dupont');
  assert.equal(toActor({ email: 'paul@selfizee.fr' }).name, 'paul');
  assert.equal(toActor({ preferred_username: 'pmartin' }).name, 'pmartin');
  // Les identifiants d'IdP fédérés ne sont pas des noms affichables.
  assert.equal(toActor({ preferred_username: 'f:abc-def:12345' }).name, 'Utilisateur');
  assert.equal(toActor({}).name, 'Utilisateur');
});

test('toActor : rôles et identifiants extraits', () => {
  const actor = toActor({
    sub: 'user-1',
    email: 'marie@selfizee.fr',
    name: 'Marie',
    realm_access: { roles: ['admin', 'user'] },
  });

  assert.equal(actor.id, 'user-1');
  assert.equal(actor.email, 'marie@selfizee.fr');
  assert.deepEqual(actor.roles, ['admin', 'user']);
});

test('isAuthConfigured reflète la présence de KEYCLOAK_URL', () => {
  assert.equal(isAuthConfigured(), true);
});
