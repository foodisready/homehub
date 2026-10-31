# Docker Compose Reference

Original `docker-compose.yml` specification for HomeHub on Raspberry Pi 5.

> The `docker-compose.yml` and `packages/frontend/nginx.conf` files in the repo are the source of truth, and they differ from the examples below. Most importantly, the backend uses host networking, so other services reach it at `host.docker.internal:3000` rather than `backend:3000`.

---

## docker-compose.yml

```yaml
name: homehub

services:

  # ── Angular frontend served by Nginx ──────────────────────────
  frontend:
    build:
      context: ./packages/frontend
      dockerfile: Dockerfile
    ports:
      - "4200:80"
    depends_on:
      backend:
        condition: service_healthy
    restart: unless-stopped

  # ── Node.js core backend ───────────────────────────────────────
  backend:
    build:
      context: ./packages/backend
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    env_file: .env
    environment:
      - NODE_ENV=production
      - DB_PATH=/data/db.sqlite
      - OLLAMA_URL=http://ollama:11434
    volumes:
      - homehub-data:/data
    depends_on:
      ollama:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 20s
    restart: unless-stopped
    # Required for Kasa device discovery (UDP broadcast)
    network_mode: host   # see note below

  # ── MCP server (AI agent bridge) ──────────────────────────────
  mcp-server:
    build:
      context: ./packages/mcp-server
      dockerfile: Dockerfile
    ports:
      - "3001:3001"
    env_file: .env
    environment:
      - BACKEND_URL=http://backend:3000
    depends_on:
      backend:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    restart: unless-stopped

  # ── Automation scheduler (cron + solar) ───────────────────────
  scheduler:
    build:
      context: ./packages/scheduler
      dockerfile: Dockerfile
    env_file: .env
    environment:
      - BACKEND_URL=http://backend:3000
      - DB_PATH=/data/db.sqlite
    volumes:
      - homehub-data:/data
    depends_on:
      backend:
        condition: service_healthy
    restart: unless-stopped

  # ── Local LLM (Ollama) ─────────────────────────────────────────
  ollama:
    image: ollama/ollama:latest
    ports:
      - "11434:11434"   # internal only — not exposed via Tailscale
    volumes:
      - homehub-data:/root/.ollama
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:11434/api/tags"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 60s   # model pull may take time on first boot
    restart: unless-stopped

  # ── Tailscale sidecar (remote access) ─────────────────────────
  tailscale:
    image: tailscale/tailscale:latest
    hostname: homehub
    environment:
      - TS_AUTHKEY=${TS_AUTHKEY}
      - TS_STATE_DIR=/var/lib/tailscale
      - TS_EXTRA_ARGS=--advertise-tags=tag:homehub
      - TS_SERVE_CONFIG=/config/ts-serve.json
    volumes:
      - tailscale-state:/var/lib/tailscale
      - ./config/ts-serve.json:/config/ts-serve.json:ro
      - /dev/net/tun:/dev/net/tun
    cap_add:
      - NET_ADMIN
      - SYS_MODULE
    restart: unless-stopped

volumes:
  homehub-data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: ./data
  tailscale-state:
    driver: local
```

---

## docker-compose.override.yml (Development)

Used automatically by `docker compose up` in local dev. Mounts source for hot reload.

```yaml
services:

  backend:
    build:
      target: dev
    volumes:
      - ./packages/backend/src:/app/src
      - homehub-data:/data
    environment:
      - NODE_ENV=development
    command: npm run dev    # nodemon / tsx --watch

  scheduler:
    build:
      target: dev
    volumes:
      - ./packages/scheduler/src:/app/src
    command: npm run dev

  mcp-server:
    build:
      target: dev
    volumes:
      - ./packages/mcp-server/src:/app/src
    command: npm run dev

  frontend:
    build:
      target: dev
    ports:
      - "4200:4200"
    volumes:
      - ./packages/frontend/src:/app/src
    command: npm run start   # ng serve
```

---

## Dockerfile Pattern (Node.js services)

Each Node.js package (`backend`, `mcp-server`, `scheduler`) uses this multi-stage pattern:

```dockerfile
# packages/backend/Dockerfile

# ── Development stage ──────────────────────────────────────────
FROM node:24-alpine AS dev
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
CMD ["npm", "run", "dev"]

# ── Build stage ────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Production stage ───────────────────────────────────────────
FROM node:24-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

---

## Dockerfile: Frontend

```dockerfile
# packages/frontend/Dockerfile

# ── Development stage ──────────────────────────────────────────
FROM node:24-alpine AS dev
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 4200
CMD ["npm", "run", "start"]

# ── Build stage ────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Production stage (Nginx) ───────────────────────────────────
FROM nginx:alpine AS production
COPY --from=build /app/dist/frontend/browser /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

---

## Nginx Config (frontend)

```nginx
# packages/frontend/nginx.conf
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # Angular routing — all paths fall back to index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy API calls to backend
    location /api/ {
        proxy_pass http://backend:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Proxy Socket.io for real-time updates
    location /socket.io/ {
        proxy_pass http://backend:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

---

## Tailscale Serve Config

```json
// config/ts-serve.json
{
  "TCP": {
    "443": {
      "HTTPS": true
    }
  },
  "Web": {
    "homehub.your-tailnet.ts.net:443": {
      "Handlers": {
        "/": {
          "Proxy": "http://frontend:80"
        },
        "/api/": {
          "Proxy": "http://backend:3000"
        }
      }
    }
  }
}
```

---

## Key Notes

### Backend `network_mode: host`

The `tplink-smarthome-api` uses UDP broadcast for device discovery, which does not work inside Docker bridge networks. Two options:

1. **`network_mode: host`** — simplest, backend uses the Pi's actual network interface directly (recommended for Raspberry Pi)
2. **Static IPs only** — skip discovery, manually configure device IPs in the DB. Backend can use bridge networking, simpler but less convenient.

If using `network_mode: host`, remove the `ports:` section for backend (it binds directly to host ports).

### Ollama Model Pre-pull

On first startup, add an init container or entrypoint script to pre-pull the model:

```yaml
ollama:
  entrypoint: ["/bin/sh", "-c"]
  command: >
    "ollama serve &
    sleep 5 &&
    ollama pull ${OLLAMA_MODEL:-llama3.2:3b} &&
    wait"
```

### Headscale (Option B for fully self-hosted)

Add to `docker-compose.yml`:

```yaml
headscale:
  image: headscale/headscale:latest
  ports:
    - "8080:8080"
    - "9090:9090"   # metrics
  volumes:
    - ./config/headscale.yaml:/etc/headscale/config.yaml
    - headscale-data:/var/lib/headscale
  command: headscale serve
  restart: unless-stopped
```

Household members configure their Tailscale app's "Custom control server" to point at the Pi's headscale port over the local network (or via a public domain if available).
