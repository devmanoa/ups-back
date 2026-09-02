# API machine — `/api/v1`

Permet à une autre application de piloter cette application-ci comme un
service d'expédition : créer des étiquettes, les récupérer, les annuler,
sans passer par l'interface.

Base : `https://<domaine-du-backend>/api/v1`

---

## Authentification

Toute requête porte l'en-tête `X-API-Key` :

```
X-API-Key: votre-cle-secrete
```

La clé est délivrée par l'administrateur du backend, qui l'ajoute à la
variable `API_KEYS` au format `nom:clé`. Le *nom* apparaît comme auteur dans
le journal d'activité : les envois créés par votre application y sont
identifiés au lieu d'être anonymes.

| Réponse | Cause |
|---|---|
| `401 INVALID_API_KEY` | Clé absente ou incorrecte |
| `503 API_KEYS_NOT_CONFIGURED` | Aucune clé configurée côté serveur |

**La clé ne doit jamais transiter par un navigateur** — ni dans une URL, ni
dans du code front. Elle appelle un compte UPS facturé : quiconque la détient
peut générer des étiquettes à vos frais. Les appels se font de serveur à
serveur.

---

## Vérifier son intégration

```http
GET /api/v1/ping
X-API-Key: votre-cle
```

```json
{ "success": true, "data": { "client": "antennes", "environment": "test" } }
```

`environment` vaut `test` (bac à sable UPS, étiquettes non valides) ou
`production` (étiquettes réelles, **facturées**).

Les codes de service et formats d'étiquette acceptés :

```http
GET /api/v1/services
```

---

## Créer une étiquette

```http
POST /api/v1/shipments
X-API-Key: votre-cle
Content-Type: application/json
```

```json
{
  "shipTo": {
    "name": "Antenne Lyon",
    "attentionName": "Marie Dupont",
    "addressLine1": "10 rue Victor Hugo",
    "city": "Lyon",
    "postalCode": "69001",
    "country": "FR",
    "phone": "0472000000"
  },
  "packages": [{ "weight": "2.5", "length": "30", "width": "20", "height": "15" }],
  "serviceCode": "11",
  "labelFormat": "GIF",
  "reference": "CMD-4321"
}
```

| Champ | Obligatoire | Détail |
|---|---|---|
| `shipTo` | oui | `name`, `addressLine1`, `city`, `postalCode`, `country` requis |
| `packages` | oui | Au moins un colis ; `weight` en kg |
| `serviceCode` | non | Défaut `11` (UPS Standard) |
| `labelFormat` | non | `GIF` (défaut), `PDF`, `ZPL` |
| `shipFrom` | non | Adresse de départ ; sinon celle configurée par défaut |
| `reference` | non | **Votre** identifiant de commande, conservé et cherchable |

**Réponse `201`**

```json
{
  "success": true,
  "data": {
    "id": "a3f1...-uuid",
    "shipmentId": "1ZXXXSHIP",
    "trackingNumbers": ["1Z999AA10123456784"],
    "labelFormat": "GIF",
    "labels": [{ "trackingNumber": "1Z999AA10123456784", "base64": "R0lGOD...", "mime": "image/gif" }],
    "labelUrl": "/api/v1/shipments/a3f1...-uuid/label",
    "totalCharges": 12.5,
    "currency": "EUR"
  }
}
```

Conservez `id` : c'est lui qui identifie l'envoi par la suite.

### Types de colis nommés

Si le catalogue du back-office contient un type, désignez-le au lieu de
répéter poids et dimensions :

```json
{ "packages": [{ "packageType": "DS620" }] }
```

Une valeur explicite prime toujours sur celle du type.

---

## Créer une commande (plusieurs expéditions)

```http
POST /api/v1/orders
```

```json
{
  "shipFrom": { "name": "Selfizee", "addressLine1": "...", "city": "...", "postalCode": "...", "country": "FR" },
  "serviceCode": "11",
  "shipments": [
    { "shipTo": { "...": "" }, "packages": [{ "weight": "1" }], "reference": "CMD-1" },
    { "shipTo": { "...": "" }, "packages": [{ "weight": "2" }], "reference": "CMD-2" }
  ]
}
```

50 expéditions maximum. `shipFrom`, `serviceCode`, `labelFormat` et
`description` valent pour tout le lot ; chaque ligne peut les redéfinir.

**Codes de retour**

| Code | Signification |
|---|---|
| `201` | Toutes les étiquettes créées |
| `207` | Certaines créées, d'autres en échec |
| `400` | Une ligne est invalide — **aucune** étiquette créée |
| `502` | Toutes en échec |

Le `400` mérite attention : la validation est faite avant le premier appel
UPS, donc une ligne mal formée annule toute la commande sans rien facturer.
En revanche, une adresse *refusée par UPS* n'annule pas les étiquettes déjà
obtenues — elles sont facturées. D'où le `207`, et le détail ligne par ligne :

```json
{
  "success": true,
  "data": {
    "orderId": "batch-1756800000000",
    "created": 1, "failed": 1, "total": 2,
    "results": [
      { "index": 0, "ok": true,  "reference": "CMD-1", "shipment": { "...": "" } },
      { "index": 1, "ok": false, "reference": "CMD-2", "error": "Adresse invalide", "upsCodes": ["120205"] }
    ]
  }
}
```

**Au réessai, ne renvoyez que les lignes en échec** — relancer toute la
commande créerait des doublons facturés.

---

