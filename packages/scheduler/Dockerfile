FROM node:24-alpine AS dev
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
CMD ["npm", "run", "dev"]

# ── Build stage ─────────────────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --production

# ── Production stage ─────────────────────────────────────────────
FROM node:24-alpine AS production

RUN addgroup -S appgroup && adduser -S -G appgroup appuser
# A new named volume inherits this ownership, which lets appuser write the DB.
RUN mkdir -p /data && chown appuser:appgroup /data

WORKDIR /app

COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/package*.json ./

USER appuser

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
