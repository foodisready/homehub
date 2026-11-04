# HomeHub's updater: Node and the Docker command line, nothing else.
FROM node:24-alpine AS production
RUN apk add --no-cache docker-cli docker-cli-compose
WORKDIR /app
COPY package.json server.js ./
ARG HOMEHUB_VERSION=dev
ENV HOMEHUB_VERSION=$HOMEHUB_VERSION NODE_ENV=production
# Root, to use the Docker socket. It listens on 127.0.0.1 only.
CMD ["node", "server.js"]
