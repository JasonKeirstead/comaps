# Deploy your own traffic server

CoMaps can draw live traffic and factor it into routing, but it ships with **no traffic provider**.
There is no default server and no shared key: if you want traffic, you run the service yourself and
pair your phone with it.

This doc covers building a coverage index, running the service (on your own machine or on
Cloudflare), and pairing a phone.

## What you need

- A free [TomTom developer key](https://developer.tomtom.com/). The free tier allows 2,500
  non-tile requests per day, which is enough for a handful of areas.
- A build of `generator_tool` from this repository, to build the coverage index.
- The `.mwm` file for the region you want to cover, at the **same map version your phone has**.
- Docker, or a Cloudflare account.

## Coverage is a city, not a country

A coverage area is one bounded region — a city, a metro area, a commute corridor. The index
builder refuses anything over 250,000 road segments by default.

That is deliberate, not a temporary limitation. The client fetches the key list from the server on
every session and holds it in memory at 8 bytes per directional segment, and no incident provider
has data for most of a country's roads anyway. If you need a wider area, cover the parts you
actually drive.

## 1. Build the index

The service never parses `.mwm` files — it could not do so on Cloudflare Workers in any case. Map
reading happens once, offline, and produces a `.cmti` index holding the traffic key list plus a
representative point per road segment.

```bash
generator_tool \
  --data_path=./data \
  --user_resource_path=./data \
  --output=Belarus_Minsk_Region \
  --generate_traffic_index=./index/250628/Belarus_Minsk\ Region.cmti \
  --traffic_index_bbox=53.82,27.40,53.98,27.70 \
  --traffic_index_max_segments=250000
```

- `--traffic_index_bbox` is `minLat,minLon,maxLat,maxLon`. Omit it to cover the whole `.mwm`,
  which only works for small extracts.
- `--traffic_index_road_classes` defaults to
  `motorway,trunk,primary,secondary,tertiary` — the classes the map actually draws from zoom 10.
  Adding `living_street` or `service` multiplies the segment count for roads no provider reports on.
- `--traffic_index_map_version` defaults to 0, meaning "read the map series stamp out of the
  `.mwm`". Set it only if you need to override what the file reports.

The output path must be `index/<mapVersion>/<Country>.cmti`, where `<Country>` is the `.mwm` name
exactly as it appears in `data/countries.txt` and `<mapVersion>` is the map series stamp.

> **Feature ids are only stable within one map build.** An index built against a different map
> release will not line up with what is on the phone, the client will silently discard every
> response, and traffic will simply never appear. When you update maps, rebuild the index.

## 2a. Run it yourself (Docker)

```bash
cd tools/traffic_server
cp .env.example .env      # fill in TOMTOM_API_KEY, TRAFFIC_AREAS, TRAFFIC_PUBLIC_BASE_URL
mkdir -p data/index/250628
cp "/path/to/Belarus_Minsk Region.cmti" "data/index/250628/"
docker compose up -d
```

Check it came up and found the index:

```bash
docker compose exec traffic node --experimental-strip-types src/entry/cli.ts check
curl -s localhost:8080/healthz | jq
```

`TRAFFIC_PUBLIC_BASE_URL` must be the address **the phone** will use — your machine's LAN address,
not `localhost` — and must end with a slash.

## 2b. Run it on Cloudflare

```bash
cd tools/traffic_server
npm install
wrangler r2 bucket create comaps-traffic-index
wrangler kv namespace create KV_STATE     # put the id in wrangler.toml

wrangler r2 object put "comaps-traffic-index/index/250628/Belarus_Minsk Region.cmti" \
  --file "./Belarus_Minsk Region.cmti"

wrangler secret put TOMTOM_API_KEY
wrangler secret put TRAFFIC_ADMIN_TOKEN
wrangler deploy
```

Edit `TRAFFIC_AREAS` and `TRAFFIC_PUBLIC_BASE_URL` in `wrangler.toml` first.

A note on plans: the Cron Trigger does the provider call and the encoding, and the request handler
only streams a stored blob, so serving stays inside the free plan's 10 ms CPU budget regardless of
area size. Generation is tens of milliseconds and will exceed the free plan's cron budget as an
area approaches the 250k cap — the Workers Paid plan raises that to 30 s. Small areas are fine on
the free plan.

## 3. Pair your phone

**Docker:**

```bash
docker compose exec traffic node --experimental-strip-types src/entry/cli.ts pair
```

That prints a QR code in the terminal. On the phone: **Settings → Advanced → Traffic server →
Scan QR code**.

**Cloudflare:**

```bash
curl -s -X POST https://your-worker.workers.dev/admin/pairing-token \
  -H "Authorization: Bearer $TRAFFIC_ADMIN_TOKEN" | jq -r .uri
```

Render that URI as a QR code and scan it, or use **Enter manually** in the app.

The QR carries a single-use token valid for five minutes, not the API key, so it is safe to show
on a shared screen. The phone exchanges it for a long-lived key of its own, which means you can
revoke one device without disturbing the others:

```bash
docker compose exec traffic node --experimental-strip-types src/entry/cli.ts devices
docker compose exec traffic node --experimental-strip-types src/entry/cli.ts revoke <id>
```

Your TomTom key never leaves the server.

## 4. Turn the layer on

Pairing configures the server; it does not switch traffic on. On the map, open the **layers** button
and enable **Traffic**. Traffic only renders in **Driving** map mode.

## Budgeting provider requests

The service makes one provider request per area per refresh:

```
requests/day = 86400 / TRAFFIC_REFRESH_SECONDS × number of areas
```

At the default 300 s that is 288 per area per day, so a 2,500/day free tier supports about eight
areas. The service refuses to start if the configured areas and interval exceed
`TRAFFIC_DAILY_REQUEST_BUDGET`, and `/healthz` reports how much of the budget today has used.

Do not go below 60 s. The client polls once a minute and treats data older than six minutes as
outdated, so a faster refresh buys nothing and just burns quota.

## Troubleshooting

**No traffic appears at all.** Check, in order: the layer is on and the map is in Driving mode;
`/healthz` shows a recent `generatedAt` for your area; the phone can actually reach
`TRAFFIC_PUBLIC_BASE_URL` (try it in the phone's browser).

**Traffic worked and then stopped after a map update.** The map version changed, so the index no
longer matches. Rebuild it, upload it under the new version directory, and update `TRAFFIC_AREAS`.

**`/healthz` says `degraded`.** No successful refresh within two intervals. Look at the container
logs or `wrangler tail`; the usual causes are a bad TomTom key and an exhausted daily budget.

**Roads colour on the wrong carriageway.** Raise or lower `TRAFFIC_BEARING_TOLERANCE_DEG`
(default 50). Lower is stricter.

**Only some roads ever colour.** Expected. Incident providers report on major roads; everything
unsampled stays `Unknown` and is deliberately not painted, rather than being claimed as free-flowing.

## How it fits together

```
generator_tool --generate_traffic_index        (offline, once per map release)
        |
        v
  <Country>.cmti  ──►  traffic service  ──►  GET {base}{version}/{Country}.traffic
   keys + geometry      + TomTom incidents     GET {base}{version}/{Country}.traffic.keys
                        (refreshed on a timer)
```

The wire format is byte-compatible with the client's decoder, and the shared golden vectors in
`libs/traffic/traffic_tests/golden_traffic_vectors.json` are read by both the C++ test suite and
the service's own tests to keep it that way.
