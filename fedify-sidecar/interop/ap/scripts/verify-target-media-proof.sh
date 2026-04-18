#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
FEDIFY_SIDECAR_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/../../.." && pwd)
TARGET="${AP_INTEROP_TARGET:-}"
RESULT_FILE="${AP_INTEROP_PROOF_RESULT_FILE:-}"
COMPOSE_FILE="${AP_INTEROP_COMPOSE_FILE:-}"
VERIFY_TIMEOUT_MS="${AP_INTEROP_VERIFY_TIMEOUT_MS:-120000}"
GOTOSOCIAL_DB_FILE="${AP_INTEROP_GOTOSOCIAL_DB_FILE:-${FEDIFY_SIDECAR_ROOT}/interop/ap/runtime/gotosocial/sqlite.db}"

if [ -z "${TARGET}" ]; then
  echo "[verify-target-media-proof] failed: AP_INTEROP_TARGET is required" >&2
  exit 1
fi

if [ -z "${RESULT_FILE}" ]; then
  echo "[verify-target-media-proof] failed: AP_INTEROP_PROOF_RESULT_FILE is required" >&2
  exit 1
fi

read_proof_fields() {
  RESULT_FILE_ENV="${RESULT_FILE}" node <<'NODE'
const fs = require("node:fs");

const resultPath = process.env.RESULT_FILE_ENV;
const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
if (!result?.ok || !result?.attachmentProof) {
  throw new Error(`Proof result did not include attachment metadata: ${resultPath}`);
}

const proof = result.attachmentProof;
process.stdout.write(
  [
    String(proof.mediaActivityId || ""),
    String(proof.mediaObjectId || ""),
    String(proof.contentMarker || ""),
    String(proof.fixtureUrl || ""),
    String(proof.dereferenceObserved || false),
    String(proof.accessCount || 0),
  ].join("\t"),
);
NODE
}

IFS='	' read -r MEDIA_ACTIVITY_ID MEDIA_OBJECT_ID CONTENT_MARKER FIXTURE_URL DEREFERENCE_OBSERVED FIXTURE_ACCESS_COUNT <<EOF
$(read_proof_fields)
EOF

sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

build_sql() {
  activity_id=$(sql_escape "${MEDIA_ACTIVITY_ID}")
  object_id=$(sql_escape "${MEDIA_OBJECT_ID}")
  content_marker=$(sql_escape "${CONTENT_MARKER}")
  fixture_url=$(sql_escape "${FIXTURE_URL}")

  cat <<EOF
SELECT
  s.id,
  COALESCE(s.uri, ''),
  COALESCE(s.url, ''),
  COALESCE(s.text, ''),
  COALESCE(NULLIF(s.content, ''), '-'),
  COUNT(ma.id),
  COALESCE(MAX(ma.remote_url), ''),
  COALESCE(MAX(ma.file_content_type), ''),
  COALESCE(CAST(s.created_at AS TEXT), '')
FROM statuses s
LEFT JOIN media_attachments ma ON ma.status_id = s.id
WHERE COALESCE(s.uri, '') IN ('${activity_id}', '${object_id}')
   OR COALESCE(s.url, '') IN ('${activity_id}', '${object_id}')
   OR COALESCE(s.text, '') LIKE '%${content_marker}%'
   OR COALESCE(s.content, '') LIKE '%${content_marker}%'
   OR COALESCE(ma.remote_url, '') = '${fixture_url}'
GROUP BY s.id, s.uri, s.url, s.text, s.content, s.created_at
ORDER BY s.created_at DESC
LIMIT 1;
EOF
}

