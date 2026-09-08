# Deploy your own traffic server

CoMaps can draw live traffic and factor it into routing, but it ships with **no traffic provider**.
There is no default server and no shared key: if you want traffic, you run the service yourself and
pair your phone with it.

The short version: deploy the service, scan a QR code, tap **Cover this area**, turn on the Traffic
layer.

## What you need

- A free [TomTom developer key](https://developer.tomtom.com/) — 2,500 requests/day, no card.
- A Cloudflare account, or somewhere to run Docker.
- The CoMaps map for wherever you want traffic, downloaded on your phone.

That is all. You do **not** need a build toolchain: the app builds what the server needs from the
map it already has.

## 1. Deploy the service

### Cloudflare (one click)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/JasonKeirstead/comaps/tree/main/tools/traffic_server)

The button forks the repo, creates the R2 bucket and KV namespace, prompts for two secrets
(`TOMTOM_API_KEY` and `TRAFFIC_ADMIN_TOKEN` — the latter can be any long random string), and
deploys. Cloudflare does the authenticating in its own browser flow, so no API token is handed to
anything.

Note the worker URL when it finishes; you need it in step 2.

### Or run it yourself

```bash
cd tools/traffic_server
cp .env.example .env      # fill in TOMTOM_API_KEY, TRAFFIC_ADMIN_TOKEN, TRAFFIC_PUBLIC_BASE_URL
docker compose up -d
curl -s localhost:8080/healthz | jq
```

`TRAFFIC_PUBLIC_BASE_URL` must be the address **the phone** will use — your machine's LAN address,
not `localhost` — and must end with a slash.

## 2. Pair your phone

Generate a pairing code.

**Cloudflare:**

```bash
curl -s -X POST https://your-worker.workers.dev/admin/pairing-token \
  -H "Authorization: Bearer $TRAFFIC_ADMIN_TOKEN" | jq -r .uri
```

Render that URI as a QR code.

**Docker:**

```bash
docker compose exec traffic node --experimental-strip-types src/entry/cli.ts pair
```

which prints a QR code straight into the terminal.

On the phone: **Settings → Advanced → Traffic server → Scan QR code**. Or **Enter manually** and
type the address and key, which is also the easiest way to test a server.

The QR carries a single-use code valid for five minutes, not the API key, so it is safe to show on
a shared screen. The phone exchanges it for a key of its own, which means you can revoke one device
without disturbing the others:

```bash
docker compose exec traffic node --experimental-strip-types src/entry/cli.ts devices
docker compose exec traffic node --experimental-strip-types src/entry/cli.ts revoke <id>
```

Your TomTom key never leaves the server.

## 3. Cover an area

Pan the map to where you want traffic, then **Settings → Advanced → Traffic server → Cover this
area**.

The app reads the map it already has, builds the road data the server needs for roughly a 34 km box
around the centre of the view, and uploads it. A few seconds, and the server can serve traffic
there.

Coverage is deliberately an area rather than a whole country. The road list is fetched by the app
on every session and held in memory, and no traffic provider has data for most of a country's
roads anyway. If you drive between two cities, cover each of them.

## 4. Turn the layer on

Open the **layers** button on the map and enable **Traffic**.

Traffic only renders in **Driving** map mode — that is how CoMaps models it, the setting is
literally called `DrivingModeHasTraffic` — so select driving mode too.

## How coverage stays in sync

Road data is tied to a specific map *and* a specific map release: road ids are positional within a
map build, so data prepared for one release does not fit another.

The server handles this by following what your phones actually ask for:

- Cover an area once and the server keeps it refreshed while anyone is using it.
- Stop using an area and it drops off the refresh list after an hour, freeing provider quota.
- Update your maps and the app starts asking for the new release — cover the area again, which
  takes a few seconds.

Nothing to edit when you download a new region. `TRAFFIC_AREAS` still exists if you want to pin
areas that must always stay fresh, but it is no longer the complete list.

## Budgeting provider requests

One provider request per active area per refresh:

```
requests/day = 86400 / TRAFFIC_REFRESH_SECONDS × active areas
```

At the default 300 s that is 288 per area per day, so a 2,500/day free tier supports about eight —
which is why `TRAFFIC_MAX_ACTIVE_AREAS` defaults to 8. The service refuses to start if the ceiling
and interval together exceed `TRAFFIC_DAILY_REQUEST_BUDGET`, and `/healthz` reports how much of
today's budget has been used.

Do not go below 60 s. The app polls once a minute and treats data older than six minutes as
outdated, so a faster refresh buys nothing and just burns quota.

## Advanced: preparing coverage on a desktop

You only need this to cover an area whose map is not on your phone, or to script coverage for
several regions.

Build `generator_tool` from this repository, then:

```bash
generator_tool \
  --data_path=./data \
  --user_resource_path=./data \
  --output=Belarus_Minsk_Region \
  --generate_traffic_index="./index/260906/Belarus_Minsk Region.cmti" \
  --traffic_index_bbox=53.86,27.48,53.95,27.66
```

- `--traffic_index_bbox` is `minLat,minLon,maxLat,maxLon`.
- `--traffic_index_road_classes` defaults to `motorway,trunk,primary,secondary,tertiary`, the
  classes the map draws from zoom 10. Adding `living_street` or `service` multiplies the size for
  roads no provider reports on.
- The tool prints the exact `Country@version` to configure.

Upload it to `index/<mapVersion>/<Country>.cmti` — `wrangler r2 object put` on Cloudflare, or into
the mounted `data/` directory for Docker.

## Troubleshooting

**No traffic appears.** Check in order: the Traffic layer is on and the map is in Driving mode;
`/healthz` shows a recent `generatedAt` for your area; the phone can reach the server (try the URL
in the phone's browser).

**Traffic worked, then stopped after a map update.** The map release changed, so the old road data
no longer fits. Tap **Cover this area** again.

**"This area is too large."** Zoom in and retry. The area is taken from the map centre, so the
zoom level does not change it — but the map you are over might simply be dense. Cover a smaller
region.

**"Download the map for this area first."** Covering builds from a map on the device; download the
region in CoMaps first.

**`/healthz` says `degraded`.** No successful refresh within two intervals. Check the logs
(`docker compose logs` or `wrangler tail`); usually a bad TomTom key or an exhausted daily budget.

**Roads colour on the wrong carriageway.** Adjust `TRAFFIC_BEARING_TOLERANCE_DEG` (default 50).
Lower is stricter.

**Only some roads colour.** Expected. Providers report on major roads; everything unsampled is
left uncoloured rather than being claimed as clear.

## How it fits together

```
phone: Cover this area ──► road data for a bounded area ──► your server (R2 / disk)
                                                                │
                          TomTom incidents ───────────────────► refresh (every 5 min)
                                                                │
phone: traffic layer ◄──── GET {version}/{Country}.traffic ◄────┘
```

The service serves stored bytes and refreshes on a timer; it never calls the provider from a
request. That is what keeps a free TomTom tier viable against an app that polls once a minute.
