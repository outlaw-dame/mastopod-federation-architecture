from pathlib import Path

path = Path('fedify-sidecar/loadtest/relay-loadtest.js')
text = path.read_text()
old = '''function relaySubscribeRequest() {\n  const res = http.post(\n    `${baseUrl}/webhook/outbox`,\n    relaySubscribePayload(),\n    {\n      headers: {\n        'content-type': 'application/json',\n        authorization: `Bearer ${sidecarToken}`,\n      },\n'''
new = '''function relaySubscribeRequest(idSuffix) {\n  const suffix = idSuffix || `${__VU}-${__ITER}`;\n  const intentId = `apdm-relay-loadtest-${suffix}`;\n  const res = http.post(\n    `${baseUrl}/webhook/outbox`,\n    relaySubscribePayload(suffix),\n    {\n      headers: {\n        'content-type': 'application/json',\n        authorization: `Bearer ${sidecarToken}`,\n        'X-APDM-Intent-Id': intentId,\n      },\n'''
if text.count(old) != 1:
    raise SystemExit(f'relaySubscribeRequest: expected 1 match, got {text.count(old)}')
text = text.replace(old, new, 1)
old_probe = '''      relaySubscribePayload('setup-probe'),\n      {\n        headers: {\n          'content-type': 'application/json',\n          authorization: `Bearer ${sidecarToken}`,\n        },\n'''
new_probe = '''      relaySubscribePayload('setup-probe'),\n      {\n        headers: {\n          'content-type': 'application/json',\n          authorization: `Bearer ${sidecarToken}`,\n          'X-APDM-Intent-Id': 'apdm-relay-loadtest-setup-probe',\n        },\n'''
if text.count(old_probe) != 1:
    raise SystemExit(f'setup probe: expected 1 match, got {text.count(old_probe)}')
text = text.replace(old_probe, new_probe, 1)
path.write_text(text)
