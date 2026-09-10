/**
 * Contrôle d'accès Konitys.
 *
 * Le point sensible est le toggle d'enforcement : mal interprété, il
 * bloquerait des utilisateurs légitimes en production, ou laisserait tout
 * passer alors que le contrôle est censé être actif.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canFor } from '../src/middleware/requirePerm.js';
import { permissionsSchema } from '../src/routes/permissionsSchema.js';

/** Utilisateur type, avec droits et configuration d'enforcement. */
const utilisateur = (apps, enforcement, isAdmin = false) => ({
  user_id: '141',
  apps,
  is_admin: isAdmin,
  enforcement,
});

const ACTIF = { globally_enabled: true, disabled_apps: [] };

test('sans reponse de la passerelle, l acces est accorde', () => {
  // Tolerance a la panne imposee par la plateforme : un controle d'acces
  // qui tombe ne doit pas rendre l'application inutilisable.
  assert.equal(canFor(null, 'ups', 'shipments.create'), true);
});

test('le role admin Keycloak passe outre', () => {
  const me = utilisateur({}, ACTIF, true);
  assert.equal(canFor(me, 'ups', 'shipments.void'), true);
});

test('un droit accorde autorise', () => {
  const me = utilisateur({ ups: { 'shipments.create': true } }, ACTIF);
  assert.equal(canFor(me, 'ups', 'shipments.create'), true);
});

test('un droit absent refuse quand le controle est actif', () => {
  const me = utilisateur({ ups: { 'shipments.create': true } }, ACTIF);
  assert.equal(canFor(me, 'ups', 'shipments.void'), false);
});

test('un droit explicitement faux refuse', () => {
  const me = utilisateur({ ups: { 'shipments.void': false } }, ACTIF);
  assert.equal(canFor(me, 'ups', 'shipments.void'), false);
});

test('controle desactive globalement : tout passe', () => {
  const me = utilisateur({}, { globally_enabled: false });
  assert.equal(canFor(me, 'ups', 'shipments.void'), true);
});

test('app en mode dev : tout passe malgre le controle global', () => {
  // C'est le bouton << mettre une app en mode dev >> cote admin : sans ce
  // cas, il n'aurait aucun effet.
  const me = utilisateur({}, { globally_enabled: true, disabled_apps: ['ups'] });
  assert.equal(canFor(me, 'ups', 'shipments.void'), true);
});

test('une autre app en mode dev ne nous concerne pas', () => {
  const me = utilisateur({}, { globally_enabled: true, disabled_apps: ['qrcode'] });
  assert.equal(canFor(me, 'ups', 'shipments.void'), false);
});

test('mode selectif : seules les apps listees sont controlees', () => {
  const off = utilisateur({}, { globally_enabled: false, enabled_apps: ['qrcode'] });
  assert.equal(canFor(off, 'ups', 'shipments.void'), true, 'ups non listee : libre');

  const on = utilisateur({}, { globally_enabled: false, enabled_apps: ['ups'] });
  assert.equal(canFor(on, 'ups', 'shipments.void'), false, 'ups listee : controlee');
});

test('les droits d une autre app ne valent pas pour la notre', () => {
  const me = utilisateur({ antennes: { 'shipments.void': true } }, ACTIF);
  assert.equal(canFor(me, 'ups', 'shipments.void'), false);
});

test('le schema declare la cle canonique et des groupes', () => {
  assert.equal(permissionsSchema.app, 'ups');
  assert.ok(permissionsSchema.groups.length > 0);
  assert.ok(Number.isInteger(permissionsSchema.version));
});

test('toutes les cles du schema sont uniques', () => {
  const keys = permissionsSchema.groups.flatMap((g) => g.permissions.map((p) => p.key));
  // Une cle en double rendrait le resultat d'un grant imprevisible.
  assert.equal(new Set(keys).size, keys.length);
});

test('le schema expose app.access, exige par la regle de redirection', () => {
  const keys = permissionsSchema.groups.flatMap((g) => g.permissions.map((p) => p.key));
  assert.ok(keys.includes('app.access'));
});

test('chaque cle suit la convention entite.action', () => {
  const keys = permissionsSchema.groups.flatMap((g) => g.permissions.map((p) => p.key));
  for (const key of keys) {
    assert.match(key, /^[a-z0-9_]+(\.[a-z0-9_]+)+$/, `cle non conforme : ${key}`);
  }
});
