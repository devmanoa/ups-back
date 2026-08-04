# syntax=docker/dockerfile:1
FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

# Les dépendances sont installées avant la copie du code : cette couche
# n'est reconstruite que si package*.json change.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Exécution sans privilèges root (l'image node fournit déjà l'utilisateur "node").
USER node

EXPOSE 3000

# Healthcheck lu par Coolify pour valider le déploiement.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
