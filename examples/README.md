# Exemples d'intégration

Code à copier dans l'application qui appellera l'API UPS. Contrat complet
dans [../API-V1.md](../API-V1.md).

| Fichier | Rôle |
|---|---|
| `ups-client.js` | Client Node.js, sans dépendance. **Le fichier à copier.** |
| `usage.js` | Les cinq flux, exécutables tels quels |
| `react/server-proxy.js` | Proxy Express détenant la clé |
| `react/CreateLabel.tsx` | Composant React avec impression |

## Node.js

```bash
UPS_API_URL=https://<backend> UPS_API_KEY=<votre-cle> node usage.js
```

```js
import { createUpsClient } from './ups-client.js';

const ups = createUpsClient({
  baseUrl: process.env.UPS_API_URL,
  apiKey: process.env.UPS_API_KEY,
});

const envoi = await ups.createShipment({
  shipTo: { name: 'Antenne Lyon', addressLine1: '10 rue Victor Hugo', city: 'Lyon', postalCode: '69001', country: 'FR' },
  packages: [{ weight: '2.5' }],
  reference: 'CMD-4321',
});

console.log(envoi.trackingNumbers[0]);
```

## React

Le navigateur passe par le backend de votre application, qui seul détient la
clé :

```
Navigateur  →  votre backend (server-proxy.js)  →  /api/v1
```

Une clé placée dans du code React ou dans une variable `VITE_*` se retrouve
dans le bundle et dans l'onglet Réseau. Elle appelle un compte UPS facturé :
n'importe quel visiteur pourrait créer des étiquettes à vos frais.

```js
// backend de votre application
import { upsProxyRouter } from './server-proxy.js';
app.use('/api/ups', upsProxyRouter);
```

```tsx
// frontend
import { CreateLabel } from './CreateLabel';
```

`CreateLabel.tsx` suppose react-query et Tailwind, comme le frontend UPS.
Sans eux, remplacez `useMutation` par un `useState` et les classes par les
vôtres — la logique d'appel et d'impression ne change pas.

## Trois pièges

**La clé ne va jamais au navigateur.** Ni URL, ni code front, ni variable
`VITE_*`. Serveur à serveur uniquement.

**Une commande partiellement échouée renvoie 207.** Les étiquettes obtenues
sont facturées : ne réessayez que les lignes en échec, sinon vous créez des
doublons.

**En bac à sable, le numéro de suivi ne distingue pas les envois.** UPS
renvoie `1ZXXXXXXXXXXXXXXXX` pour tous. Conservez le champ `id`, unique dans
les deux environnements.
