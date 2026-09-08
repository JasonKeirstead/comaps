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
src/core/           pipeline, etag, auth, pairing, config, settings, speed groups
src/http/router.ts  Request -> Response, runtime-agnostic
src/storage/        filesystem (container), KV, and KV+R2 (Cloudflare)
src/entry/          worker.ts (fetch), node.ts (http), cli.ts (operator)
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

**A request may generate, but at most once per interval.** The client polls once a minute per
visible map, so generating on every poll would exhaust a free TomTom tier in minutes. The interval
is what prevents that, not a separate schedule -- see *Refreshes are caused by requests*.

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
| POST | `/v1/index` | upload a `.cmti` for one (country, map version); device key, not admin |
| POST | `/v1/pair` | redeem a pairing token for an API key |
| POST | `/admin/pairing-token` | mint a single-use token (admin) |
| GET | `/admin/devices` · DELETE `/admin/devices/{id}` | list and revoke (admin) |
| GET · PUT | `/admin/refresh-interval` | read or change the refresh interval (admin) |
| GET | `/healthz` | per-area freshness and remaining provider budget |

Client paths are matched from the end, since the operator chooses the mount point. The version
segment is absent when the map version is 0.

## Refreshes are caused by requests

There is no cron and no timer. `handleValues` calls `refreshArea`, which either returns the
stored body (still inside the interval) or fetches from the provider, encodes, stores and returns
the new one. An area nobody requests is never refreshed, so an idle deployment spends nothing.

This started life as a Cron Trigger, on the theory that encoding was too expensive for the
request path. Measured on the real 22k-segment Minsk index, that was wrong by an order of
magnitude:

```
parse                  0.1 ms
generate, 10 events    0.5 ms
generate, 50 events    1.1 ms
generate, 200 events   3.4 ms
```

against a 10 ms free-plan budget. The cron also bought no headroom, because a Cron Trigger on the
free plan gets *the same* 10 ms CPU limit as an HTTP request — and it was worse than per-request
work, since it refreshed several areas in one invocation and so came far closer to the limit than
any single request does.

`refreshArea` returns the previous body rather than nothing whenever it cannot produce a new one:
provider outage, spent budget, or another request already refreshing this area. Stale traffic is
much better than none, and the client only stops rendering if it hears nothing from the server at
all for six minutes.

Two guards worth knowing:

- **Single-flight.** `refreshing/{version}/{country}` is set for the duration of a provider call,
  with a 60 s TTL. Without it, every phone polling the same city the moment its data goes stale
  fetches simultaneously.
- **Daily budget.** `TRAFFIC_DAILY_REQUEST_BUDGET` bounds provider calls *and* stored writes,
  since a refresh is exactly one of each. It is the only cap on spend, which is why
  `validateConfig` refuses a non-positive value.

`refreshArea(..., { force: true })` skips the freshness and single-flight checks, for an operator
asking by hand. `refreshAll` is that, over every area an index exists for; nothing in normal
operation calls it.

### What the client actually requires

Worth knowing before changing the interval. `kOutdatedDataTimeout` in
`libs/map/traffic_manager.cpp` is 6 minutes, but it is measured from `m_lastResponseTime` — and a
**304 counts as a response**, because `ReceiveTrafficData` returns true for `NotChanged` and the
caller then runs `OnTrafficDataResponse`. So the timeout means "the server has not answered for
six minutes", not "the data is older than six minutes". The age of the data does not matter to
the client at all, which is what makes a 30 minute interval, or an hour, perfectly safe.

## Storage backends

Three implementations of one `Storage` interface (`src/storage/types.ts`), covering blobs
(indexes, generated bodies) and small mutable state (pairing tokens, device keys, the chosen
refresh interval, the in-flight marker, the quota counter).

| | Blobs | State |
|---|---|---|
| `FsStorage` | disk | disk |
| `KvStorage` | KV | KV |
| `R2KvStorage` | R2 | KV |

`KvStorage` is the Cloudflare default, and `R2KvStorage` extends it, overriding only the blob
methods. `worker.ts` picks between them on whether an `R2_INDEX` binding exists, so enabling R2 is
a config change rather than a code change.

KV by default because R2's free tier sits behind a subscription step that a plain free account has
not been through, and the deploy fails outright without it. The objects are small enough to make
this uninteresting: a whole-region index is ~400 KB, a generated body a few KB, against a 25 MiB
KV value limit.

What KV does cost is write quota -- 1,000/day on the free plan. A refresh is one write, so
`TRAFFIC_DAILY_REQUEST_BUDGET` bounds it; the Cloudflare default of 900 sits under the KV ceiling
rather than under TomTom's larger one. The container defaults to 2,000, since disk has no such
limit.

`listAll` follows the list cursor, because KV pages at 1000 keys.

## Where areas come from

Nowhere: they are not a set the service maintains. An area is servable when an index exists for
its (country, map version), and it is refreshed when someone asks for it. `TRAFFIC_AREAS` only
feeds `/healthz` and `comaps-traffic refresh`.

That matters because coverage is per (country, map version), and the map version changes under
you every time the user updates maps. Any list of areas the service kept would go stale silently
and spend provider quota on areas nobody is looking at.

`POST /v1/index` is how one arrives: the phone builds a `.cmti` from the map it already has and
uploads it, authenticated with its own pairing key, so no cloud credential ever lands on a device.
The upload is parsed and cross-checked against the `x-traffic-country` and `x-traffic-map-version`
headers before it is stored -- a mismatch here becomes a key-count mismatch on the client, which
discards the payload without reporting anything.

## Adding a provider

Implement `TrafficProvider` in `src/core/providers/` — one `fetch(bbox)` returning
`{geometry, group}[]` — and select it in `createProvider`. Keep it to a couple of requests per
call: free tiers are small, and this runs inside a client request, so it is also latency the
phone waits on.

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
