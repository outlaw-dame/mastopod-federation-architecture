"""Bounded, redacted diagnostics for disposable staging only."""
import json
from pathlib import Path
import re
import subprocess
import sys


def private_values(secret_directory):
    values = set()
    for path in secret_directory.iterdir():
        if not path.is_file():
            raise ValueError("Unexpected staging secrets structure")
        raw = path.read_text()
        if path.suffix == ".json":
            def collect(value):
                if isinstance(value, str):
                    if len(value) >= 8:
                        values.add(value)
                elif isinstance(value, dict):
                    for item in value.values():
                        collect(item)
                elif isinstance(value, list):
                    for item in value:
                        collect(item)
            collect(json.loads(raw))
        elif path.suffix == ".ini":
            for line in raw.splitlines():
                if not line.strip() or line.lstrip().startswith(("#", "[")):
                    continue
                match = re.fullmatch(r"[^=\n]+=\s*([^,\s]+)(?:\s*,.*)?", line)
                if match and len(match.group(1)) >= 8:
                    values.add(match.group(1))
        elif len(raw.strip()) >= 8:
            values.add(raw.strip())
    return sorted(values, key=len, reverse=True)


def redact(text, secrets):
    for secret in secrets:
        text = text.replace(secret, "[REDACTED]")
    return text[:65536]


def diagnose(root):
    if not (root / "PREPARED").is_file():
        return
    try:
        secrets = private_values(root / "secrets")
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        print("Staging diagnostics withheld: private credential inventory unreadable")
        return
    for args in (["ps", "--all", "--format", "json"], ["logs", "--tail", "45"]):
        try:
            result = subprocess.run(
                ["docker", "compose", "-f", str(root / "compose.json"),
                 "--profile", "provider", "--profile", "storage-proof",
                 "--profile", "acceptance", *args],
                capture_output=True, text=True, timeout=20, check=False)
            print(redact(result.stdout + result.stderr, secrets))
        except (OSError, subprocess.TimeoutExpired):
            print("Staging diagnostic command unavailable")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: diagnose.py /absolute/private/staging-dir")
    diagnose(Path(sys.argv[1]))
