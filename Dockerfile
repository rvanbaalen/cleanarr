# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app

# better-sqlite3 needs build tools on alpine
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.server.json tsconfig.ui.json vite.config.ts ./
COPY server ./server
COPY ui ./ui

RUN npm run build

# prune devDeps for a lean runtime
RUN npm prune --omit=dev

# ---- runtime stage ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Install runtime deps for better-sqlite3 native module (libstdc++)
RUN apk add --no-cache libstdc++

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

EXPOSE 3000
CMD ["node", "dist/server/index.js"]