build_mastodon_sql() {
  activity_id=$(sql_escape "${MEDIA_ACTIVITY_ID}")
  object_id=$(sql_escape "${MEDIA_OBJECT_ID}")
  content_marker=$(sql_escape "${CONTENT_MARKER}")
  fixture_url=$(sql_escape "${FIXTURE_URL}")

  cat <<EOF
SELECT
  s.id,
  COALESCE(s.uri, ''),
  COALESCE(s.url, ''),
  COALESCE(s.text, ''),
  COALESCE(NULLIF(s.spoiler_text, ''), '-'),
  COUNT(ma.id),
  COALESCE(MAX(ma.remote_url), ''),
  COALESCE(MAX(ma.file_content_type), ''),
  COALESCE(CAST(s.created_at AS TEXT), '')
FROM statuses s
LEFT JOIN media_attachments ma ON ma.status_id = s.id
WHERE COALESCE(s.uri, '') IN ('${activity_id}', '${object_id}')
   OR COALESCE(s.url, '') IN ('${activity_id}', '${object_id}')
   OR COALESCE(s.text, '') LIKE '%${content_marker}%'
   OR COALESCE(s.spoiler_text, '') LIKE '%${content_marker}%'
   OR COALESCE(ma.remote_url, '') = '${fixture_url}'
GROUP BY s.id, s.uri, s.url, s.text, s.spoiler_text, s.created_at
ORDER BY s.created_at DESC
LIMIT 1;
EOF
}

build_akkoma_sql() {
  activity_id=$(sql_escape "${MEDIA_ACTIVITY_ID}")
  object_id=$(sql_escape "${MEDIA_OBJECT_ID}")
  content_marker=$(sql_escape "${CONTENT_MARKER}")
  fixture_url=$(sql_escape "${FIXTURE_URL}")

  cat <<EOF
WITH matching_objects AS (
  SELECT
    o.id,
    COALESCE(o.data->>'id', '') AS object_uri,
    COALESCE(o.data->>'url', '') AS object_url,
    COALESCE(NULLIF(o.data->>'content', ''), '-') AS object_content,
    COALESCE(jsonb_array_length(COALESCE(o.data->'attachment', '[]'::jsonb)), 0) AS attachment_count,
    COALESCE(
      MAX(
        CASE
          WHEN jsonb_typeof(att.value->'url') = 'array' THEN att.value->'url'->0->>'href'
          WHEN jsonb_typeof(att.value->'url') = 'object' THEN att.value->'url'->>'href'
          ELSE NULL
        END
      ),
      ''
    ) AS remote_url,
    COALESCE(
      MAX(
        COALESCE(
          CASE
            WHEN jsonb_typeof(att.value->'url') = 'array' THEN att.value->'url'->0->>'mediaType'
            WHEN jsonb_typeof(att.value->'url') = 'object' THEN att.value->'url'->>'mediaType'
            ELSE NULL
          END,
          att.value->>'mediaType'
        )
      ),
      ''
    ) AS file_content_type,
    COALESCE(CAST(o.inserted_at AS TEXT), '') AS created_at
  FROM objects o
  LEFT JOIN LATERAL jsonb_array_elements(COALESCE(o.data->'attachment', '[]'::jsonb)) AS att(value) ON TRUE
  WHERE COALESCE(o.data->>'id', '') IN ('${activity_id}', '${object_id}')
     OR COALESCE(o.data->>'url', '') IN ('${activity_id}', '${object_id}')
     OR COALESCE(o.data->>'content', '') LIKE '%${content_marker}%'
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(COALESCE(o.data->'attachment', '[]'::jsonb)) AS attachment(value)
       WHERE CASE
         WHEN jsonb_typeof(attachment.value->'url') = 'array' THEN attachment.value->'url'->0->>'href'
         WHEN jsonb_typeof(attachment.value->'url') = 'object' THEN attachment.value->'url'->>'href'
         ELSE ''
       END = '${fixture_url}'
     )
  GROUP BY o.id, o.data, o.inserted_at
)
SELECT
  id,
  object_uri,
  object_url,
  object_content,
  object_content,
  attachment_count,
  remote_url,
  file_content_type,
  created_at
FROM matching_objects
ORDER BY created_at DESC
LIMIT 1;
EOF
}

query_sqlite() {
  sql=$(build_sql)
  sqlite3 -cmd '.timeout 5000' "file:${GOTOSOCIAL_DB_FILE}?mode=ro" -tabs -noheader "${sql}"
}

query_postgres() {
  service="$1"
  database="$2"
  sql="${3}"
  docker compose -f "${COMPOSE_FILE}" exec -T "${service}" \
    env PGPASSWORD=postgres \
    psql -U postgres -d "${database}" -At -F "$(printf '\t')" -c "${sql}" </dev/null
}

