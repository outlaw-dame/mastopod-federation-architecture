# Official Bonfire Community RC8 release image. The verified release is
# downloaded into the local build context by prepare-rc8.sh; no network
# fetch or unpinned git clone occurs in this Dockerfile.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libssl3 libstdc++6 libpq5 libicu72 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/bonfire
COPY release/ /opt/bonfire/
RUN test -x /opt/bonfire/bin/bonfire
EXPOSE 4000
CMD ["/opt/bonfire/bin/bonfire", "start"]
