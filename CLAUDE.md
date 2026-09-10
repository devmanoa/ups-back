# UPS Expédition — backend

API Node/Express (ESM, Node 22) devant les APIs UPS, avec historique
PostgreSQL. Dépendances volontairement minimales : `express`, `cors`,
`dotenv`, `pg`.

- Contrat de l'API machine : [API-V1.md](API-V1.md)
- Exemples d'intégration : [examples/](examples/)

## 🔐 Système de permissions Konitys (OBLIGATOIRE — lire à chaque session)

Cette app utilise le système de permissions centralisé Konitys. Le référentiel
complet est dans `<plateform-repo>/docs/PERMISSIONS_APP_INTEGRATION.md`.

- Schéma exposé : `src/routes/permissionsSchema.js` (clé d'app : `ups`)
- Middleware : `src/middleware/requirePerm.js`
- Endpoint public : `GET /adminpanel/permissions-schema`

### Règles à respecter systématiquement

**Avant de terminer TOUTE tâche** (feature, bugfix, refacto) :

1. **Scanner les nouvelles routes d'écriture** — `node scripts/audit-permissions.mjs`
   Chaque `POST`/`PUT`/`PATCH`/`DELETE` doit porter un `requirePerm('<clé>')`,
   ou figurer dans les exemptions du script avec sa raison.

2. **Scanner les nouveaux boutons d'action** (create/edit/delete/archive) —
   ajouter `data-perm="ups:<clé>"` sur le nœud, ou un test
   `usePerms().has('<clé>')` dans la logique de rendu.

3. **Scanner les nouvelles pages** — ajouter `pages.<page>.view` au schéma et
   un garde au montage.

4. **Si le schéma a changé** — le dire explicitement dans la réponse finale,
   et incrémenter `version`. Il faut ensuite cliquer « Rafraîchir » dans
   Admin > Profils & Droits pour que le Hub recharge le cache.

### Comment gater

- **Backend** : `requirePerm('<clé>')` en middleware de route. Il respecte
  seul le toggle d'enforcement.
- **Nuancer plutôt qu'interdire** : `hasPerm(req, '<clé>')` renvoie un booléen
  sans bloquer — utilisé pour `comments.delete_any`, qui élargit un droit au
  lieu de le conditionner.
- **Admin bypass** : le rôle Keycloak `admin` passe outre, rien à coder.
- **Enforcement désactivé** : les gardes restent en place mais laissent tout
  passer. C'est voulu — on peut livrer sans rien casser.

### Ne jamais faire

- ❌ Hardcoder un contrôle (`if (user.id === 141)`) — passer par les permissions.
- ❌ Créer une route d'écriture sans `requirePerm`.
- ❌ Supprimer une clé du schéma — les grants en base deviendraient orphelins.
  Renommer par migration.
- ❌ Montrer la clé de permission à l'utilisateur — journaux serveur uniquement.

## Pièges de ce dépôt

**Aucune apostrophe inverse dans les commentaires SQL de `src/db/migrate.js`.**
Le schéma est un littéral de gabarit : une apostrophe inverse le termine et
casse le démarrage. Un test le vérifie (`test/schema-loads.test.mjs`) — il a
déjà rattrapé deux occurrences.

**En environnement CIE, UPS renvoie `1ZXXXXXXXXXXXXXXXX`** comme numéro de
suivi *et* comme identifiant d'expédition, identiques pour tous les envois.
D'où `local_shipment_id`, notre propre identifiant, qui seul regroupe les
colis d'une expédition. Ne jamais regrouper sur ce qu'UPS renvoie.

**`badRequest()` renvoie une erreur, il ne la lève pas** — écrire
`throw badRequest(...)`, sinon la validation ne fait rien.

**Les tests exigent `npm test`** : le drapeau `--experimental-test-module-mocks`
vit dans le script npm, et `node --test` seul échoue sur `mock.module`.

## Commandes

```bash
npm run dev                        # développement
npm test                           # 173 tests
node scripts/audit-permissions.mjs # gardes de permission manquantes
```
