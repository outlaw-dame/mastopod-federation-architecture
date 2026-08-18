#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EVIDENCE_ROOT="${ROOT}/measurements/adsp-p2-w3"
ACTIVITYPODS_ROOT="${ROOT}/activitypods/pod-provider"
SIDECAR_ROOT="${ROOT}/fedify-sidecar"
TARGET_PORT=18080
GATEWAY_PORT=18081

: "${ADSP_P2_NAMESPACE:?ADSP_P2_NAMESPACE is required}"
: "${ADSP_EPHEMERAL_TOKEN:?ADSP_EPHEMERAL_TOKEN is required}"
: "${ACTIVITYPODS_SHA:?ACTIVITYPODS_SHA is required}"
: "${FEDERATION_CANDIDATE_SHA:?FEDERATION_CANDIDATE_SHA is required}"

COMPOSE_FILES=(
  -f "${ACTIVITYPODS_ROOT}/docker-compose-test.yml"
  -f "${ACTIVITYPODS_ROOT}/docker-compose-phase8.yml"
  -f "${ACTIVITYPODS_ROOT}/docker-compose-adsp-p2-horizontal.yml"
  -f "${ACTIVITYPODS_ROOT}/docker-compose-adsp-p2-w3-external.yml"
)

compose() {
  docker compose "${COMPOSE_FILES[@]}" "$@"
}

wait_http() {
  local url="$1"
  local attempts="${2:-180}"
  for _attempt in $(seq 1 "$attempts"); do
    if curl -fsS --max-time 2 -o /dev/null "$url"; then return 0; fi
    sleep 1
  done
  return 1
}

