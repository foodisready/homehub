# HomeHub

## Backend tests

Never run backend tests under `tsx`. It moves imports above the test setup, so tests can run against the real database in `packages/backend/data/db.sqlite`.

Compile first and run the CommonJS output:

```bash
cd packages/backend
node_modules/.bin/tsc
node --test $(find dist -name '*.test.js')
```

### Matter tests

The Matter tests (`dist/matter/*.test.js`) need mDNS. On a Mac, the sandbox blocks it, so they fail locally. Run the rest with `! -path '*matter*'` added to the `find` above, and the Matter tests in the backend dev image:

```bash
cd packages/backend
docker build -q --target dev -t hh-backend-dev .
docker run --rm -v "$PWD/src":/app/src -v "$PWD/test-fixtures":/app/test-fixtures hh-backend-dev \
  sh -c 'node_modules/.bin/tsc && node --test --test-concurrency=1 --test-timeout=150000 dist/matter/*.test.js'
```

## Production start

Name the compose file explicitly:

```bash
docker compose -f docker-compose.yml up -d --build
```

A plain `docker compose up` also applies `docker-compose.override.yml`, which runs the development builds.