## Récupérer une étiquette

```http
GET /api/v1/shipments/{id}/label
```

En base64 (défaut) :

```json
{ "success": true, "data": { "labels": [{ "trackingNumber": "1Z...", "format": "GIF", "base64": "R0lGOD..." }] } }
```

En fichier binaire, prêt à imprimer ou stocker :

```http
GET /api/v1/shipments/{id}/label?format=binary
```

Un envoi multi-colis renvoie autant d'étiquettes que de colis. En binaire,
seule la première est servie.

---

## Consulter un envoi

```http
GET /api/v1/shipments/{id}
```

```json
{
  "success": true,
  "data": {
    "id": "a3f1...-uuid",
    "status": "in_transit",
    "statusDescription": "En cours d'acheminement",
    "createdAt": "2026-09-02T10:00:00.000Z",
    "expectedDelivery": "2026-09-04",
    "deliveredAt": null,
    "recipient": { "name": "Antenne Lyon", "city": "Lyon", "postalCode": "69001", "country": "FR" },
    "trackingNumbers": ["1Z999AA10123456784"],
    "labelUrl": "/api/v1/shipments/a3f1.../label"
  }
}
```

`status` : `created`, `in_transit`, `delivered`, `exception`, `voided`.

Une commande entière :

```http
GET /api/v1/orders/{orderId}
```

`completed` passe à `true` quand plus aucun envoi ne bouge : c'est le signal
pour cesser d'interroger.

---

## Annuler une expédition

```http
DELETE /api/v1/shipments/{shipmentId}
```

L'identifiant attendu ici est le `shipmentId` **UPS** (pas l'`id` local),
seul reconnu par l'API d'annulation.

Une annulation n'est possible que tant que le colis n'a pas été remis au
transporteur.

---

## Erreurs

Toutes les erreurs suivent la même forme :

```json
{ "success": false, "error": { "message": "…", "code": "…" } }
```

| Code HTTP | Signification |
|---|---|
| `400` | Requête invalide — rien n'a été créé ni facturé |
| `401` | Clé absente ou invalide |
| `404` | Envoi ou commande introuvable |
| `502` | UPS a refusé ou est indisponible |
| `503` | Base de données ou clés non configurées |

---

## Exemples prêts à l'emploi

| Fichier | Usage |
|---|---|
| [`examples/ups-client.js`](examples/ups-client.js) | Client Node.js, sans dépendance — à copier dans votre application |
| [`examples/usage.js`](examples/usage.js) | Les cinq flux, exécutables tels quels |
| [`examples/react/server-proxy.js`](examples/react/server-proxy.js) | Proxy Express : le serveur détient la clé, pas le navigateur |
| [`examples/react/CreateLabel.tsx`](examples/react/CreateLabel.tsx) | Composant React (react-query) avec impression |

Lancer les exemples Node :

```bash
UPS_API_URL=https://<backend> UPS_API_KEY=<votre-cle> node examples/usage.js
```

### En React : passer par votre propre backend

Le navigateur ne doit **jamais** appeler `/api/v1` directement. Une clé
placée dans du code React — ou dans une variable `VITE_*` — se retrouve dans
le bundle et dans l'onglet Réseau : n'importe quel visiteur pourrait créer
des étiquettes facturées sur votre compte.

```
Navigateur  →  votre backend (détient la clé)  →  /api/v1
```

C'est le même raisonnement que pour `ANTENNES_WS_TOKEN`, gardé côté serveur.
Votre proxy doit par ailleurs authentifier ses propres utilisateurs, sans
quoi il devient une API UPS ouverte à tout Internet.

---

## Exemple complet

```bash
curl -X POST https://<backend>/api/v1/shipments \
  -H "X-API-Key: $UPS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "shipTo": {
      "name": "Antenne Lyon",
      "addressLine1": "10 rue Victor Hugo",
      "city": "Lyon",
      "postalCode": "69001",
      "country": "FR"
    },
    "packages": [{ "weight": "2.5" }],
    "reference": "CMD-4321"
  }'
```

```php
<?php
// PHP, sans dépendance
$payload = [
    'shipTo' => [
        'name' => 'Antenne Lyon',
        'addressLine1' => '10 rue Victor Hugo',
        'city' => 'Lyon',
        'postalCode' => '69001',
        'country' => 'FR',
    ],
    'packages' => [['weight' => '2.5']],
    'reference' => 'CMD-4321',
];

$ch = curl_init('https://<backend>/api/v1/shipments');
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => [
        'Content-Type: application/json',
        'X-API-Key: ' . getenv('UPS_API_KEY'),
    ],
    CURLOPT_POSTFIELDS => json_encode($payload),
]);

$response = json_decode(curl_exec($ch), true);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($code !== 201) {
    throw new RuntimeException($response['error']['message'] ?? 'Erreur inconnue');
}

// Étiquette prête à imprimer
file_put_contents('etiquette.gif', base64_decode($response['data']['labels'][0]['base64']));
$suivi = $response['data']['trackingNumbers'][0];
```

---

## En bac à sable

Avec `UPS_ENV=test`, UPS renvoie des valeurs factices : le numéro de suivi
est `1ZXXXXXXXXXXXXXXXX` pour **tous** les envois, et l'étiquette porte la
mention « SAMPLE » au lieu d'un code-barres.

Ne vous servez donc jamais du numéro de suivi comme clé en test : utilisez
le champ `id`, qui reste unique dans les deux environnements.
