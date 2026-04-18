#!/bin/bash
set -e

SUFFIX=$(date +%s%N | cut -c1-12)
USERNAME="u$SUFFIX"
EMAIL="e$SUFFIX@example.com"

echo "Signing up user $USERNAME..."
SIGNUP_RESP=$(curl -s -X POST http://localhost:3000/auth/signup \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USERNAME\",\"password\":\"password123\",\"email\":\"$EMAIL\"}")

WEBID=$(echo "$SIGNUP_RESP" | jq -r '.webId')
TOKEN=$(echo "$SIGNUP_RESP" | jq -r '.token')

if [[ "$WEBID" == "null" || -z "$WEBID" ]]; then
  echo "Signup failed"
  echo "$SIGNUP_RESP"
  exit 1
fi

STORAGE_URL="${WEBID}/data"
echo "STORAGE_URL: $STORAGE_URL"

# GET before
BEFORE_JSON=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/ld+json" "$STORAGE_URL")

# POST file
echo "Uploading file..."
POST_RESP_HEADERS=$(curl -s -i -X POST "$STORAGE_URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/plain" \
  -d "Hello ActivityPods content")

# GET after
AFTER_JSON=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/ld+json" "$STORAGE_URL")

# Extract fileUrl using node
FILE_URL=$(node -e "
  const before = $BEFORE_JSON;
  const after = $AFTER_JSON;
  const getContains = (ldp) => {
    let contains = ldp['ldp:contains'] || [];
    if (!Array.isArray(contains)) contains = [contains];
    return contains.map(o => typeof o === 'string' ? o : o['@id']);
  };
  const bList = getContains(before);
  const aList = getContains(after);
  const diff = aList.filter(x => !bList.includes(x));
  process.stdout.write(diff[0] || '');
")

if [[ -z "$FILE_URL" ]]; then
  echo "Could not find file URL in container"
  exit 1
fi
echo "FILE_URL: $FILE_URL"

# POST internal media assets
INTERNAL_TOKEN="test-atproto-signing-token-local"
echo "Sending internal media pipeline update..."
curl -s -X POST "http://localhost:3000/api/internal/media-pipeline/assets" \
  -H "Authorization: Bearer $INTERNAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"asset\": { \"url\": \"$FILE_URL\", \"mimeType\": \"text/plain\" },
    \"bindings\": { \"activitypub\": { \"attributedTo\": \"$WEBID\" } },
    \"signals\": [{ \"source\": \"google-vision\", \"labels\": [\"nsfw\"], \"confidence\": 0.91 }],
    \"moderation\": { \"action\": \"label\", \"moduleId\": \"media-policy\", \"reason\": \"Policy enforcement\" }
  }"

# Verify
echo "Verifying actor signals on file metadata..."
FINAL_META=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/ld+json" "$FILE_URL")

# Check for required fields
# Pod-provider uses JSON-LD expansions often, but we check common keys
node -e "
  const m = $FINAL_META;
  const check = (m['as:sensitive'] === true || m['https://www.w3.org/ns/activitystreams#sensitive'] === true) &&
                (m['sema:mediaPipelineModerationAction'] === 'label' || m['http://schema.org/mediaPipelineModerationAction'] === 'label');
  
  if (check) {
    console.log('Verification: PASS');
    console.log('File URL:', '$FILE_URL');
    console.log('Moderation:', JSON.stringify(m['sema:mediaPipelineModeration'] || m['http://schema.org/mediaPipelineModeration'], null, 2));
    process.exit(0);
  } else {
    console.log('Verification: FAIL');
    console.log(JSON.stringify(m, null, 2));
    process.exit(1);
  }
"
