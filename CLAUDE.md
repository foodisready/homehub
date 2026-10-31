# HomeHub

## Backend tests

Never run backend tests under `tsx`. It moves imports above the test setup, so tests can run against the real database in `packages/backend/data/db.sqlite`.

Compile first and run the CommonJS output:

```bash
cd packages/backend
node_modules/.bin/tsc
node --test $(find dist -name '*.test.js')
```

## Production start

Name the compose file explicitly:

```bash
docker compose -f docker-compose.yml up -d --build
```

A plain `docker compose up` also applies `docker-compose.override.yml`, which runs the development builds.
