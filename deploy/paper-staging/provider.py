"""Local-only provider profile. Never enables disposable identity shortcuts."""
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess

API = "https://provider.paper.example.org:8443"
UI = "https://login.paper.example.org:8443"


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
    for name in ("SEMAPPS_COOKIE_SECRET", "ACTIVITYPODS_TOKEN", "SIDECAR_TOKEN", "SIGNING_API_TOKEN",
                 "ATPROTO_MIGRATION_SECRET_ENC_KEY_HEX"):
        private_env[name] = secrets.token_hex(32)
    write(destination / "secrets/provider.json", json.dumps(private_env))
    # This physically separate Jena store is rehearsal-only. Its projection,
    # readback and administrator credentials never enter the provider process.
    protected = {
        role: {"username": "paper-protected-" + role,
               "password": secrets.token_hex(32)}
        for role in ("provisioner", "projector", "attestor")
    }
    protected["ordinary"] = {"username": "admin", "password": password}
    write(destination / "secrets/protected-access.json", json.dumps(protected))
    write(destination / "secrets/protected-shiro.ini",
        "# Generated disposable protected Jena authority. Keep out of deployment images.\n"
        "[users]\n"
        f"{protected['provisioner']['username']} = {protected['provisioner']['password']}, admins\n"
        f"{protected['projector']['username']} = {protected['projector']['password']}, projectors, readers\n"
        f"{protected['attestor']['username']} = {protected['attestor']['password']}, readers\n"
        "[urls]\n"
        "/$/ping = anon\n"
        "/$/** = authcBasic,roles[admins]\n"
        "/protected-proof/query = authcBasic,roles[readers]\n"
        "/protected-proof/update = authcBasic,roles[projectors]\n"
        "/protected-proof/** = authcBasic,roles[projectors]\n"
        "/protected-proof = authcBasic,roles[projectors]\n"
        "/** = authcBasic,roles[admins]\n")
    here = Path(__file__).resolve().parent
    for name in ("provider-start.cjs", "provider-probe.mjs", "protected-proof.mjs"):
        shutil.copyfile(here / name, build / name)
        (build / name).chmod(0o644)
    readiness = build / "pod-provider/backend/services/staging-readiness.service.js"
    shutil.copyfile(here / "provider-readiness.cjs", readiness)
    readiness.chmod(0o644)
    write(build / "Backend.Dockerfile", f'''FROM {lock['node_image']}
WORKDIR /app
COPY pod-provider/backend/package*.json ./
COPY pod-provider/backend/scripts/ ./scripts/
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY pod-provider/backend/ ./
RUN mkdir -p jwt uploads exports data logs && chown -R node:node jwt uploads exports data logs
COPY provider-start.cjs /staging/provider-start.cjs
COPY provider-probe.mjs /staging/provider-probe.mjs
ENV NODE_ENV=production
CMD ["node", "/staging/provider-start.cjs"]
''')
    write(build / "Frontend.Dockerfile", f'''FROM {lock['node_image']} AS build
WORKDIR /app
COPY pod-provider/frontend/package*.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY pod-provider/frontend/ ./
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
    run("openssl", "req", "-newkey", "rsa:3072", "-nodes", "-subj", "/CN=provider.paper.example.org",
        "-keyout", str(certs / "browser.key"), "-out", str(ca / "browser.csr"), **quiet)
    write(ca / "browser-extensions", "subjectAltName=DNS:provider.paper.example.org,DNS:login.paper.example.org\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
    run("openssl", "x509", "-req", "-in", str(ca / "browser.csr"), "-CA", str(certs / "ca.crt"),
        "-CAkey", str(ca / "ca.key"), "-CAcreateserial", "-days", "7", "-extfile", str(ca / "browser-extensions"),
        "-out", str(certs / "browser.crt"), **quiet)
    (certs / "browser.key").chmod(0o600)
    (certs / "ca.crt").chmod(0o644)
    write(destination / "Caddyfile", '''{
  admin off
  auto_https off
}
https://provider.paper.example.org:8443 {
  tls /certificates/browser.crt /certificates/browser.key
  reverse_proxy provider:3000
}
https://login.paper.example.org:8443 {
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
    # Do not invoke the ordinary image entrypoint: it rewrites the Shiro
    # credential policy. This mirrors the independently tested Jena fixture.
    write(destination / "protected-fuseki-start.sh", '''#!/bin/sh
set -eu
if [ ! -e /fuseki/extra ]; then ln -s /jena-fuseki/extra /fuseki/extra; fi
test "$(readlink /fuseki/extra)" = /jena-fuseki/extra
exec /jena-fuseki/fuseki-server
''')
    env = {
        "NODE_ENV": "production", "SEMAPPS_INSTANCE_NAME": "Paper local staging",
        "SEMAPPS_INSTANCE_DESCRIPTION_EN": "Disposable local signup acceptance",
        "SEMAPPS_AVAILABLE_LOCALES": "en", "SEMAPPS_DEFAULT_LOCALE": "en",
        "SEMAPPS_HOME_URL": API + "/", "SEMAPPS_FRONTEND_URL": UI + "/", "SEMAPPS_PORT": "3000",
        "SEMAPPS_SPARQL_ENDPOINT": "http://fuseki:3030/", "SEMAPPS_JENA_USER": "admin",
        "SEMAPPS_FUSEKI_BASE": "/fuseki", "SEMAPPS_QUEUE_SERVICE_URL": "redis://redis:6379/1",
        "SEMAPPS_REDIS_OIDC_PROVIDER_URL": "redis://redis:6379/2", "SEMAPPS_REDIS_CACHE_URL": "redis://redis:6379/0",
        "REDIS_URL": "redis://redis:6379/3",
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
                        "provider-jwt:/app/jwt", "provider-uploads:/app/uploads", "provider-data:/app/data"],
            "depends_on": {"fuseki": {"condition": "service_healthy"}, "redis": {"condition": "service_healthy"}},
            "mem_limit": "2g", "pids_limit": 128, "restart": "no"},
        "frontend": {"build": {"context": "./provider-build", "dockerfile": "Frontend.Dockerfile"},
            "profiles": ["provider"], "networks": ["authority"], "mem_limit": "128m", "restart": "no"},
        "ingress": {"image": lock["caddy_image"], "profiles": ["provider"],
            "networks": {"authority": {"aliases": ["provider.paper.example.org", "login.paper.example.org"]},
                         "provider-egress": {}},
            "ports": ["127.0.0.1:8443:8443"],
            "volumes": ["./Caddyfile:/etc/caddy/Caddyfile:ro", "./certificates/browser.key:/certificates/browser.key:ro",
                        "./certificates/browser.crt:/certificates/browser.crt:ro"],
            "depends_on": ["provider", "frontend"], "mem_limit": "128m", "restart": "no"},
    })
    services["protected-fuseki"] = {
        "image": lock["fuseki_image"], "profiles": ["storage-proof"],
        "entrypoint": ["/bin/sh", "/staging/protected-fuseki-start.sh"],
        "command": [], "environment": {"JVM_ARGS": "-Xmx768M"},
        "networks": ["authority"],
        "volumes": [
            "protected-fuseki:/fuseki",
            "./secrets/protected-shiro.ini:/fuseki/shiro.ini:ro",
            "./protected-fuseki-start.sh:/staging/protected-fuseki-start.sh:ro"
        ],
        "mem_limit": "1200m", "pids_limit": 128, "restart": "no",
        "healthcheck": {"test": ["CMD-SHELL", "wget -q -O /dev/null 'http://localhost:3030/$/ping'"],
                        "interval": "3s", "timeout": "3s", "retries": 40}
    }
    services["protected-storage-proof"] = {
        "image": lock["node_image"], "profiles": ["storage-proof"],
        # Only the disposable test process reads owner-private 0600 credential
        # files. Root has no Linux capabilities, writeable rootfs or Docker socket.
        # The actual provider never mounts this credential file.
        "user": "0:0",
        "entrypoint": ["node", "/staging/protected-proof.mjs"],
        "environment": {"NODE_ENV": "test", "PAPER_STAGING_PROTECTED_PROOF": "confirmed"},
        "networks": ["authority"], "read_only": True, "tmpfs": ["/tmp"],
        "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
        "volumes": [
            "./provider-build/protected-proof.mjs:/staging/protected-proof.mjs:ro",
            "./secrets/protected-access.json:/run/protected-access.json:ro"
        ],
        "depends_on": {"protected-fuseki": {"condition": "service_healthy"}},
        "mem_limit": "128m", "pids_limit": 48, "restart": "no"
    }
    config["networks"]["provider-egress"] = {}
    for name in ("fuseki", "protected-fuseki", "redis", "provider-jwt", "provider-uploads", "provider-data"):
        config["volumes"][name] = {}
    write(destination / "LOCAL_BROWSER_README.txt", f"Local provider: {API}\nLocal login: {UI}/login\nMap both names to 127.0.0.1 for your browser. Import certificates/ca.crt into a disposable browser profile only. Production signup remains CLOSED until the completion integration passes. Do not use real account credentials.\n")
