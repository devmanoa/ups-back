/**
 * Nettoyage du HTML des commentaires, côté serveur.
 *
 * Le front nettoie déjà à l'affichage : ce filtre est la seconde barrière,
 * celle qui tient si une requête est envoyée directement à l'API.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeComment } from '../src/services/sanitizeComment.js';

test('la mise en forme autorisee est conservee', () => {
  const html = '<p>Colis <strong>parti</strong> ce <em>matin</em></p>';
  assert.equal(sanitizeComment(html), html);
});

test('les listes sont conservees', () => {
  const html = '<ul><li>un</li><li>deux</li></ul>';
  assert.equal(sanitizeComment(html), html);
});

test('une mention garde son identifiant', () => {
  const out = sanitizeComment('<span data-mention="uid-julie">@Julie</span>');
  assert.equal(out, '<span data-mention="uid-julie" class="mention">@Julie</span>');
});

test('un identifiant federe est accepte', () => {
  const id = 'f:526e114d-a150-4032-9fc6-ea47640888a7:116';
  assert.match(sanitizeComment(`<span data-mention="${id}">@Julie</span>`), new RegExp(id));
});

test('un script est retire avec son contenu', () => {
  const out = sanitizeComment('<p>Bonjour</p><script>alert(1)</script>');
  assert.equal(out, '<p>Bonjour</p>');
  assert.doesNotMatch(out, /alert/);
});

test('un gestionnaire d evenement ne survit pas', () => {
  const out = sanitizeComment('<p onclick="alert(1)">Texte</p>');
  assert.equal(out, '<p>Texte</p>');
  assert.doesNotMatch(out, /onclick/i);
});

test('une image avec onerror disparait', () => {
  // Vecteur classique : la balise n'est pas autorisee, donc rien ne reste.
  const out = sanitizeComment('<img src=x onerror="alert(1)">');
  assert.doesNotMatch(out, /onerror/i);
  assert.doesNotMatch(out, /<img/i);
});

test('un lien javascript est refuse mais son texte reste', () => {
  const out = sanitizeComment('<a href="javascript:alert(1)">clic</a>');
  assert.doesNotMatch(out, /javascript/i);
  assert.match(out, /clic/);
});

test('un lien http garde sa cible et son rel', () => {
  const out = sanitizeComment('<a href="https://ups.com">suivi</a>');
  assert.match(out, /href="https:\/\/ups\.com"/);
  assert.match(out, /rel="noreferrer"/);
});

test('un span sans mention valide disparait, son texte reste', () => {
  const out = sanitizeComment('<span style="color:red">rouge</span>');
  assert.equal(out, 'rouge');
});

test('un identifiant de mention forge est rejete', () => {
  // Les guillemets et chevrons sont exclus du format accepte : sans cela,
  // l'identifiant permettrait de sortir de l'attribut.
  const out = sanitizeComment('<span data-mention=\'x" onload="alert(1)\'>@X</span>');
  assert.doesNotMatch(out, /onload/i);
});

test('le texte hors balise est echappe', () => {
  const out = sanitizeComment('5 < 10 & 3 > 1');
  assert.equal(out, '5 &lt; 10 &amp; 3 &gt; 1');
});

test('une iframe est retiree', () => {
  const out = sanitizeComment('<iframe src="http://mechant.fr"></iframe>');
  assert.doesNotMatch(out, /iframe/i);
});

test('un commentaire vide reste vide', () => {
  assert.equal(sanitizeComment(''), '');
  assert.equal(sanitizeComment(null), '');
});

test('une balise non refermee est refermee', () => {
  // Sans cela, le paragraphe absorberait la mise en page qui suit le
  // commentaire dans la page.
  assert.equal(sanitizeComment('<p>oubli'), '<p>oubli</p>');
});

test('une fermeture orpheline est ignoree', () => {
  // Elle fermerait sinon la balise d'un voisin legitime.
  assert.equal(sanitizeComment('texte</p>'), 'texte');
});
