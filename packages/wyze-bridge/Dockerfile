# HomeHub's Wyze camera bridge: IDisposable's wyze-bridge, with its go2rtc
# rebuilt to add pan and tilt for Wyze Pan cameras (go2rtc-wyze-ptz.patch).
# Everything else is the upstream image, unchanged.

# The go2rtc the bridge ships, built from source with the patch.
FROM golang:1.24-alpine@sha256:8bee1901f1e530bfb4a7850aa7a479d17ae3a18beb6e09064ed54cfd245b7191 AS go2rtc
ARG GO2RTC_VERSION=v1.9.14
ARG GO2RTC_COMMIT=b5948cf
RUN apk add --no-cache git
WORKDIR /src
RUN git clone --quiet --depth 1 --branch "$GO2RTC_VERSION" https://github.com/AlexxIT/go2rtc.git . \
 && test "$(git rev-parse --short=7 HEAD)" = "$GO2RTC_COMMIT"
COPY go2rtc-wyze-ptz.patch /tmp/
RUN git apply /tmp/go2rtc-wyze-ptz.patch
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod \
    go test ./pkg/wyze/ ./internal/wyze/ \
 && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /go2rtc .

FROM idisposablegithub365/wyze-bridge:4.5.0@sha256:708903d2882c76966ecb29763a075372d89773aa6796d0aab70f04369cc6d521 AS production
COPY --from=go2rtc /go2rtc /usr/local/bin/go2rtc
