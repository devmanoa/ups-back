# UPS Backend

API Node.js/Express qui encapsule les APIs REST UPS : suivi de colis, calcul de tarifs,
création d'étiquettes et recherche de points relais.

Les identifiants UPS restent côté serveur — le frontend ne les voit jamais.

## Installation

```bash
npm install
cp .env.example .env   # puis renseignez vos identifiants
npm run dev            # ou: npm start
```

Le serveur écoute sur `http://localhost:3000`.

## Configuration (.env)

| Variable | Requis | Description |
|---|---|---|
| `UPS_CLIENT_ID` | oui | Client ID de votre app sur [developer.ups.com](https://developer.ups.com) |
| `UPS_CLIENT_SECRET` | oui | Client Secret associé |
| `UPS_ACCOUNT_NUMBER` | pour Shipping | Numéro de compte UPS (6 caractères). Nécessaire aussi pour les tarifs négociés |
| `UPS_ENV` | non | `test` (défaut, CIE) ou `production` |
| `DATABASE_URL` | pour l'historique | Connexion PostgreSQL. Vide → page « Envois en cours » désactivée |
| `DATABASE_SSL` | non | `true` pour une base managée exigeant TLS |
| `PORT` | non | Port d'écoute (défaut `3000`) |
| `CORS_ORIGIN` | non | Origines autorisées, séparées par des virgules (défaut `http://localhost:5173`) |
| `SHIPPER_*` | pour Shipping | Adresse expéditeur par défaut |
| `KEYCLOAK_URL` | non | Serveur Keycloak. Vide → actions journalisées sans auteur |
| `KEYCLOAK_REALM` | non | Realm Keycloak (défaut `konitys`) |
| `AUTH_REQUIRED` | non | `true` = jeton obligatoire sur toutes les routes (`/health` excepté) |

**Environnements UPS :**
- `test` → `https://wwwcie.ups.com` (bac à sable, aucune expédition réelle facturée)
- `production` → `https://onlinetools.ups.com`

## Endpoints

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/health` | État du service et de la configuration |
| `GET` | `/api/auth/test` | Vérifie que les identifiants UPS fonctionnent |
| `GET` | `/api/tracking/:trackingNumber` | Suivi par numéro de colis |
| `GET` | `/api/tracking/reference/:ref` | Suivi par référence expéditeur |
| `GET` | `/api/rating/services` | Liste des codes service UPS |
| `POST` | `/api/rating` | Calcul de tarifs |
| `POST` | `/api/shipping` | Création d'expédition + étiquette |
| `DELETE` | `/api/shipping/:shipmentId` | Annulation d'une expédition |
| `POST` | `/api/locator/access-points` | Recherche de points relais |
| `GET` | `/api/diagnostic` | Teste chaque étape (config, jeton, APIs) et localise une panne |
| `POST` | `/api/transit-times` | Délais de livraison estimés |
| `POST` | `/api/landed-cost` | Droits de douane et taxes à l'import |
| `GET` | `/api/pickup/containers` | Types de conditionnement |
| `POST` | `/api/pickup` | Planification d'un enlèvement |
| `DELETE` | `/api/pickup/:prn` | Annulation d'un enlèvement |
| `GET` | `/api/paperless/document-types` | Types de documents douaniers |
| `POST` | `/api/paperless/upload` | Téléversement d'un document douanier |
| `POST` | `/api/paperless/link` | Rattachement d'un document à une expédition |
| `POST` | `/api/shipping/bulk` | Création groupée (50 expéditions max) |
| `GET` | `/api/shipments` | Historique paginé, avec recherche et filtres |
| `GET` | `/api/shipments/stats` | Répartition par statut |
| `GET` | `/api/shipments/anomalies` | Envois en retard, en incident ou immobiles |
| `POST` | `/api/shipments/refresh-status` | Actualise les statuts colis par colis (Tracking) |
| `POST` | `/api/shipments/sync` | Actualise tous les statuts en un appel (QuantumView) |
| `GET` | `/api/shipments/:tracking` | Détail d'un envoi enregistré |
| `GET` | `/api/shipments/:tracking/label` | Étiquette stockée, en base64 |
| `GET` | `/api/addresses` | Carnet d'adresses : liste, avec recherche et filtre par groupe |
| `POST` | `/api/addresses` | Enregistre une adresse |
| `PUT` | `/api/addresses/:id` | Modifie une adresse |
| `DELETE` | `/api/addresses/:id` | Archive une adresse (`?hard=true` pour supprimer) |
| `POST` | `/api/addresses/:id/restore` | Restaure une adresse archivée |
| `POST` | `/api/addresses/:id/use` | Enregistre une utilisation (tri par fréquence) |
| `GET` | `/api/addresses/groups` | Groupes et nombre d'adresses |
| `POST` | `/api/addresses/groups` | Crée un groupe |
| `PUT` | `/api/addresses/groups/:id` | Renomme un groupe |
| `DELETE` | `/api/addresses/groups/:id` | Supprime un groupe (les adresses sont conservées) |
| `GET` | `/api/activity` | Journal d'activité : qui a fait quoi, filtrable |
| `GET` | `/api/activity/actors` | Auteurs distincts, pour le filtre |
| `GET` | `/api/activity/summary` | Répartition des actions sur une période |
| `GET` | `/api/batches` | Lots d'envoi groupé (« commandes ») avec leur avancement |
| `GET` | `/api/batches/:batchId` | Détail d'un lot et de ses colis |

### Historique des envois

UPS ne fournit **aucune API** permettant de relire la liste des expéditions créées.
Chaque envoi est donc enregistré en base au moment de sa création, ce qui alimente la
page « Envois en cours ».

L'enregistrement ne peut jamais faire échouer une expédition : si la base est
indisponible, l'étiquette est tout de même retournée (elle est déjà facturée par UPS)
et l'échec est journalisé. La réponse porte alors `saved: false`.

### Deux façons d'actualiser les statuts

| Route | Mécanisme | Quand l'utiliser |
|---|---|---|
| `/refresh-status` | API Tracking, **un appel par colis** | Quelques envois, ou un colis précis |
| `/sync` | API QuantumView, **un seul appel** | Beaucoup d'envois à mettre à jour |

`/sync` est nettement plus économe en quota, mais impose deux contraintes UPS :
un **abonnement Quantum View** doit être configuré sur le compte, et les événements
ne remontent qu'à **environ 14 jours**. Les colis absents de l'historique local sont
ignorés — QuantumView renvoie aussi les envois créés hors de cette application.

### Carnet d'adresses

Référentiel d'adresses réutilisables, **partagé par tous les utilisateurs** :
une adresse enregistrée par une personne est immédiatement disponible pour les
autres. Les groupes (« antennes », « partenaires »…) sont plats, sans hiérarchie.

Les champs obligatoires sont exactement ceux que l'API Shipping exige d'un
destinataire (`name`, `addressLine1`, `city`, `postalCode`, `country`) : une
adresse du carnet est donc toujours expédiable.

Aucune clé étrangère ne relie le carnet à `shipments` — les envois recopient
l'adresse à leur création. Modifier ou archiver une entrée du carnet ne
réécrit jamais l'historique.

| Comportement | Détail |
|---|---|
| Suppression | Archivage par défaut (`archived_at`), restaurable. `?hard=true` supprime réellement |
| Suppression d'un groupe | Ses adresses sont conservées et deviennent « sans groupe » |
| Nom (`label`) | Unique parmi les adresses actives ; l'archivage libère le nom |
| Tri | Adresse par défaut d'abord, puis les plus utilisées (`usage_count`) |
| Sans `DATABASE_URL` | Les routes renvoient 503 ; le reste de l'application fonctionne |

### Journal d'activité (timeline)

Trace **les actions de l'équipe dans l'application** : étiquettes créées,
adresses ajoutées, envois annulés. À ne pas confondre avec l'historique UPS
(`/api/tracking`, `/api/shipments`), qui retrace le parcours du colis.

Seules les **écritures** sont journalisées : tracer les lectures noierait
l'information utile.

| Garantie | Détail |
|---|---|
| Ne fait jamais échouer l'action | Une étiquette créée est déjà facturée par UPS : un échec d'écriture du journal est avalé et signalé en console |
| Résumé figé à l'écriture | Renommer une adresse plus tard ne réécrit pas le passé — c'est un journal, pas une vue |
| Auteur recopié | `actor_name` est dupliqué, sans clé étrangère : Keycloak est la source d'identité, et un utilisateur supprimé n'efface pas l'histoire |
| Sans authentification | Les actions sont enregistrées avec un auteur vide, affiché « Utilisateur inconnu » |

Le filtre `action` accepte un préfixe : `?action=address` couvre
`address.create`, `address.update`, `address.archive`…

### Authentification Keycloak

Le frontend envoie déjà un jeton `Bearer` ; ces variables déterminent ce que
le backend en fait. Les jetons sont vérifiés (signature RS256, expiration,
émetteur) contre les clés publiques du realm, mises en cache une heure.
Aucune dépendance : `node:crypto` suffit.

| `KEYCLOAK_URL` | `AUTH_REQUIRED` | Comportement |
|---|---|---|
| absent | — | Aucun contrôle, actions journalisées sans auteur |
| présent | `false` (défaut) | Jeton vérifié s'il est fourni, sinon la requête passe |
| présent | `true` | Jeton obligatoire, `401` sinon |

> `/health` reste toujours joignable sans jeton : le healthcheck Coolify ne
> doit pas dépendre de Keycloak.
>
> Passez `AUTH_REQUIRED=true` seulement après avoir vérifié que le client
> Keycloak fonctionne, sinon toute l'application devient inaccessible.

### Commandes (lots d'envoi groupé)

Chaque appel à `/api/shipping/bulk` produit un `batch_id`. Les routes
`/api/batches` agrègent ces envois : aucune table dédiée, donc aucun état
supplémentaire à maintenir en cohérence. Un lot est dit terminé quand tous
ses colis sont livrés ou annulés.

### Détection d'anomalies

Quatre situations sont signalées sur les envois non terminés :

| Type | Déclencheur |
|---|---|
| `exception` | UPS signale un incident (adresse incorrecte, refus…) |
| `delayed` | Date de livraison prévue dépassée |
| `stalled` | Aucun événement depuis N jours alors que le colis circule |
| `never_picked_up` | Étiquette créée mais jamais scannée par UPS |

La date de livraison prévue est capturée via **Time In Transit** au moment de la
création de l'étiquette. Si UPS ne la fournit pas, la détection retombe sur un seuil
d'ancienneté et parle de « durée inhabituelle » plutôt que de retard.

Les anomalies sont calculées **à la lecture**, jamais stockées : modifier un seuil
prend effet immédiatement, et un envoi en sort dès qu'il repart.

| Variable | Défaut | Rôle |
|---|---|---|
| `ANOMALY_STALLED_DAYS` | `3` | Jours sans mouvement avant signalement |
| `ANOMALY_NEVER_PICKED_UP_DAYS` | `2` | Jours avant de signaler un colis non pris en charge |
| `ANOMALY_FALLBACK_DELAY_DAYS` | `7` | Seuil de repli sans date prévue connue |

### Exemples

Suivi :
```bash
curl http://localhost:3000/api/tracking/1Z12345E1512345676
```

Tarifs :
```bash
curl -X POST http://localhost:3000/api/rating \
  -H "Content-Type: application/json" \
  -d '{
    "shipTo": { "city": "Lyon", "postalCode": "69001", "country": "FR" },
    "packages": [{ "weight": 2.5, "length": 30, "width": 20, "height": 10 }],
    "requestOption": "Shop"
  }'
