# CoMaps traffic service

A small, stateless service that turns a traffic provider's incident feed into the `.traffic`
payloads the CoMaps client expects. One codebase runs on Cloudflare Workers and self-hosted under
Node; only storage and scheduling differ.

For setup instructions see [docs/DEPLOY_OWN_TRAFFIC_SERVER.md](../../docs/DEPLOY_OWN_TRAFFIC_SERVER.md).
This file is about the code.

## Layout

```
src/core/wire/      byte-exact port of the client's encoders (bit-writer, elias, varint, keys, values)
src/core/index/     .cmti reader and the grid lookup used to match incidents to segments
src/core/providers/ TomTom incidents
src/core/           pipeline, etag, auth, pairing, config, speed groups
src/http/router.ts  Request -> Response, runtime-agnostic
src/storage/        filesystem (container) and R2+KV (Cloudflare)
src/entry/          worker.ts (fetch + scheduled), node.ts (http + timer), cli.ts (operator)
```

## Development

```bash
npm install
npm test          # node --test, no build step
npm run typecheck
npm start         # reads .env-style vars from the environment
npm run dev:worker
```

Sources import each other with explicit `.ts` extensions so they run directly under
`node --experimental-strip-types`. That also rules out TypeScript features that emit code:
no `enum`, no parameter properties, no `namespace`.

## The parts worth knowing before you change anything

**The server defines the key universe.** CoMaps builds maps with `generate_traffic_keys=False`, so
shipped `.mwm` files carry no traffic section and the client fetches its key list from us. That is
what makes bounded coverage possible: we serve keys for a filtered subset of one map, and nothing
in the client minds.

**`values.length` must equal the key count exactly.** A mismatch makes the client discard the whole
payload with only a log line. Both come from the same `.cmti`, so this holds as long as the index
matches the map version the phone has.

**Unknown, not G5, for unsampled segments.** The client drops `Unknown` before building its
coloring map, so unsampled roads cost nothing and are not drawn. Filling with G5 would claim
"verified free-flowing" for roads nobody looked at *and* materialise a map node per segment, which
the drape engine then copies wholesale to the render thread.

**A 404 body must be a bare decimal integer.** `TrafficInfo::ProcessFailure` runs it through
`VERIFY(strings::to_int64(...))`, which is a `CHECK` in debug builds. JSON, HTML, or even a
trailing newline will abort the app.

**Send an `ETag` on every 200.** The client only updates its stored tag from the response header.
Omit it and it will resend a stale `If-None-Match` forever.

**Generation stays out of the request path.** The client polls once a minute per visible map, so
serving live would exhaust a free TomTom tier in minutes; and encoding an area is tens of
milliseconds against Cloudflare's 10 ms free-plan CPU budget. A cron or timer generates, the
request handler serves bytes.

**Elias-gamma here is LSB-first.** The client's `BitWriter` fills bytes from bit 0 up, so the unary
prefix and the payload both come out reversed relative to the textbook form. Do not substitute an
off-the-shelf gamma implementation.

**ETags hash the uncompressed payload.** zlib output is implementation-defined, so a tag derived
from the deflated bytes could change when you move between Node and workerd and force every client
to re-download.

## Wire-format conformance

`libs/traffic/traffic_tests/golden_traffic_vectors.json` holds the expected bytes for the keys blob
and for the values payload *before* deflation. Both `test/wire.test.ts` here and
`UNIT_TEST(TrafficInfo_GoldenVectors)` in the C++ suite read that same file, so the two
implementations cannot drift apart without a test going red.

If you change anything under `src/core/wire/`, run both.

## Endpoints

| Method | Path | |
|---|---|---|
| GET | `{base}{version}/{Country}.traffic` | values; 200 with `ETag`, 304, or 404 with a bare integer |
| GET | `{base}{version}/{Country}.traffic.keys` | keys blob, served verbatim |
| POST | `/v1/pair` | redeem a pairing token for an API key |
| POST | `/admin/pairing-token` | mint a single-use token (admin) |
| GET | `/admin/devices` · DELETE `/admin/devices/{id}` | list and revoke (admin) |
| GET | `/healthz` | per-area freshness and remaining provider budget |

Client paths are matched from the end, since the operator chooses the mount point. The version
segment is absent when the map version is 0.

## Adding a provider

Implement `TrafficProvider` in `src/core/providers/` — one `fetch(bbox)` returning
`{geometry, group}[]` — and select it in `createProvider`. Keep it to a couple of requests per
call; free tiers are small and the refresh is on a timer.

## Verifying against the C++ client without a full build

`TrafficInfo_GoldenVectors` needs Qt, boost and the indexer. When you only want to confirm the
wire format, the risky part is narrower: the LSB-first bit writer, Elias-gamma, varint and the
zlib wrapper, all of which live in `libs/coding` and `libs/base` and compile on their own.

A short program that includes those real headers, reproduces the ~30 structural lines of
`SerializeTrafficKeys` / `SerializeTrafficValues`, and compares against `keysHex` /
`valuesPlainHex` from the golden file builds with:

```
g++ -std=c++20 -DRELEASE -I libs -I . -I 3party -o wire_probe probe.cpp \
    libs/coding/zlib.cpp libs/base/logging.cpp libs/base/exception.cpp \
    libs/base/base.cpp libs/base/src_point.cpp libs/base/thread.cpp -lz -lpthread
```

That covers bit ordering and framing definitively. It does not exercise
`DeserializeTrafficKeys`, so run the real unit test before trusting a format change.
