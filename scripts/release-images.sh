#!/usr/bin/env bash
# Build HomeHub's four images on this computer and push them to ghcr.io.
# Releases normally come from GitHub Actions (.github/workflows/release-images.yml)
# when a version tag is pushed; this script is the fallback.
#
#   scripts/release-images.sh            # 64-bit ARM (Raspberry Pi), tagged latest + commit
#   PLATFORMS=linux/arm64,linux/amd64 scripts/release-images.sh   # also Intel/AMD PCs
#
# Sign in first with `docker login ghcr.io` (a GitHub token with
# write:packages as the password). Images are built from committed code
# only: the script refuses to run with uncommitted changes, so a published
# image always matches a commit on GitHub. Secrets never enter an image:
# each package's .dockerignore excludes .env* and data/.
set -euo pipefail

cd "$(dirname "$0")/.."

PREFIX="${HOMEHUB_IMAGE_PREFIX:-ghcr.io/foodisready}"
PLATFORMS="${PLATFORMS:-linux/arm64}"
SERVICES=(backend frontend scheduler mcp-server)

if [ -n "$(git status --porcelain)" ]; then
  echo "Uncommitted changes. Commit them first, so the images match a commit." >&2
  exit 1
fi

COMMIT="$(git rev-parse --short HEAD)"
echo "Publishing HomeHub $COMMIT for $PLATFORMS as $PREFIX/homehub-*"

# The default docker builder can only push one platform at a time.
if [[ "$PLATFORMS" == *,* ]]; then
  docker buildx inspect homehub-release >/dev/null 2>&1 || docker buildx create --name homehub-release >/dev/null
  BUILDER=(--builder homehub-release)
else
  BUILDER=()
fi

for svc in "${SERVICES[@]}"; do
  echo "── $svc"
  # ${a[@]+...} keeps macOS's bash 3.2 happy with an empty array under set -u.
  docker buildx build ${BUILDER[@]+"${BUILDER[@]}"} \
    --platform "$PLATFORMS" \
    --target production \
    --build-arg "HOMEHUB_VERSION=$COMMIT" \
    --tag "$PREFIX/homehub-$svc:$COMMIT" \
    --tag "$PREFIX/homehub-$svc:latest" \
    --push \
    "packages/$svc"
done

echo
echo "Published $COMMIT. On the Pi, from the homehub folder:"
echo "  docker compose -f docker-compose.yml pull && docker compose -f docker-compose.yml up -d"
