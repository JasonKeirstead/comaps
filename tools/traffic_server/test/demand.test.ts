import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/core/config.ts';
import { activeAreas, recordDemand } from '../src/core/demand.ts';
import { handleRequest } from '../src/http/router.ts';
import { generateTraffic } from '../src/core/pipeline.ts';
import { parseTrafficIndex } from '../src/core/index/format.ts';
import { SpeedGroup } from '../src/core/speed-groups.ts';
import type { GeneratedBlob, Storage } from '../src/storage/types.ts';
import { buildIndex } from './helpers/build-index.ts';

const COUNTRY = 'Belarus_Minsk Region';
const VERSION = 260906;

class MemoryStorage implements Storage {
  indexes = new Map<string, ArrayBuffer>();
  generated = new Map<string, GeneratedBlob>();
  state = new Map<string, string>();

  async readIndex(c: string, v: number) {
    return this.indexes.get(`${v}/${c}`) ?? null;
  }
  async writeIndex(c: string, v: number, body: Uint8Array) {
    this.indexes.set(
      `${v}/${c}`,
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    );
  }
  async indexVersions(c: string) {
    return [...this.indexes.keys()]
      .filter((k) => k.endsWith(`/${c}`))
      .map((k) => Number(k.split('/')[0]))
      .sort((a, b) => b - a);
  }
  async readGenerated(c: string, v: number) {
    return this.generated.get(`${v}/${c}`) ?? null;
  }
  async writeGenerated(c: string, v: number, b: GeneratedBlob) {
    this.generated.set(`${v}/${c}`, b);
  }
  async getState(k: string) {
    return this.state.get(k) ?? null;
  }
  async putState(k: string, v: string) {
    this.state.set(k, v);
  }
  async deleteState(k: string) {
    this.state.delete(k);
  }
  async listState(prefix: string) {
    return [...this.state.keys()].filter((k) => k.startsWith(prefix));
  }
}

function makeIndex(country = COUNTRY, version = VERSION) {
  return buildIndex({
    countryName: country,
    mwmVersion: version,
    features: [{ fid: 3, numSegs: 2, oneWay: true }],
    segments: [
      { segmentIndex: 0, lat: 53.9, lon: 27.56, bearingDeg: 90 },
      { segmentIndex: 1, lat: 53.91, lon: 27.57, bearingDeg: 90 },
    ],
    bbox: { minLat: 53.8, minLon: 27.4, maxLat: 54.0, maxLon: 27.7 },
  });
}

function setup(env: Record<string, string> = {}) {
  const storage = new MemoryStorage();
  const buf = makeIndex();
  storage.indexes.set(`${VERSION}/${COUNTRY}`, buf);

  const index = parseTrafficIndex(buf);
  const generated = generateTraffic(index, [
    { geometry: [[53.9, 27.5599], [53.9, 27.5601]], group: SpeedGroup.G2 },
  ]);
  storage.generated.set(`${VERSION}/${COUNTRY}`, {
    body: generated.body,
    etag: generated.etag,
    generatedAt: Date.now(),
    coloredSegments: generated.coloredSegments,
  });

  const config = loadConfig({
    TOMTOM_API_KEY: 'test',
    TRAFFIC_API_KEY: 'secret-key',
    TRAFFIC_ADMIN_TOKEN: 'admin-token',
    ...env,
  });
  return { storage, config, ctx: { storage, config } };
}

const url = (p: string) => `http://server${p}`;
const encoded = encodeURIComponent(COUNTRY);
const get = (p: string) => new Request(url(p), { headers: { 'x-api-key': 'secret-key' } });

test('an area with no config is discovered from a client request', async () => {
  const { ctx, storage, config } = setup();
  assert.deepEqual(config.areas, [], 'nothing declared up front');

  assert.equal((await handleRequest(get(`/${VERSION}/${encoded}.traffic`), ctx)).status, 200);

  const areas = await activeAreas(storage, config);
  assert.deepEqual(
    areas.map((a) => `${a.country}@${a.mapVersion}`),
    [`${COUNTRY}@${VERSION}`],
    'requesting traffic should put the area on the refresh list',
  );
});

test('a new map version replaces the old one as the client moves to it', async () => {
  const { ctx, storage, config } = setup();
  const NEXT = 261015;
  storage.indexes.set(`${NEXT}/${COUNTRY}`, makeIndex(COUNTRY, NEXT));

  await handleRequest(get(`/${VERSION}/${encoded}.traffic`), ctx);
  await handleRequest(get(`/${NEXT}/${encoded}.traffic.keys`), ctx);

  const areas = await activeAreas(storage, config);
  const labels = areas.map((a) => `${a.country}@${a.mapVersion}`).sort();
  // Both stay live until the old one ages out; the client simply stops asking for it.
  assert.deepEqual(labels, [`${COUNTRY}@${NEXT}`, `${COUNTRY}@${VERSION}`].sort());
});