```

Points relais :
```bash
curl -X POST http://localhost:3000/api/locator/access-points \
  -H "Content-Type: application/json" \
  -d '{
    "address": { "city": "Paris", "postalCode": "75002", "country": "FR" },
    "radius": 25, "unit": "KM", "maxResults": 10
  }'
```

Étiquette :
```bash
curl -X POST http://localhost:3000/api/shipping \
  -H "Content-Type: application/json" \
  -d '{
    "shipTo": {
      "name": "Jean Dupont", "addressLine1": "10 rue Victor Hugo",
      "city": "Lyon", "postalCode": "69001", "country": "FR"
    },
    "packages": [{ "weight": 2 }],
    "serviceCode": "11",
    "labelFormat": "GIF"
  }'
```

L'étiquette est renvoyée en base64 dans `data.packages[].label.base64`.

## Format des réponses

Succès :
```json
{ "success": true, "data": { } }
```

Erreur (toutes les erreurs suivent cette forme) :
```json
{
  "success": false,
  "error": { "message": "…", "code": "…", "upsCodes": ["…"] }
}
```

## Architecture

```
src/
├── config.js              Configuration + versions d'API
├── server.js              Assemblage Express
├── services/
│   ├── auth.js            OAuth2 client_credentials + cache du jeton
│   ├── upsClient.js       Client HTTP UPS (auth, retry 401, erreurs)
│   ├── tracking.js        Suivi
│   ├── rating.js          Tarifs
│   ├── shipping.js        Étiquettes
│   ├── locator.js         Points relais
│   ├── keycloak.js        Vérification des jetons JWT (JWKS en cache)
│   └── activity.js        Journalisation des actions
├── db/
│   ├── pool.js            Pool PostgreSQL partagé (optionnel)
│   ├── migrate.js         Schéma créé au démarrage, idempotent
│   ├── shipmentsRepository.js   Historique des envois
│   ├── addressesRepository.js   Carnet d'adresses partagé
│   ├── activityRepository.js    Journal d'activité
│   └── batchesRepository.js     Lots d'envoi groupé (agrégation)
├── routes/                Routes Express + validation d'entrée
└── middleware/            Validation, authentification, gestion d'erreurs
```

Le jeton OAuth (valable ~4 h) est mis en cache et renouvelé automatiquement une minute
avant expiration ; les appels concurrents partagent la même requête de renouvellement.

## Versions d'API utilisées

Figées d'après les specs OpenAPI officielles
([UPS-API/api-documentation](https://github.com/UPS-API/api-documentation)) :
Tracking `v1`, Rating `v2409`, Shipping `v2409`, Locator `v3`.

## Déploiement (Docker / Coolify)

```bash
docker build -t ups-backend .
docker run -p 3000:3000 --env-file .env ups-backend
```

Sur Coolify : Build Pack **Dockerfile**, port `3000`, Health Check Path `/health`.
Toute la configuration passe par les variables d'environnement (voir tableau ci-dessus).

`CORS_ORIGIN` doit contenir l'URL exacte du frontend, sinon les appels seront bloqués
par le navigateur.

## Limites connues

- **Shipping** : nécessite `UPS_ACCOUNT_NUMBER` et une adresse expéditeur complète.
- **Tarifs négociés** : renvoyés uniquement si le compte UPS en dispose.
