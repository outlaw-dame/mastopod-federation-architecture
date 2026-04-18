#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
ADMIN_TOKEN="${ADMIN_TOKEN:-${MRF_ADMIN_TOKEN:-}}"
PERMISSIONS="${PERMISSIONS:-provider:read}"
LIMIT="${LIMIT:-10}"
FORMAT="${FORMAT:-pretty}"
OUTPUT_FILE="${OUTPUT_FILE:-}"

if [[ "${FORMAT}" != "pretty" && "${FORMAT}" != "json" && "${FORMAT}" != "csv" ]]; then
  echo "FORMAT must be one of: pretty, json, csv" >&2
  exit 1
fi

if [[ -z "${ADMIN_TOKEN}" ]]; then
  echo "ADMIN_TOKEN or MRF_ADMIN_TOKEN is required" >&2
  exit 1
fi

report_json="$(curl --silent --show-error --fail \
  -H "authorization: Bearer ${ADMIN_TOKEN}" \
  -H "x-provider-permissions: ${PERMISSIONS}" \
  "${BASE_URL}/internal/admin/at-observability/identities?limit=${LIMIT}" \
  | jq '{generatedAt,summary,topUnbound:(.topUnbound|map({did,handle,pdsEndpoint,totalSeen,lastOutcome})),topBound:(.topBound|map({did,handle,activityPubActorUri,totalSeen,lastOutcome}))}')"

metrics_lines="$(curl --silent --show-error --fail "${BASE_URL}/metrics" \
  | rg 'fedify_protocol_bridge_projection_outcomes_total\{direction="at_to_ap"')"

if [[ "${FORMAT}" == "pretty" ]]; then
  echo "== AT Observability Report =="
  echo "${report_json}" | jq .

  echo
  echo "== Projection Outcome Counters =="
  echo "${metrics_lines}"

  if [[ -n "${OUTPUT_FILE}" ]]; then
    {
      echo "== AT Observability Report =="
      echo "${report_json}" | jq .
      echo
      echo "== Projection Outcome Counters =="
      echo "${metrics_lines}"
    } > "${OUTPUT_FILE}"
  fi
  exit 0
fi

if [[ "${FORMAT}" == "json" ]]; then
  full_json="$(jq -n --argjson report "${report_json}" --arg metrics "${metrics_lines}" '{report:$report,metricsPrometheusLines:($metrics | split("\n") | map(select(length>0)))}')"
  echo "${full_json}" | jq .
  if [[ -n "${OUTPUT_FILE}" ]]; then
    echo "${full_json}" > "${OUTPUT_FILE}"
  fi
  exit 0
fi

# FORMAT=csv
csv_data="$(echo "${report_json}" | jq -r '
  . as $r |
  (["category","did","handle","pdsEndpoint","activityPubActorUri","totalSeen","lastOutcome"] | @csv),
  ($r.topUnbound[]? | ["topUnbound", .did, (.handle // ""), (.pdsEndpoint // ""), "", (.totalSeen|tostring), (.lastOutcome // "")] | @csv),
  ($r.topBound[]? | ["topBound", .did, (.handle // ""), "", (.activityPubActorUri // ""), (.totalSeen|tostring), (.lastOutcome // "")] | @csv)
')"

echo "${csv_data}"
echo
echo "metric_name,labels,value"
echo "${metrics_lines}" | awk '
  {
    left = index($0, "{");
    right = index($0, "}");
    if (left <= 1 || right <= left) {
      next;
    }
    name = substr($0, 1, left - 1);
    labels = substr($0, left + 1, right - left - 1);
    value = substr($0, right + 2);
    gsub(/"/, "\"\"", labels);
    printf "%s,\"%s\",%s\n", name, labels, value;
  }
'

if [[ -n "${OUTPUT_FILE}" ]]; then
  {
    echo "${csv_data}"
    echo
    echo "metric_name,labels,value"
    echo "${metrics_lines}" | awk '
      {
        left = index($0, "{");
        right = index($0, "}");
        if (left <= 1 || right <= left) {
          next;
        }
        name = substr($0, 1, left - 1);
        labels = substr($0, left + 1, right - left - 1);
        value = substr($0, right + 2);
        gsub(/"/, "\"\"", labels);
        printf "%s,\"%s\",%s\n", name, labels, value;
      }
    '
  } > "${OUTPUT_FILE}"
fi
