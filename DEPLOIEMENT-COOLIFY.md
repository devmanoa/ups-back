# Déploiement sur Coolify

Deux ressources Coolify indépendantes, une par dépôt Git.

| Projet | Type Coolify | Port interne | Domaine suggéré |
|---|---|---|---|
| `ups-backend` | Dockerfile | `3000` | `api-ups.mondomaine.fr` |
| `ups-frontend` | Dockerfile | `80` | `ups.mondomaine.fr` |

---

## 1. Pousser les dépôts

Chaque projet a déjà son dépôt Git initialisé (branche `main`).
Créez deux dépôts vides chez votre hébergeur, puis :

```bash
cd E:\DEV\UPS\ups-backend
git remote add origin git@github.com:VOTRE-COMPTE/ups-backend.git
git push -u origin main

cd E:\DEV\UPS\ups-frontend
git remote add origin git@github.com:VOTRE-COMPTE/ups-frontend.git
git push -u origin main
```

---

## 2. Ressource backend

**Création :** New Resource → Application → votre dépôt `ups-backend` → Build Pack **Dockerfile**.

**Configuration :**
- Port Exposed : `3000`
- Domaine : `https://api-ups.mondomaine.fr`
- Health Check Path : `/health`

**Variables d'environnement :**

```
UPS_CLIENT_ID=votre_client_id
UPS_CLIENT_SECRET=votre_client_secret
UPS_ACCOUNT_NUMBER=votre_numero_compte
UPS_ENV=test
NODE_ENV=production
PORT=3000
CORS_ORIGIN=https://ups.mondomaine.fr
SHIPPER_NAME=Ma Societe
SHIPPER_ATTENTION_NAME=Service Expedition
SHIPPER_PHONE=0102030405
SHIPPER_ADDRESS_LINE=1 rue de la Paix
SHIPPER_CITY=Paris
SHIPPER_POSTAL_CODE=75002
SHIPPER_COUNTRY=FR
```

> **`CORS_ORIGIN` est le réglage le plus critique.** Il doit contenir l'URL exacte du
> frontend (avec `https://`, sans barre oblique finale). En cas d'erreur, l'interface
> se charge mais tous les appels sont bloqués par le navigateur.
>
> Passez `UPS_ENV=production` seulement après validation en environnement de test.

---

## 3. Ressource frontend

**Création :** New Resource → Application → votre dépôt `ups-frontend` → Build Pack **Dockerfile**.

**Configuration :**
- Port Exposed : `80`
- Domaine : `https://ups.mondomaine.fr`

**Variable d'environnement :**

```
VITE_API_URL=https://api-ups.mondomaine.fr
```

> Cette URL est injectée **au démarrage du conteneur**, pas au build : la modifier et
> redémarrer suffit, aucun rebuild n'est nécessaire.
>
> Dans Coolify, décochez « Build Variable » pour cette variable — elle doit être
> disponible au runtime.

---

## 4. Ordre de déploiement

1. Déployez le **backend** en premier.
2. Vérifiez `https://api-ups.mondomaine.fr/health` — la réponse doit indiquer
   `"credentialsConfigured": true`.
3. Testez l'authentification UPS : `https://api-ups.mondomaine.fr/api/auth/test`.
4. Déployez le **frontend**.
5. Ouvrez `https://ups.mondomaine.fr` — le badge en haut à droite doit afficher
   « Connecté — test » (ou « production »).

---

## 5. Diagnostic

| Symptôme | Cause probable | Correction |
|---|---|---|
| Badge « Backend injoignable » | `VITE_API_URL` absente ou erronée | Corrigez la variable et redémarrez le conteneur frontend |
| Erreurs CORS dans la console | `CORS_ORIGIN` ne correspond pas au domaine frontend | Alignez exactement les deux URL, puis redéployez le backend |
| Badge « Identifiants UPS manquants » | `UPS_CLIENT_ID` / `UPS_CLIENT_SECRET` absents | Ajoutez-les côté backend |
| Badge « Authentification UPS échouée » | Identifiants invalides, ou identifiants de test utilisés en production | Vérifiez les identifiants et la valeur de `UPS_ENV` |
| Étiquettes en erreur | `UPS_ACCOUNT_NUMBER` absent ou adresse expéditeur incomplète | Complétez les variables `SHIPPER_*` |
| Healthcheck backend en échec | Application non démarrée | Consultez les logs Coolify ; `/health` répond même sans identifiants UPS |

---

## Notes techniques

- **Backend** : image `node:22-alpine`, exécution sans privilèges root, healthcheck sur `/health`.
- **Frontend** : build multi-stage (Node pour compiler, Nginx pour servir) — image finale légère.
- Les fichiers `Dockerfile`, `nginx.conf` et `docker-entrypoint.sh` sont versionnés en
  fins de ligne LF (via `.gitattributes`) : en CRLF, le conteneur refuserait de démarrer.
- Le jeton OAuth UPS est mis en cache en mémoire. Au redémarrage d'un conteneur, un
  nouveau jeton est demandé automatiquement.
- Les fichiers `.env` ne sont jamais versionnés : la configuration passe uniquement par
  les variables d'environnement Coolify.
