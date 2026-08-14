from pathlib import Path

path = Path('fedify-sidecar/loadtest/relay-loadtest.js')
text = path.read_text()

replacements = [
    (
        "const rampTarget = parseInt(__ENV.RAMP_TARGET || String(vus * 2), 10);\n",
        "const rampTarget = parseInt(__ENV.RAMP_TARGET || String(vus * 2), 10);\nconst runNonce = __ENV.APDM_LOADTEST_RUN_NONCE\n  || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;\n",
        1,
    ),
    (
        "// VU+iteration pairs in IDs prevent idempotency deduplication across runs.\n",
        "// Per-run nonce + VU/iteration IDs prevent cross-run idempotency deduplication.\n",
        1,
    ),
    (
        "    `https://localhost/activities/follow-relay-${suffix}`;\n",
        "    `https://localhost/activities/follow-relay-${runNonce}-${suffix}`;\n",
        1,
    ),
    (
        "  const intentId = `apdm-relay-loadtest-${suffix}`;\n",
        "  const intentId = `apdm-relay-loadtest-${runNonce}-${suffix}`;\n",
        2,
    ),
]

for old, new, expected in replacements:
    actual = text.count(old)
    if actual != expected:
        raise SystemExit(f'guard failed: expected {expected} occurrence(s) of {old!r}, found {actual}')
    text = text.replace(old, new)

path.write_text(text)

# Remove the one-shot patch machinery from the resulting commit.
Path('scripts/apdm-phase6-loadtest-nonce-patch.py').unlink()
Path('.github/workflows/apdm-phase6-loadtest-nonce-patch.yml').unlink()