wait_container_http() {
  local service="$1"
  local url="$2"
  for _attempt in $(seq 1 60); do
    if compose exec -T "$service" node -e "fetch(process.argv[1]).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" "$url"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

stop_cells() {
  compose stop -t 30 backend_p2_4 backend_p2_3 backend_p2_2 backend >/dev/null 2>&1 || true
}

start_bridge() {
  local service="$1"
  compose exec -d "$service" node scripts/adsp-p2-w3-loopback-bridge.js
  wait_container_http "$service" "http://127.0.0.1:18080/health"
}

start_topology() {
  local replicas="$1"
  stop_cells
  rm -f "${ACTIVITYPODS_ROOT}"/measurements/adsp-p2-w3/locality-r{1,2,3,4}.json

  compose up -d --no-deps backend
  wait_http http://127.0.0.1:3000/ || { compose logs backend; return 1; }
  start_bridge backend

  if [[ "$replicas" -ge 2 ]]; then
    compose up -d --no-deps backend_p2_2
    wait_http http://127.0.0.1:3102/ || { compose logs backend_p2_2; return 1; }
    start_bridge backend_p2_2
  fi

  if [[ "$replicas" -ge 4 ]]; then
    compose up -d --no-deps backend_p2_3 backend_p2_4
    wait_http http://127.0.0.1:3103/ || { compose logs backend_p2_3; return 1; }
    wait_http http://127.0.0.1:3104/ || { compose logs backend_p2_4; return 1; }
    start_bridge backend_p2_3
    start_bridge backend_p2_4
  fi
}

run_case() {
  local replicas="$1"
  local scenario="$2"
  local label="$3"
  local case_dir="${EVIDENCE_ROOT}/${label}"
  mkdir -p "$case_dir"

  (
    cd "$SIDECAR_ROOT"
    npm exec -- tsx scripts/adsp-p0-activitypods-origin.ts prepare
  ) | tee "$case_dir/prepared.json"

  (
    cd "${ACTIVITYPODS_ROOT}/backend"
    ADSP_P2_W3_EXPECTED_REPLICAS="$replicas" \
    ADSP_P2_W3_RUN_ID="${GITHUB_RUN_ID:-local}-${label}" \
    ADSP_P2_W3_CORRELATION_OUTPUT="$case_dir/correlation.json" \
    SEMAPPS_REDIS_TRANSPORTER_URL=redis://127.0.0.1:6379/12 \
      node scripts/adsp-p2-w3-remote-origin-fixture.js \
      "http://127.0.0.1:${TARGET_PORT}/actor/${scenario}"
  ) | tee "$case_dir/origin.raw.log"
  tail -n 1 "$case_dir/origin.raw.log" > "$case_dir/origin.json"
  node -e 'const fs=require("fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(v.ok!==true)process.exit(1)' "$case_dir/origin.json"

  (
    cd "$SIDECAR_ROOT"
    npm exec -- tsx scripts/adsp-p0-activitypods-origin.ts settle \
      "$scenario" \
      "$case_dir/prepared.json" \
      "$case_dir/origin.json"
  ) | tee "$case_dir/settlement.json"
  node -e 'const fs=require("fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(v.ok!==true||!Number.isSafeInteger(v.eventLogPublishedAt)||v.eventLogPublishedAt<=0||(v.errors||[]).length)process.exit(1)' "$case_dir/settlement.json"
}

validate_locality() {
  local replicas="$1"
  local expected_roots="$2"
  local label="$3"
  local case_dir="${EVIDENCE_ROOT}/${label}"
  node - "$replicas" "$expected_roots" "$case_dir" "$ADSP_P2_NAMESPACE" "$ACTIVITYPODS_ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');
const [replicasRaw, rootsRaw, caseDir, namespace, activityPodsRoot] = process.argv.slice(2);
const replicas = Number(replicasRaw);
const expectedRoots = Number(rootsRaw);
let total = 0;
const executors = [];
for (let index = 1; index <= replicas; index += 1) {
  const source = path.join(activityPodsRoot, 'measurements', 'adsp-p2-w3', `locality-r${index}.json`);
  if (!fs.existsSync(source)) throw new Error(`missing locality evidence r${index}`);
  const value = JSON.parse(fs.readFileSync(source, 'utf8'));
  if (value.nodeID !== `adsp-p2-pod-cell-${index}`) throw new Error(`node identity drift r${index}`);
  if (value.namespace !== namespace) throw new Error(`namespace drift r${index}`);
  const count = Number(value.localByAction?.['activitypub.outbox.post'] || 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`invalid root count r${index}`);
  total += count;
  if (count > 0) executors.push({ replica: `r${index}`, count });
  fs.copyFileSync(source, path.join(caseDir, `locality-r${index}.json`));
}
if (total !== expectedRoots) throw new Error(`expected ${expectedRoots} authoritative outbox roots, observed ${total}`);
fs.writeFileSync(path.join(caseDir, 'executor-summary.json'), `${JSON.stringify({ replicas, expectedRoots, totalRoots: total, executors }, null, 2)}\n`);
NODE
}

start_redpanda() {
  docker rm -f adsp-redpanda >/dev/null 2>&1 || true
  docker run -d --name adsp-redpanda \
    -p 19092:19092 -p 19644:9644 \
    redpandadata/redpanda:v24.1.3 \
    redpanda start \
      --overprovisioned \
      --smp 1 \
      --memory 768M \
      --reserve-memory 0M \
      --node-id 0 \
      --check=false \
      --kafka-addr internal://0.0.0.0:9092,external://0.0.0.0:19092 \
      --advertise-kafka-addr internal://127.0.0.1:9092,external://127.0.0.1:19092
  local ready=false
  for _attempt in $(seq 1 60); do
    if docker exec adsp-redpanda rpk cluster health --exit-when-healthy >/dev/null 2>&1; then ready=true; break; fi
    sleep 1
  done
  [[ "$ready" == true ]] || { docker logs adsp-redpanda; return 1; }
  for topic in ap.stream1.local-public.v1 ap.stream2.remote-public.v1 ap.firehose.v1 ap.tombstones.v1 canonical.v1; do
    docker exec adsp-redpanda rpk topic create "$topic"
  done
  docker exec adsp-redpanda rpk topic list > "${EVIDENCE_ROOT}/redpanda-topics-before.txt"
}

start_target_and_gateway() {
  (
    cd "$SIDECAR_ROOT"
    ADSP_REMOTE_HOST=127.0.0.1 \
    ADSP_REMOTE_PORT="$TARGET_PORT" \
    ADSP_REMOTE_TRANSIENT_FAILURES=2 \
      npm exec -- tsx scripts/adsp-p0-controlled-remote-target.ts \
      > "${EVIDENCE_ROOT}/controlled-target.log" 2>&1 &
    echo "$!" > "${EVIDENCE_ROOT}/controlled-target.pid"
  )
  wait_http "http://127.0.0.1:${TARGET_PORT}/health" 60 || { cat "${EVIDENCE_ROOT}/controlled-target.log"; return 1; }

  (
    cd "$SIDECAR_ROOT"
    ADSP_P2_W3_GATEWAY_PORT="$GATEWAY_PORT" \
    ADSP_REMOTE_PORT="$TARGET_PORT" \
      npm exec -- tsx scripts/adsp-p2-w3-host-target-gateway.ts \
      > "${EVIDENCE_ROOT}/host-target-gateway.log" 2>&1 &
    echo "$!" > "${EVIDENCE_ROOT}/host-target-gateway.pid"
  )
  wait_http "http://127.0.0.1:${GATEWAY_PORT}/health" 60 || { cat "${EVIDENCE_ROOT}/host-target-gateway.log"; return 1; }
}

start_sidecar() {
  (
    cd "$SIDECAR_ROOT"
    NODE_ENV=development \
    PORT=8080 \
    HOST=0.0.0.0 \
    DOMAIN=localhost \
    SIDECAR_STARTUP_MODE=blocking \
    REDIS_URL=redis://127.0.0.1:6379 \
    APDM_COMPLETION_MARKER_V2_CUTOVER=fresh \
    REDPANDA_BROKERS=127.0.0.1:19092 \
    REDPANDA_ENFORCE_TOPIC_GOVERNANCE=false \
    STREAM1_TOPIC=ap.stream1.local-public.v1 \
    STREAM2_TOPIC=ap.stream2.remote-public.v1 \
    FIREHOSE_TOPIC=ap.firehose.v1 \
    TOMBSTONE_TOPIC=ap.tombstones.v1 \
    ACTIVITYPODS_URL=http://127.0.0.1:3000 \
    ACTIVITYPODS_TOKEN="$ADSP_EPHEMERAL_TOKEN" \
    SIDECAR_TOKEN="$ADSP_EPHEMERAL_TOKEN" \
    ENABLE_OUTBOUND_WORKER=true \
    ENABLE_OUTBOX_INTENT_WORKER=true \
    ENABLE_INBOUND_WORKER=false \
    ENABLE_ORIGIN_RECONCILIATION=false \
    ENABLE_FEDIFY_RUNTIME_INTEGRATION=false \
    ENABLE_OPENSEARCH_INDEXER=false \
    ENABLE_XRPC_SERVER=false \
    ENABLE_MEDIA_ASSET_SYNC=false \
    ENABLE_ACCOUNT_PROVISIONING=false \
    ENABLE_ENTRYWAY=false \
    ENABLE_FOLLOWERS_SYNC=false \
    ENABLE_MRF_ADMIN_API=false \
    ENABLE_MODERATION_BRIDGE_API=false \
    ENABLE_CANONICAL_EVENT_LOG=false \
    ENABLE_CANONICAL_NOTIFICATIONS=false \
    ENABLE_AT_JETSTREAM=false \
    ENABLE_AT_EXTERNAL_FIREHOSE=false \
    APDM_ALLOW_LOOPBACK_HTTP=true \
    APDM_ALLOW_PRIVATE_HTTP=false \
    APDM_ALLOW_HTTP_HOSTS='' \
    REDIS_STREAM_PAYLOAD_COMPRESSION_ENABLED=false \
    CONSUMER_GROUP=sidecar-workers \
    INBOUND_STREAM_KEY=ap:queue:inbound:v1 \
    OUTBOUND_STREAM_KEY=ap:queue:outbound:v1 \
    OUTBOX_INTENT_STREAM_KEY=ap:queue:outbox-intent:v1 \
    ORIGIN_RECONCILE_STREAM_KEY=ap:queue:origin-reconcile:v1 \
    DLQ_OUTBOUND_STREAM_KEY=ap:queue:dlq:outbound:v1 \
    OUTBOUND_MAX_ATTEMPTS=5 \
    REQUEST_TIMEOUT_MS=5000 \
      npm run server:dev > "${EVIDENCE_ROOT}/sidecar.log" 2>&1 &
    echo "$!" > "${EVIDENCE_ROOT}/sidecar.pid"
  )
  local sidecar_pid
  sidecar_pid="$(cat "${EVIDENCE_ROOT}/sidecar.pid")"
  for _attempt in $(seq 1 120); do
    if curl -fsS --max-time 2 http://127.0.0.1:8080/health >/dev/null; then return 0; fi
    if ! kill -0 "$sidecar_pid" 2>/dev/null; then tail -n 500 "${EVIDENCE_ROOT}/sidecar.log"; return 1; fi
    sleep 1
  done
  tail -n 500 "${EVIDENCE_ROOT}/sidecar.log"
  return 1
}

validate_summary() {
  node - "$EVIDENCE_ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const cases = [
  ['success-1r', 'success', 1],
  ['success-2r', 'success', 2],
  ['success-4r', 'success', 4],
  ['transient-4r', 'transient', 4],
  ['permanent-4r', 'permanent', 4]
];
const summary = [];
for (const [label, scenario, replicas] of cases) {
  const caseRoot = path.join(root, label);
  const origin = JSON.parse(fs.readFileSync(path.join(caseRoot, 'origin.json'), 'utf8'));
  const settlement = JSON.parse(fs.readFileSync(path.join(caseRoot, 'settlement.json'), 'utf8'));
  const correlation = JSON.parse(fs.readFileSync(path.join(caseRoot, 'correlation.json'), 'utf8'));
  if (origin.ok !== true) throw new Error(`${label}: ActivityPods origin failed`);
  if (origin.deliveryPlanSchema !== 'ap.delivery-plan.v1') throw new Error(`${label}: wrong plan schema`);
  if (origin.durableHandoffQueued !== true) throw new Error(`${label}: durable handoff absent`);
  if (origin.suppressedNativeRemotePostCount !== 1) throw new Error(`${label}: native remote suppression drift`);
  if (origin.isPublicActivity !== true) throw new Error(`${label}: public eligibility absent`);
  if (settlement.ok !== true || (settlement.errors || []).length !== 0) throw new Error(`${label}: settlement failed`);
  if (settlement.intentId !== origin.deliveryPlanIntentId) throw new Error(`${label}: intent authority drift`);
  if (!Number.isSafeInteger(settlement.eventLogPublishedAt) || settlement.eventLogPublishedAt <= 0) throw new Error(`${label}: RedPanda publication absent`);
  if (correlation.schema !== 'adsp.p2.w3.origin-correlation.v1') throw new Error(`${label}: correlation schema drift`);
  if (correlation.activityId !== origin.activityId) throw new Error(`${label}: Activity ID correlation drift`);
  if (correlation.expectedReplicas !== replicas) throw new Error(`${label}: topology correlation drift`);
  if (correlation.moleculerNamespace !== process.env.ADSP_P2_NAMESPACE) throw new Error(`${label}: namespace correlation drift`);
  summary.push({ label, scenario, replicas, activityId: origin.activityId, intentId: settlement.intentId, eventLogPublishedAt: settlement.eventLogPublishedAt });
}
fs.writeFileSync(path.join(root, 'summary.json'), `${JSON.stringify({
  schema: 'adsp.p2.w3.remote-correctness.v1',
  complete: true,
  promotionEvidence: false,
  activityPodsCommitSha: process.env.ACTIVITYPODS_SHA,
  federationCandidateSha: process.env.FEDERATION_CANDIDATE_SHA,
  cases: summary
}, null, 2)}\n`);
NODE
}

mkdir -p "$EVIDENCE_ROOT"
start_redpanda
start_target_and_gateway

# The first cell must be reachable before sidecar startup because it remains the
# signing authority endpoint even when a remote root executes on another cell.
start_topology 1
start_sidecar

for replicas in 1 2 4; do
  label="success-${replicas}r"
  start_topology "$replicas"
  run_case "$replicas" success "$label"
  stop_cells
  validate_locality "$replicas" 1 "$label"
done

start_topology 4
run_case 4 transient transient-4r
run_case 4 permanent permanent-4r
stop_cells
validate_locality 4 2 transient-4r
cp "${EVIDENCE_ROOT}/transient-4r/executor-summary.json" "${EVIDENCE_ROOT}/retry-executor-summary.json"
for index in 1 2 3 4; do
  cp "${EVIDENCE_ROOT}/transient-4r/locality-r${index}.json" "${EVIDENCE_ROOT}/permanent-4r/locality-final-r${index}.json"
done

validate_summary
