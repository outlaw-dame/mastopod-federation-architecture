#!/usr/bin/env python3
"""Prepare a new disposable staging directory. Never deploy or reuse data."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def run(*args, **kwargs):
    return subprocess.run(args, check=True, timeout=120, **kwargs)


def write(path, content):
    with path.open("x", encoding="utf-8") as stream:
        stream.write(content)
    path.chmod(0o600)


def prepare(destination):
    lock = json.loads((HERE / "lock.json").read_text())
    if lock["release"] != "CLOSED":
        raise ValueError("Release must remain CLOSED")
    # Git archive reads the pinned commit, never an uncommitted worktree.
    run("git", "-C", str(REPO), "cat-file", "-e", lock["federation"] + "^{commit}")
    destination.mkdir(mode=0o700, parents=False, exist_ok=False)
    for name in ("secrets", "certificates", "private-ca", "build"):
        (destination / name).mkdir(mode=0o700)
    for name in ("admin", "runtime"):
        write(destination / "secrets" / name, secrets.token_hex(32) + "\n")
    with (destination / "source.tar").open("xb") as archive:
        run("git", "-C", str(REPO), "archive", lock["federation"], "fedify-sidecar", stdout=archive)
    run("tar", "-xf", str(destination / "source.tar"), "-C", str(destination / "build"))
    (destination / "source.tar").unlink()
    for source, target in (("database.sh", "database.sh"), ("initialize.sh", "initialize.sh"),
                           ("pg_hba.conf", "pg_hba.conf"), ("smoke.ts", "build/fedify-sidecar/staging-smoke.ts")):
        shutil.copyfile(HERE / source, destination / target)
        (destination / target).chmod(0o644)
    ca = destination / "private-ca"
    certs = destination / "certificates"
    quiet = {"stdout": subprocess.DEVNULL, "stderr": subprocess.PIPE}
    run("openssl", "req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "7",
        "-subj", "/CN=Paper disposable staging CA", "-keyout", str(ca / "ca.key"),
        "-out", str(certs / "ca.crt"), **quiet)
    run("openssl", "req", "-newkey", "rsa:3072", "-nodes", "-subj", "/CN=postgres",
        "-keyout", str(certs / "server.key"), "-out", str(ca / "server.csr"), **quiet)
    write(ca / "extensions", "subjectAltName=DNS:postgres\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
    run("openssl", "x509", "-req", "-in", str(ca / "server.csr"), "-CA", str(certs / "ca.crt"),
        "-CAkey", str(ca / "ca.key"), "-CAcreateserial", "-days", "7", "-extfile", str(ca / "extensions"),
        "-out", str(certs / "server.crt"), **quiet)
    run("openssl", "verify", "-CAfile", str(certs / "ca.crt"), "-verify_hostname", "postgres",
        str(certs / "server.crt"), **quiet)
    (ca / "ca.key").chmod(0o600)
    (certs / "server.key").chmod(0o600)
    write(destination / "build" / "Dockerfile", f"FROM {lock['node_image']}\nWORKDIR /app\nCOPY fedify-sidecar/package*.json ./\nRUN npm ci --ignore-scripts --no-audit --no-fund\nCOPY fedify-sidecar/ ./\nENV NODE_ENV=production\nCMD [\"node\",\"--import\",\"tsx\",\"staging-smoke.ts\"]\n")
    write(destination / "compose.json", json.dumps(compose(lock), indent=2) + "\n")
    write(destination / "lock.json", json.dumps(lock, indent=2) + "\n")
    write(destination / "PREPARED", "Foundation only. No provider, PDS, browser or production acceptance claimed.\n")


def compose(lock):
    mounts = ["./certificates:/staging-certs:ro", "./secrets:/run/staging-secrets:ro"]
    return {
        "name": "paper-staging-" + secrets.token_hex(6),
        "services": {
            "postgres": {
                "image": lock["postgres_image"], "entrypoint": ["/bin/sh", "/staging/database.sh"],
                "environment": {"POSTGRES_USER": "entryway_admin", "POSTGRES_DB": "entryway_control_plane",
                                "POSTGRES_PASSWORD_FILE": "/run/staging-secrets/admin",
                                "POSTGRES_INITDB_ARGS": "--auth-host=scram-sha-256"},
                "volumes": mounts + ["database:/var/lib/postgresql", "./database.sh:/staging/database.sh:ro",
                    "./pg_hba.conf:/staging/pg_hba.conf:ro",
                    "./initialize.sh:/docker-entrypoint-initdb.d/10-entryway.sh:ro",
                    "./build/fedify-sidecar/sql/entryway-control-plane-v1.sql:/staging/schema.sql:ro"],
                "networks": ["authority"], "restart": "no", "mem_limit": "1g", "pids_limit": 128,
                "healthcheck": {"test": ["CMD", "pg_isready", "-U", "entryway_admin", "-d", "entryway_control_plane"],
                                "interval": "2s", "timeout": "3s", "retries": 30}},
            "acceptance": {
                "build": "./build", "profiles": ["acceptance"],
                "volumes": ["./certificates/ca.crt:/run/ca.crt:ro", "./secrets/runtime:/run/runtime-password:ro"],
                "networks": ["authority"], "read_only": True, "tmpfs": ["/tmp"],
                "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
                "mem_limit": "1g", "pids_limit": 64,
                "depends_on": {"postgres": {"condition": "service_healthy"}}, "restart": "no"}},
        "volumes": {"database": {}}, "networks": {"authority": {"internal": True}}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        prepare(args.destination.absolute())
    except (OSError, ValueError, subprocess.SubprocessError):
        parser.exit(1, "Preparation failed; no deployment performed. Do not use a directory without PREPARED.\n")
    print("Prepared isolated database staging files. No deployment performed; release CLOSED.")