run_query() {
  case "${TARGET}" in
    gotosocial)
      query_sqlite
      ;;
    mastodon)
      if [ -z "${COMPOSE_FILE}" ]; then
        echo "[verify-target-media-proof] failed: AP_INTEROP_COMPOSE_FILE is required for mastodon" >&2
        exit 1
      fi
      query_postgres mastodon-db mastodon_production "$(build_mastodon_sql)"
      ;;
    akkoma)
      if [ -z "${COMPOSE_FILE}" ]; then
        echo "[verify-target-media-proof] failed: AP_INTEROP_COMPOSE_FILE is required for akkoma" >&2
        exit 1
      fi
      query_postgres akkoma-db akkoma "$(build_akkoma_sql)"
      ;;
    *)
      echo "[verify-target-media-proof] failed: Unsupported AP interop target '${TARGET}'" >&2
      exit 1
      ;;
  esac
}

now_ms() {
  node -p 'Date.now()'
}

sleep_ms() {
  duration_ms="$1"
  duration_s=$(awk "BEGIN { printf \"%.3f\", ${duration_ms} / 1000 }")
  sleep "${duration_s}"
}

deadline_ms=$(( $(now_ms) + VERIFY_TIMEOUT_MS ))
delay_ms=500
last_row=""
last_error=""

while [ "$(now_ms)" -lt "${deadline_ms}" ]; do
  stdout_file=$(mktemp)
  stderr_file=$(mktemp)

  if run_query >"${stdout_file}" 2>"${stderr_file}"; then
    line=$(awk 'NF { print; exit }' "${stdout_file}")
    if [ -n "${line}" ]; then
      last_row="${line}"
      IFS='	' read -r STATUS_ID STATUS_URI STATUS_URL STATUS_TEXT STATUS_CONTENT ATTACHMENT_COUNT REMOTE_URL FILE_CONTENT_TYPE CREATED_AT <<EOF
${line}
EOF
      if [ "${ATTACHMENT_COUNT:-0}" -gt 0 ] 2>/dev/null; then
        rm -f "${stdout_file}" "${stderr_file}"
        STATUS_ID_ENV="${STATUS_ID}" \
        STATUS_URI_ENV="${STATUS_URI}" \
        STATUS_URL_ENV="${STATUS_URL}" \
        ATTACHMENT_COUNT_ENV="${ATTACHMENT_COUNT}" \
        REMOTE_URL_ENV="${REMOTE_URL}" \
        FILE_CONTENT_TYPE_ENV="${FILE_CONTENT_TYPE}" \
        DEREFERENCE_OBSERVED_ENV="${DEREFERENCE_OBSERVED}" \
        FIXTURE_ACCESS_COUNT_ENV="${FIXTURE_ACCESS_COUNT}" \
          node <<'NODE'
console.log(JSON.stringify({
  ok: true,
  target: process.env.AP_INTEROP_TARGET,
  statusId: process.env.STATUS_ID_ENV,
  statusUri: process.env.STATUS_URI_ENV,
  statusUrl: process.env.STATUS_URL_ENV,
  attachmentCount: Number.parseInt(process.env.ATTACHMENT_COUNT_ENV || "0", 10) || 0,
  remoteUrl: process.env.REMOTE_URL_ENV,
  fileContentType: process.env.FILE_CONTENT_TYPE_ENV,
  dereferenceObserved: process.env.DEREFERENCE_OBSERVED_ENV === "true",
  fixtureAccessCount: Number.parseInt(process.env.FIXTURE_ACCESS_COUNT_ENV || "0", 10) || 0,
}, null, 2));
NODE
        exit 0
      fi
    fi
  else
    last_error=$(cat "${stderr_file}")
  fi

  rm -f "${stdout_file}" "${stderr_file}"

  sleep_ms "${delay_ms}"
  if [ "${delay_ms}" -lt 5000 ]; then
    delay_ms=$((delay_ms * 2))
    if [ "${delay_ms}" -gt 5000 ]; then
      delay_ms=5000
    fi
  fi
done

if [ -n "${last_row}" ]; then
  echo "[verify-target-media-proof] failed: Timed out verifying target media proof for ${TARGET}; last row: ${last_row}" >&2
else
  if [ -n "${last_error}" ]; then
    echo "[verify-target-media-proof] failed: Timed out verifying target media proof for ${TARGET}; last error: ${last_error}" >&2
  else
    echo "[verify-target-media-proof] failed: Timed out verifying target media proof for ${TARGET}; no matching remote status observed" >&2
  fi
fi

exit 1
