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

The button forks the repo, creates the KV namespace, and deploys. **The only thing it asks you for
is your TomTom key.** Everything else has a working default or is worked out at runtime — there is
no admin token to invent, no coverage list to fill in, and no public URL to guess.

Cloudflare does the authenticating in its own browser flow, so no API token is handed to anything.

**This works on a free Workers account.** The service stores everything in KV, which the free plan
includes; it does not require R2, whose free tier is behind a separate subscription step. An index
is a few hundred KB and a generated body a few KB, against KV's 25 MiB per-value limit. See
[Budgeting](#budgeting) if you later want more than the free write quota allows.

Note the worker URL when it finishes. You want it in a browser for step 2.

### Or run it yourself

```bash
cd tools/traffic_server
cp .env.example .env      # fill in TOMTOM_API_KEY and TRAFFIC_PUBLIC_BASE_URL
docker compose up -d
curl -s localhost:8080/healthz | jq
```

`TRAFFIC_PUBLIC_BASE_URL` must be the address **the phone** will use — your machine's LAN address,
not `localhost` — and must end with a slash. Unlike the Cloudflare deployment there is no way to
work this out from the request, since a phone on your LAN and the container see different
addresses.

## 2. Pair your phone

Open the worker URL in a browser:

```
https://your-worker.workers.dev/
```

It shows a QR code. On the phone: **Settings → Advanced → Traffic server → Scan QR code**, and
point it at the screen. That is the whole of pairing.

If the camera will not cooperate, the same page has a **Show me a key to type in** link, which
gives you an address and key for **Enter manually** in the same menu.

The page also shows an **admin token**, generated for you. Save it. The setup page stops being
public the moment a device pairs — after that you get back in with
`https://your-worker.workers.dev/setup?token=YOUR_ADMIN_TOKEN`, which is also how you pair a
second phone.

> Lost the admin token? Delete the `settings/adminToken` key from the Worker's KV namespace in the
> Cloudflare dashboard and reload the page; a new one is generated.

**Docker** has the same page at `http://your-machine:8080/`, or you can print a QR straight into
the terminal:

```bash
docker compose exec traffic node --experimental-strip-types src/entry/cli.ts pair
```

### Why it works this way

The QR carries a single-use code valid for five minutes, not the API key, so it is safe to show on
a shared screen. The phone exchanges it for a key of its own, which means you can revoke one device
without disturbing the others:

```bash
docker compose exec traffic node --experimental-strip-types src/entry/cli.ts devices
docker compose exec traffic node --experimental-strip-types src/entry/cli.ts revoke <id>
```

Or over HTTP, with the admin token:

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://your-worker.workers.dev/admin/devices
```

Your TomTom key never leaves the server.

The setup page being open until the first pairing is deliberate — it is the same trade a router
makes on first boot. The window is from deploy until you scan, usually under a minute, and it
closes by itself. The alternative was a secret you had to produce before anything worked, which is
what made the deploy unusable.

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

The server handles this by never deciding anything in advance. It serves the release your phone
asks for, and refreshes it when your phone asks:

- Cover an area once and it stays usable, refreshed whenever someone is actually looking at it.
- Stop using an area and it costs nothing at all — there is no list it stays on.
- Update your maps and the app starts asking for the new release — cover the area again, which
  takes a few seconds.

Nothing to edit when you download a new region. `TRAFFIC_AREAS` is only used for `/healthz`
reporting; it does not decide what is served or refreshed.

## How often traffic refreshes

Nothing runs on a schedule. Your phone asks for traffic once a minute; if what the server holds
is older than the interval below, **that request** is what fetches new data from TomTom. An area
nobody is looking at costs nothing - no provider calls, no quota, no writes. Close the app and the
server goes idle.

The interval is therefore a staleness bound, not a timetable. Four choices: **5 minutes,
10 minutes, 30 minutes, or 1 hour**, defaulting to 30. TomTom reports *incidents*, which persist
for tens of minutes, so a shorter bound mostly fetches the same data again.

You do not need to redeploy to change it. `$ADMIN_TOKEN` below is the admin token the setup
page showed you in step 2.

**Cloudflare:**

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://your-worker.workers.dev/admin/refresh-interval | jq
```

```bash
curl -s -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" -d '{"seconds": 600}' \
  https://your-worker.workers.dev/admin/refresh-interval
```

**Docker:**

```bash
docker compose exec traffic node --experimental-strip-types src/entry/cli.ts interval
docker compose exec traffic node --experimental-strip-types src/entry/cli.ts interval 600
```

Both list the options with what each costs. It takes effect on the next request - there is
nothing to restart.

## Budgeting

One refresh is one TomTom call and one stored write, so a single number bounds both:
`TRAFFIC_DAILY_REQUEST_BUDGET`. Spend it and the server keeps serving what it has, and stops
fetching until midnight UTC.

What one area costs, if someone watches it all day long:

| Interval | Refreshes/day per area | Areas within a 900/day budget |
|---|---|---|
| 5 min | 288 | 3 |
| 10 min | 144 | 6 |
| 30 min | 48 | 18 |
| 1 hour | 24 | 37 |

Those are worst cases. Real use is a fraction of it - you are not looking at the map 24 hours a
day, and an area you are not looking at is not refreshed at all.

The Cloudflare default is 900, which keeps you under the free plan's **1,000 KV writes/day** -
that binds before TomTom's 2,500 calls/day does. `/healthz` reports how much of today's budget is
gone. Docker defaults to 2,000, since disk has no write ceiling.

**If you want more:** enable R2 on your Cloudflare account, uncomment the `[[r2_buckets]]` block
in `wrangler.toml`, raise `TRAFFIC_DAILY_REQUEST_BUDGET` to whatever your TomTom key allows, and
redeploy. The Worker notices the binding and moves indexes and generated bodies to R2, where this
volume of writes costs nothing. No code change.

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

Then upload it. The simplest route is the same one the app uses, which works on either
deployment and needs only a paired key:

```bash
curl -X POST "https://your-worker.workers.dev/v1/index" \
  -H "x-api-key: $YOUR_PAIRED_KEY" \
  -H "x-traffic-country: Belarus_Minsk Region" \
  -H "x-traffic-map-version: 260906" \
  --data-binary @"./index/260906/Belarus_Minsk Region.cmti"
```

Both headers are required, and the server checks them against what it parses out of the file —
a mismatch is rejected rather than stored, since an index filed under the wrong version produces
a key-count mismatch that the client discards without explanation. `generator_tool` prints the
exact `Country@version` to use.

For Docker you can also just drop the file into the mounted `data/` directory at
`index/<mapVersion>/<Country>.cmti`.

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
phone: Cover this area ──► road data for a bounded area ──► your server (KV / R2 / disk)

phone: traffic layer ──► GET {version}/{Country}.traffic
                              │
                              ├─ stored data still fresh?  ──► serve it (~1 ms)
                              │
                              └─ older than the interval?  ──► TomTom incidents
                                                              ──► encode + store (~3.5 ms)
                                                              ──► serve it
```

Every provider call is caused by someone actually looking at the map. There is no timer, so an
idle server spends nothing, and the interval caps how often any one area can cost you a call no
matter how many phones are polling it.
