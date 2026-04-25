#!/bin/bash
RAND=$RANDOM
USERNAME="user$RAND"
PASSWORD="password123"
EMAIL="email$RAND@example.com"
SIGNUP_RESPONSE=$(curl -s -X POST http://localhost:3000/auth/signup -H "Content-Type: application/json" -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\",\"email\":\"$EMAIL\"}")
TOKEN=$(echo "$SIGNUP_RESPONSE" | jq -r '.token')
if [ "$TOKEN" = "null" ] || [ -z "$TOKEN" ]; then
  echo "Signup failed: $SIGNUP_RESPONSE"
  exit 1
fi
LONG_TAG="#$(printf 'a%.0s' {1..310})"
echo "--- RESULT ---"
curl -s -i -X POST http://localhost:3000/api/dashboard/hashtags/follows -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{\"tag\":\"$LONG_TAG\"}"
