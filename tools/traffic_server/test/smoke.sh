#!/usr/bin/env bash
# Boots the Node entry point against a fixture index and exercises the client-facing routes.
#
# No TomTom key is needed: the one provider call this makes is expected to fail with 401, which
# is itself worth checking -- a service that cannot reach its provider must keep serving keys,
# must 404 rather than serve stale or malformed values, and must stay healthy: a provider that
# cannot be reached is not the same fault as a service that is misconfigured.
set -uo pipefail

cd "$(dirname "$0")/.."
DATA=$(mktemp -d)
COUNTRY='Belarus_Minsk Region'
VERSION=250628
PORT=8099
trap 'rm -rf "$DATA"; [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null' EXIT

node --experimental-strip-types test/make-fixture-index.ts "$DATA" "$COUNTRY" "$VERSION" || exit 1

TOMTOM_API_KEY=stub \
TRAFFIC_AREAS="${COUNTRY}@${VERSION}" \
TRAFFIC_API_KEY=smoke-key \
TRAFFIC_ADMIN_TOKEN=smoke-admin \
TRAFFIC_PUBLIC_BASE_URL="http://127.0.0.1:${PORT}/" \
TRAFFIC_INDEX_DIR="$DATA" \
PORT=$PORT \
  node --experimental-strip-types src/entry/node.ts > "$DATA/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 && break
  sleep 0.25
done

BASE="http://127.0.0.1:${PORT}"
ENCODED=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$COUNTRY")
AUTH=(-H "x-api-key: smoke-key")
fail=0

expect() {
  if [[ "$2" == "$3" ]]; then printf '  ok   %s\n' "$1"
  else printf '  FAIL %s (expected %s, got %s)\n' "$1" "$3" "$2"; fail=1; fi
}

echo "Smoke test against $BASE"

# 200: we hold an index for the area, so the service is configured correctly. Having no
# generated data yet is expected -- refreshes are demand-driven, and the only request so far
# failed at the provider.
expect "healthz is ok when the index is present but nothing has been generated" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz")" "200"

expect "healthz says refreshes are on demand" \
  "$(curl -s "$BASE/healthz" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).refreshedOnDemand)))')" \
  "true"

expect "healthz still reports the area and its index" \
  "$(curl -s "$BASE/healthz" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).areas[0].hasIndex)))')" \
  "true"

expect "keys blob is served" \
  "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$BASE/$VERSION/$ENCODED.traffic.keys")" "200"

expect "keys require auth" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/$VERSION/$ENCODED.traffic.keys")" "401"

# No refresh has succeeded (the provider is a stub), so values should 404 rather than serve
# something stale or crash.
expect "values 404 while no data has been generated" \
  "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$BASE/$VERSION/$ENCODED.traffic")" "404"

body=$(curl -s "${AUTH[@]}" "$BASE/$VERSION/$ENCODED.traffic")
if [[ "$body" =~ ^[0-9]+$ ]]; then printf '  ok   404 body is a bare integer\n'
else printf '  FAIL 404 body is a bare integer (got %q)\n' "$body"; fail=1; fi

token=$(curl -s -X POST -H "Authorization: Bearer smoke-admin" "$BASE/admin/pairing-token" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token))')
expect "pairing token is issued" "$([[ -n "$token" ]] && echo yes || echo no)" "yes"

key=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"token\":\"$token\",\"device\":\"smoke\"}" "$BASE/v1/pair" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).apiKey||""))')
expect "token is redeemed for a key" "$([[ -n "$key" ]] && echo yes || echo no)" "yes"

expect "the paired key authorises requests" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "x-api-key: $key" "$BASE/$VERSION/$ENCODED.traffic.keys")" "200"

expect "the token cannot be replayed" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
     -d "{\"token\":\"$token\",\"device\":\"replay\"}" "$BASE/v1/pair")" "410"

echo
if [[ $fail -eq 0 ]]; then echo "smoke test passed"; else echo "smoke test FAILED"; echo "--- server log ---"; cat "$DATA/server.log"; fi
exit $fail
