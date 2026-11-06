# Imagem da API e do worker do autoflow (usada pelo docker-compose.vps.yml)
FROM node:22-slim

WORKDIR /app

# Dependências (inclui as de desenvolvimento: tsc para compilar e tsx para as migrations)
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY templates ./templates
COPY supabase ./supabase
RUN npm run build

ENV NODE_ENV=production
CMD ["node", "dist/api/server.js"]
