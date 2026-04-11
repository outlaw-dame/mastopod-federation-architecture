FROM hexpm/elixir:1.15.4-erlang-26.0.2-alpine-3.18.2 AS builder

ARG AKKOMA_SOURCE_REPO=https://akkoma.dev/AkkomaGang/akkoma.git
ARG AKKOMA_SOURCE_REF=v3.18.1
ARG AKKOMA_SOURCE_COMMIT=792385f4ac1e258c21a3a900342c4ded14db1727

ENV MIX_ENV=prod
ENV ERL_EPMD_ADDRESS=127.0.0.1
ENV ERL_FLAGS="+S 2:2 +sbwt none +sbwtdcpu none +sbwtdio none"
ENV ELIXIR_ERL_OPTIONS="+S 2:2 +sbwt none +sbwtdcpu none +sbwtdio none"
ENV MAKEFLAGS=-j1

RUN apk add --no-cache \
  git \
  gcc \
  g++ \
  musl-dev \
  make \
  cmake \
  file-dev \
  exiftool \
  ffmpeg \
  imagemagick \
  libmagic \
  ncurses \
  postgresql-client

WORKDIR /src

RUN git clone --depth 1 --branch "${AKKOMA_SOURCE_REF}" "${AKKOMA_SOURCE_REPO}" /src \
  && test "$(git rev-parse HEAD)" = "${AKKOMA_SOURCE_COMMIT}"

RUN echo "import Config" > config/prod.secret.exs \
  && mix local.hex --force \
  && mix local.rebar --force \
  && mix deps.get --only prod \
  && mix release --path /opt/akkoma-release

FROM alpine:3.20

ENV MIX_ENV=prod
ENV ERL_EPMD_ADDRESS=127.0.0.1
ENV PLEROMA_CONFIG_PATH=/etc/akkoma/config.exs
ENV RELEASE_DISTRIBUTION=name
ENV RELEASE_NODE=pleroma@127.0.0.1

RUN apk add --no-cache \
  bash \
  ca-certificates \
  curl \
  exiftool \
  ffmpeg \
  file \
  imagemagick \
  ncurses-libs \
  postgresql15-client \
  su-exec

RUN addgroup -g 1000 akkoma \
  && adduser -u 1000 -G akkoma -D -h /opt/akkoma akkoma \
  && mkdir -p /opt/akkoma /etc/akkoma /var/lib/akkoma/uploads /var/lib/akkoma/static /var/lib/akkoma/modules \
  && chown -R akkoma:akkoma /opt/akkoma /etc/akkoma /var/lib/akkoma

COPY --from=builder /opt/akkoma-release/. /opt/akkoma/
COPY docker-entrypoint.sh /usr/local/bin/akkoma-entrypoint.sh

RUN chmod +x /usr/local/bin/akkoma-entrypoint.sh

WORKDIR /opt/akkoma

ENTRYPOINT ["/usr/local/bin/akkoma-entrypoint.sh"]
CMD ["/opt/akkoma/bin/pleroma", "start"]
