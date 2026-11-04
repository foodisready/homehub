FROM node:24-alpine AS dev
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 3000
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

# Set by docker-compose from $HOMEHUB_VERSION so the running container
# knows what release it is — surfaced via /api/system/version. "dev"
# means a local build with no upstream comparison.
ARG HOMEHUB_VERSION=dev

RUN addgroup -S appgroup && adduser -S -G appgroup appuser
# A new named volume inherits this ownership, which lets appuser write the DB.
RUN mkdir -p /data && chown appuser:appgroup /data

WORKDIR /app

COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/assets ./assets
COPY --from=builder --chown=appuser:appgroup /app/package*.json ./

USER appuser

ENV NODE_ENV=production
ENV PORT=3000
ENV HOMEHUB_VERSION=$HOMEHUB_VERSION
EXPOSE $PORT

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+process.env.PORT+'/health',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
