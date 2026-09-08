#!/usr/bin/env bash
# End-to-end protocol checks against a running traffic service.
#
# These cover the things a unit test cannot: what actually goes over the wire to the client.
# Every one of them corresponds to a way the C++ client fails badly if we get it wrong.
#
#   usage: BASE_URL=http://localhost:8080/ API_KEY=... COUNTRY='Belarus_Minsk Region' \
#          MAP_VERSION=250628 ./test/conformance.sh
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080/}"
API_KEY="${API_KEY:-}"
COUNTRY="${COUNTRY:-}"
MAP_VERSION="${MAP_VERSION:-}"

if [[ -z "$COUNTRY" || -z "$MAP_VERSION" ]]; then
  echo "set COUNTRY and MAP_VERSION (see .env)" >&2
  exit 2
fi

BASE_URL="${BASE_URL%/}/"
# The client percent-encodes the country name with url::UrlEncode.
ENCODED=$(printf '%s' "$COUNTRY" | jq -sRr @uri)
VALUES_URL="${BASE_URL}${MAP_VERSION}/${ENCODED}.traffic"
KEYS_URL="${VALUES_URL}.keys"

pass=0
fail=0
check() {
  if [[ "$2" == "$3" ]]; then
    printf '  ok   %s\n' "$1"
    pass=$((pass + 1))
  else
    printf '  FAIL %s\n         expected: %s\n         actual:   %s\n' "$1" "$3" "$2"
    fail=$((fail + 1))
  fi
}

auth=(-H "x-api-key: ${API_KEY}")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Traffic service conformance: $BASE_URL"

# --- values ---------------------------------------------------------------
status=$(curl -s -o "$tmp/body" -D "$tmp/head" -w '%{http_code}' "${auth[@]}" "$VALUES_URL")
check "values returns 200" "$status" "200"

etag=$(grep -i '^etag:' "$tmp/head" | tr -d '\r' | cut -d' ' -f2-)
# Without an ETag the client never updates its stored tag and resends a stale
# If-None-Match forever.
if [[ -n "$etag" ]]; then
  check "values sends an ETag" "present" "present"
else
  check "values sends an ETag" "missing" "present"
fi

if [[ -s "$tmp/body" ]]; then
  check "values body is non-empty" "yes" "yes"
else
  check "values body is non-empty" "no" "yes"
fi

# The body is a zlib stream (RFC 1950): low nibble of byte 0 is 8, and the first two bytes
# form a big-endian multiple of 31. gzip or raw deflate will not decode on the client.
zlib_ok=$(python3 - "$tmp/body" <<'PY'
import sys
data = open(sys.argv[1], 'rb').read(2)
print("yes" if len(data) == 2 and (data[0] & 0x0f) == 8 and ((data[0] << 8) | data[1]) % 31 == 0 else "no")
PY
)
check "values body is a zlib stream" "$zlib_ok" "yes"

# --- 304 ------------------------------------------------------------------
if [[ -n "$etag" ]]; then
  status=$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" -H "If-None-Match: $etag" "$VALUES_URL")
  check "echoing the ETag gives 304" "$status" "304"
fi

# The client's very first request sends an empty If-None-Match.
status=$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" -H "If-None-Match;" "$VALUES_URL")
check "empty If-None-Match still gives 200" "$status" "200"

# --- keys -----------------------------------------------------------------
# ReadRemoteFile carries the same x-api-key, so an auth-gated keys endpoint must accept it.
status=$(curl -s -o "$tmp/keys" -w '%{http_code}' "${auth[@]}" "$KEYS_URL")
check "keys returns 200 with the same key" "$status" "200"

version_byte=$(head -c 1 "$tmp/keys" | od -An -tu1 | tr -d ' ')
check "keys blob starts with version 0" "$version_byte" "0"

# --- 404 ------------------------------------------------------------------
# TrafficInfo::ProcessFailure runs the body through VERIFY(strings::to_int64(...)), which is a
# CHECK in debug builds: any non-integer body, or even a trailing newline, aborts the app.
body=$(curl -s "${auth[@]}" "${BASE_URL}${MAP_VERSION}/Nowhere_Land.traffic")
if [[ "$body" =~ ^[0-9]+$ ]]; then
  check "404 body is a bare integer" "bare integer" "bare integer"
else
  check "404 body is a bare integer" "$(printf '%q' "$body")" "bare integer"
fi

# --- auth -----------------------------------------------------------------
if [[ -n "$API_KEY" ]]; then
  status=$(curl -s -o /dev/null -w '%{http_code}' "$VALUES_URL")
  check "values rejects a missing key" "$status" "401"
  status=$(curl -s -o /dev/null -w '%{http_code}' -H "x-api-key: definitely-wrong" "$KEYS_URL")
  check "keys rejects a wrong key" "$status" "401"
fi

# --- health ---------------------------------------------------------------
status=$(curl -s -o "$tmp/health" -w '%{http_code}' "${BASE_URL}healthz")
check "healthz responds" "$status" "200"

echo
echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