test('when the ceiling truncates, the most recently requested areas win', async () => {
  const { storage, config } = setup({ TRAFFIC_MAX_ACTIVE_AREAS: '2' });

  // Write explicit timestamps: within a single test the wall clock does not move enough to
  // order these reliably.
  const now = Date.now();
  const ages: Array<[string, number]> = [
    ['Old', now - 30 * 60 * 1000],
    ['Middle', now - 10 * 60 * 1000],
    ['Newest', now],
  ];
  for (const [country, at] of ages) {
    await storage.putState(
      `demand/${VERSION}/${country}`,
      JSON.stringify({ country, mapVersion: VERSION, lastRequestedAt: at }),
    );
  }

  const areas = await activeAreas(storage, config);
  assert.deepEqual(areas.map((a) => a.country), ['Newest', 'Middle']);
});

test('stale areas age out of the refresh list', async () => {
  const { storage, config } = setup();
  await recordDemand(storage, COUNTRY, VERSION, config);

  // Backdate the record past the TTL.
  const key = `demand/${VERSION}/${COUNTRY}`;
  const record = JSON.parse((await storage.getState(key))!);
  record.lastRequestedAt = Date.now() - 2 * 3600 * 1000;
  await storage.putState(key, JSON.stringify(record));

  assert.deepEqual(await activeAreas(storage, config), []);
});

test('configured areas stay pinned even when nobody has asked recently', async () => {
  const { storage, config } = setup({ TRAFFIC_AREAS: `${COUNTRY}@${VERSION}` });
  const areas = await activeAreas(storage, config);
  assert.deepEqual(
    areas.map((a) => `${a.country}@${a.mapVersion}`),
    [`${COUNTRY}@${VERSION}`],
  );
});

test('discovery cannot exceed the active-area ceiling', async () => {
  const { storage, config } = setup({ TRAFFIC_MAX_ACTIVE_AREAS: '2' });
  for (const c of ['A', 'B', 'C', 'D']) await recordDemand(storage, c, VERSION, config);

  const areas = await activeAreas(storage, config);
  assert.equal(areas.length, 2, 'a phone with many maps must not exhaust the provider budget');
});

test('discovery can be turned off, falling back to declared areas only', async () => {
  const { ctx, storage, config } = setup({
    TRAFFIC_AUTO_DISCOVER_AREAS: 'false',
    TRAFFIC_AREAS: `${COUNTRY}@${VERSION}`,
  });
  await handleRequest(get(`/${VERSION}/${encoded}.traffic`), ctx);

  assert.equal((await storage.listState('demand/')).length, 0, 'nothing recorded');
  assert.deepEqual(
    (await activeAreas(storage, config)).map((a) => a.country),
    [COUNTRY],
  );
});

test('a paired device can upload an index the server does not have', async () => {
  const { ctx, storage } = setup();
  const NEXT = 261015;
  const body = new Uint8Array(makeIndex(COUNTRY, NEXT));

  const res = await handleRequest(
    new Request(url('/v1/index'), {
      method: 'POST',
      headers: {
        'x-api-key': 'secret-key',
        'x-traffic-country': COUNTRY,
        'x-traffic-map-version': String(NEXT),
      },
      body,
    }),
    ctx,
  );

  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { status: string }).status, 'stored');
  assert.ok(await storage.readIndex(COUNTRY, NEXT), 'index is now available to the refresh job');
});

test('index upload rejects an unpaired device', async () => {
  const { ctx } = setup();
  const res = await handleRequest(
    new Request(url('/v1/index'), {
      method: 'POST',
      headers: { 'x-traffic-country': COUNTRY, 'x-traffic-map-version': String(VERSION) },
      body: new Uint8Array(makeIndex()),
    }),
    ctx,
  );
  assert.equal(res.status, 401);
});

test('index upload rejects a body whose headers disagree with its contents', async () => {
  const { ctx } = setup();
  const res = await handleRequest(
    new Request(url('/v1/index'), {
      method: 'POST',
      headers: {
        'x-api-key': 'secret-key',
        'x-traffic-country': COUNTRY,
        // The index says 260906; claiming another version would silently break every response.
        'x-traffic-map-version': '999999',
      },
      body: new Uint8Array(makeIndex()),
    }),
    ctx,
  );
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /headers say/);
});

test('index upload rejects a corrupt body rather than storing it', async () => {
  const { ctx, storage } = setup();
  const junk = new Uint8Array(128).fill(0x41);

  const res = await handleRequest(
    new Request(url('/v1/index'), {
      method: 'POST',
      headers: {
        'x-api-key': 'secret-key',
        'x-traffic-country': 'Nowhere',
        'x-traffic-map-version': '260906',
      },
      body: junk,
    }),
    ctx,
  );

  assert.equal(res.status, 400);
  assert.equal(await storage.readIndex('Nowhere', 260906), null);
});
