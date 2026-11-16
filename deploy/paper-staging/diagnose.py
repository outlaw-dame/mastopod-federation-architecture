"""Bounded diagnostics for this disposable bundle, with its secrets redacted."""
import json
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1])
if (root / "PREPARED").is_file():
    private = []
    for path in (root / "secrets").iterdir():
        if path.suffix == ".json":
            private.extend(json.loads(path.read_text()).values())
        else:
            private.append(path.read_text().strip())
    for arguments in (["ps", "--all", "--format", "json"], ["logs", "--tail", "45"]):
        result = subprocess.run(["docker", "compose", "-f", str(root / "compose.json"),
            "--profile", "provider", "--profile", "acceptance", *arguments],
            capture_output=True, text=True, timeout=20)
        output = result.stdout + result.stderr
        for value in private:
            if value:
                output = output.replace(value, "[REDACTED]")
        print(output)
