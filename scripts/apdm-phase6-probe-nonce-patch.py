from pathlib import Path

path = Path('fedify-sidecar/loadtest/relay-loadtest.js')
text = path.read_text()
old = "          'X-APDM-Intent-Id': 'apdm-relay-loadtest-setup-probe',\n"
new = "          'X-APDM-Intent-Id': `apdm-relay-loadtest-${runNonce}-setup-probe`,\n"
count = text.count(old)
if count != 1:
    raise SystemExit(f'guard failed: expected 1 setup probe header, found {count}')
text = text.replace(old, new)
path.write_text(text)
Path('scripts/apdm-phase6-probe-nonce-patch.py').unlink()
Path('.github/workflows/apdm-phase6-probe-nonce-patch.yml').unlink()
