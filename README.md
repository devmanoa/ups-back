# UPS Backend

API Node.js/Express qui encapsule les APIs REST UPS : suivi de colis, calcul de tarifs,
création d'étiquettes, validation d'adresse et recherche de points relais.

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
| `PORT` | non | Port d'écoute (défaut `3000`) |
| `CORS_ORIGIN` | non | Origines autorisées, séparées par des virgules (défaut `http://localhost:5173`) |
| `SHIPPER_*` | pour Shipping | Adresse expéditeur par défaut |

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
| `POST` | `/api/address/validate` | Validation d'adresse (US/PR uniquement) |
| `POST` | `/api/locator/access-points` | Recherche de points relais |

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
│   ├── addressValidation.js
│   └── locator.js         Points relais
├── routes/                Routes Express + validation d'entrée
└── middleware/            Validation et gestion d'erreurs
```

Le jeton OAuth (valable ~4 h) est mis en cache et renouvelé automatiquement une minute
avant expiration ; les appels concurrents partagent la même requête de renouvellement.

## Versions d'API utilisées

Figées d'après les specs OpenAPI officielles
([UPS-API/api-documentation](https://github.com/UPS-API/api-documentation)) :
Tracking `v1`, Rating `v2409`, Shipping `v2409`, Address Validation `v2`, Locator `v3`.

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

- **Validation d'adresse** : l'API UPS ne couvre que les États-Unis et Porto Rico.
- **Shipping** : nécessite `UPS_ACCOUNT_NUMBER` et une adresse expéditeur complète.
- **Tarifs négociés** : renvoyés uniquement si le compte UPS en dispose.
