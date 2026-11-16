"""Local-only provider profile. Never enables disposable identity shortcuts."""
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess

API = "https://provider.paper.test:8443"
UI = "https://login.paper.test:8443"


def add_provider(destination, checkout, lock, config, run, write):
    run("git", "-C", str(checkout), "cat-file", "-e", lock["activitypods"] + "^{commit}")
    build = destination / "provider-build"
    build.mkdir(mode=0o700)
    archive = destination / "provider-source.tar"
    with archive.open("xb") as stream:
        run("git", "-C", str(checkout), "archive", lock["activitypods"], "pod-provider", stdout=stream)
    run("tar", "-xf", str(archive), "-C", str(build))
    archive.unlink()
    for path in build.rglob("*"):
        if not path.is_symlink():
            path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
    password = secrets.token_hex(32)
    write(destination / "secrets/fuseki", password + "\n")
    private_env = {"SEMAPPS_JENA_PASSWORD": password}
    for name in ("SEMAPPS_COOKIE_SECRET", "ACTIVITYPODS_TOKEN", "SIDECAR_TOKEN", "SIGNING_API_TOKEN"):
        private_env[name] = secrets.token_hex(32)
    write(destination / "secrets/provider.json", json.dumps(private_env))
    here = Path(__file__).resolve().parent
    for name in ("provider-start.cjs", "provider-probe.mjs"):
        shutil.copyfile(here / name, build / name)
        (build / name).chmod(0o644)
    write(build / "Backend.Dockerfile", f'''FROM {lock['node_image']}
WORKDIR /app
COPY pod-provider/backend/ ./
RUN npm ci --no-audit --no-fund && mkdir -p jwt uploads && chown -R node:node jwt uploads
COPY provider-start.cjs /staging/provider-start.cjs
COPY provider-probe.mjs /staging/provider-probe.mjs
ENV NODE_ENV=production
CMD ["node", "/staging/provider-start.cjs"]
''')
    write(build / "Frontend.Dockerfile", f'''FROM {lock['node_image']} AS build
WORKDIR /app
COPY pod-provider/frontend/ ./
RUN npm ci --no-audit --no-fund
ENV REACT_APP_CONFIG_URL={API}/.well-known/config.js
RUN npm run build
FROM {lock['caddy_image']}
COPY --from=build /app/build /srv
COPY Frontend.Caddyfile /etc/caddy/Caddyfile
''')
    write(build / "Frontend.Caddyfile", ":8080 {\n  root * /srv\n  try_files {path} /index.html\n  file_server\n}\n")
    # One short-lived certificate for the two explicitly routed local names.
    ca = destination / "private-ca"
    certs = destination / "certificates"
    quiet = {"stdout": subprocess.DEVNULL, "stderr": subprocess.PIPE}
    run("openssl", "req", "-newkey", "rsa:3072", "-nodes", "-subj", "/CN=provider.paper.test",
        "-keyout", str(certs / "browser.key"), "-out", str(ca / "browser.csr"), **quiet)
    write(ca / "browser-extensions", "subjectAltName=DNS:provider.paper.test,DNS:login.paper.test\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
    run("openssl", "x509", "-req", "-in", str(ca / "browser.csr"), "-CA", str(certs / "ca.crt"),
        "-CAkey", str(ca / "ca.key"), "-CAcreateserial", "-days", "7", "-extfile", str(ca / "browser-extensions"),
        "-out", str(certs / "browser.crt"), **quiet)
    (certs / "browser.key").chmod(0o600)
    (certs / "ca.crt").chmod(0o644)
    write(destination / "Caddyfile", '''{
  admin off
  auto_https off
}
https://provider.paper.test:8443 {
  tls /certificates/browser.crt /certificates/browser.key
  reverse_proxy provider:3000
}
https://login.paper.test:8443 {
  tls /certificates/browser.crt /certificates/browser.key
  reverse_proxy frontend:8080
}
''')
    write(destination / "fuseki-start.sh", '''#!/bin/sh
set -eu
ADMIN_PASSWORD=$(cat /run/fuseki-password)
export ADMIN_PASSWORD
exec /docker-entrypoint.sh /jena-fuseki/fuseki-server
''')
    env = {
        "NODE_ENV": "production", "SEMAPPS_INSTANCE_NAME": "Paper local staging",
        "SEMAPPS_INSTANCE_DESCRIPTION_EN": "Disposable local signup acceptance",
        "SEMAPPS_AVAILABLE_LOCALES": "en", "SEMAPPS_DEFAULT_LOCALE": "en",
        "SEMAPPS_HOME_URL": API + "/", "SEMAPPS_FRONTEND_URL": UI + "/", "SEMAPPS_PORT": "3000",
        "SEMAPPS_SPARQL_ENDPOINT": "http://fuseki:3030/", "SEMAPPS_JENA_USER": "admin",
        "SEMAPPS_FUSEKI_BASE": "/fuseki", "SEMAPPS_QUEUE_SERVICE_URL": "redis://redis:6379/1",
        "SEMAPPS_REDIS_OIDC_PROVIDER_URL": "redis://redis:6379/2", "SEMAPPS_REDIS_CACHE_URL": "",
        "SEMAPPS_REDIS_TRANSPORTER_URL": "", "SEMAPPS_FROM_EMAIL": "staging@paper.test",
        "SEMAPPS_FROM_NAME": "Paper staging", "SEMAPPS_SMTP_HOST": "disabled-mail",
        "SEMAPPS_SMTP_PORT": "1025", "SEMAPPS_SMTP_USER": "", "SEMAPPS_SMTP_PASS": "",
        "SEMAPPS_AUTH_RESERVED_USER_NAMES": "sparql,auth,common,data,settings,localData,testData",
        "SEMAPPS_AUTH_ACCOUNTS_DATASET": "settings", "NODE_EXTRA_CA_CERTS": "/run/staging-ca.crt",
    }
    services = config["services"]
    services.update({
        "fuseki": {"image": lock["fuseki_image"], "profiles": ["provider"],
            "entrypoint": ["/bin/sh", "/staging/fuseki-start.sh"], "command": [],
            "environment": {"JVM_ARGS": "-Xmx768M"}, "networks": ["authority"],
            "volumes": ["fuseki:/fuseki", "./secrets/fuseki:/run/fuseki-password:ro", "./fuseki-start.sh:/staging/fuseki-start.sh:ro"],
            "mem_limit": "1200m", "restart": "no",
            "healthcheck": {"test": ["CMD-SHELL", "wget -q -O /dev/null 'http://localhost:3030/$$/ping'"],
                "interval": "3s", "timeout": "3s", "retries": 40}},
        "redis": {"image": lock["redis_image"], "profiles": ["provider"], "networks": ["authority"],
            "command": ["redis-server", "--appendonly", "yes", "--appendfsync", "everysec", "--maxmemory-policy", "noeviction"],
            "volumes": ["redis:/data"], "mem_limit": "256m", "restart": "no",
            "healthcheck": {"test": ["CMD", "redis-cli", "ping"], "interval": "3s", "timeout": "3s", "retries": 20}},
        "provider": {"build": {"context": "./provider-build", "dockerfile": "Backend.Dockerfile"},
            "profiles": ["provider"], "environment": env, "networks": ["authority", "provider-egress"],
            "volumes": ["./secrets/provider.json:/run/provider-secrets.json:ro", "./certificates/ca.crt:/run/staging-ca.crt:ro",
                        "provider-jwt:/app/jwt", "provider-uploads:/app/uploads"],
            "depends_on": {"fuseki": {"condition": "service_healthy"}, "redis": {"condition": "service_healthy"}},
            "mem_limit": "2g", "pids_limit": 128, "restart": "no"},
        "frontend": {"build": {"context": "./provider-build", "dockerfile": "Frontend.Dockerfile"},
            "profiles": ["provider"], "networks": ["authority"], "mem_limit": "128m", "restart": "no"},
        "ingress": {"image": lock["caddy_image"], "profiles": ["provider"],
            "networks": {"authority": {"aliases": ["provider.paper.test", "login.paper.test"]}},
            "ports": ["127.0.0.1:8443:8443"],
            "volumes": ["./Caddyfile:/etc/caddy/Caddyfile:ro", "./certificates/browser.key:/certificates/browser.key:ro",
                        "./certificates/browser.crt:/certificates/browser.crt:ro"],
            "depends_on": ["provider", "frontend"], "mem_limit": "128m", "restart": "no"},
    })
    config["networks"]["provider-egress"] = {}
    for name in ("fuseki", "redis", "provider-jwt", "provider-uploads"):
        config["volumes"][name] = {}
    write(destination / "LOCAL_BROWSER_README.txt", f"Local provider: {API}\nLocal login: {UI}/login\nMap both names to 127.0.0.1 for your browser. Import certificates/ca.crt into a disposable browser profile only. Production signup remains CLOSED until the completion integration passes. Do not use real account credentials.\n")
