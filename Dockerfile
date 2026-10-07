FROM node:22-slim

# git lets Reverie install/update SillyTavern extensions from their repositories.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

ENV NODE_ENV=production \
    PORT=8000
EXPOSE 8000
CMD ["node", "server/index.js"]
