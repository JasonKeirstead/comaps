import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig, parseAreas, validateConfig } from '../src/core/config.ts';
import { handleRequest, parseTrafficPath } from '../src/http/router.ts';
import { generateTraffic } from '../src/core/pipeline.ts';
import { parseTrafficIndex } from '../src/core/index/format.ts';
import { SpeedGroup } from '../src/core/speed-groups.ts';
import type { GeneratedBlob, Storage } from '../src/storage/types.ts';
import { buildIndex } from './helpers/build-index.ts';

const COUNTRY = 'Belarus_Minsk Region';
const VERSION = 250628;

class MemoryStorage implements Storage {
  indexes = new Map<string, ArrayBuffer>();
  generated = new Map<string, GeneratedBlob>();
  state = new Map<string, string>();

  async readIndex(country: string, v: number) {
    return this.indexes.get(`${v}/${country}`) ?? null;
  }
  async writeIndex(country: string, v: number, body: Uint8Array) {
    this.indexes.set(`${v}/${country}`, body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer);
  }
  async indexVersions(country: string) {
    return [...this.indexes.keys()]
      .filter((k) => k.endsWith(`/${country}`))
      .map((k) => Number(k.split('/')[0]))
      .sort((a, b) => b - a);
  }
  async readGenerated(country: string, v: number) {
    return this.generated.get(`${v}/${country}`) ?? null;
  }
  async writeGenerated(country: string, v: number, blob: GeneratedBlob) {
    this.generated.set(`${v}/${country}`, blob);
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

function setup() {
  const buf = buildIndex({
    countryName: COUNTRY,
    mwmVersion: VERSION,
    features: [{ fid: 3, numSegs: 2, oneWay: true }],
    segments: [
      { segmentIndex: 0, lat: 53.9, lon: 27.56, bearingDeg: 90 },
      { segmentIndex: 1, lat: 53.91, lon: 27.57, bearingDeg: 90 },
    ],
    bbox: { minLat: 53.8, minLon: 27.4, maxLat: 54.0, maxLon: 27.7 },
  });

  const storage = new MemoryStorage();
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
    TRAFFIC_AREAS: `${COUNTRY}@${VERSION}`,
    TRAFFIC_API_KEY: 'secret-key',
    TRAFFIC_ADMIN_TOKEN: 'admin-token',
    TRAFFIC_PUBLIC_BASE_URL: 'http://192.168.1.50:8080/',
  });

  return { storage, config, ctx: { storage, config } };
}

// The client percent-encodes the country name with url::UrlEncode, which escapes everything
// outside [A-Za-z0-9-._~] -- including the space in "Minsk Region".
const url = (path: string) => `http://server${path}`;
const encoded = encodeURIComponent(COUNTRY);
const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(url(path), { headers: { 'x-api-key': 'secret-key', ...headers } });

test('parses the path shapes the client actually builds', () => {
  assert.deepEqual(parseTrafficPath(`/traffic/250628/${encoded}.traffic`), {
    country: COUNTRY,
    mapVersion: 250628,
    wantsKeys: false,
  });
  assert.deepEqual(parseTrafficPath(`/traffic/250628/${encoded}.traffic.keys`), {
    country: COUNTRY,
    mapVersion: 250628,
    wantsKeys: true,
  });
  // MakeRemoteURL omits the version segment when the MWM version is 0.
  assert.deepEqual(parseTrafficPath(`/${encoded}.traffic`), {
    country: COUNTRY,
    mapVersion: null,
    wantsKeys: false,
  });
  // Mounted under an arbitrary prefix.
  assert.equal(parseTrafficPath(`/a/b/c/250628/${encoded}.traffic`)?.mapVersion, 250628);
  assert.equal(parseTrafficPath('/healthz'), null);
});

test('serves values with an ETag, and 304s when it is echoed back', async () => {
  const { ctx } = setup();

  const first = await handleRequest(get(`/traffic/${VERSION}/${encoded}.traffic`), ctx);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.ok(etag, 'an ETag is mandatory on every 200; without it the client never updates its tag');
  assert.ok((await first.arrayBuffer()).byteLength > 0);

  const second = await handleRequest(
    get(`/traffic/${VERSION}/${encoded}.traffic`, { 'if-none-match': etag! }),
    ctx,
  );
  assert.equal(second.status, 304);
  assert.equal(second.headers.get('etag'), etag);
});

test('an empty If-None-Match, which the client sends first, still gets a body', async () => {
  const { ctx } = setup();
  const res = await handleRequest(get(`/traffic/${VERSION}/${encoded}.traffic`, { 'if-none-match': '' }), ctx);
  assert.equal(res.status, 200);
});

test('serves the keys blob verbatim', async () => {
  const { ctx, storage } = setup();
  const res = await handleRequest(get(`/traffic/${VERSION}/${encoded}.traffic.keys`), ctx);
  assert.equal(res.status, 200);

  const index = parseTrafficIndex(storage.indexes.get(`${VERSION}/${COUNTRY}`)!);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), index.keysBlob);
});

test('a 404 body is a bare integer -- anything else aborts debug builds', async () => {
  const { ctx } = setup();
  for (const path of [
    `/traffic/${VERSION}/Nowhere_Land.traffic`,
    `/traffic/999999/${encoded}.traffic`,
    `/traffic/${VERSION}/Nowhere_Land.traffic.keys`,
  ]) {
    const res = await handleRequest(get(path), ctx);
    assert.equal(res.status, 404, path);
    const body = await res.text();
    // TrafficInfo::ProcessFailure runs this through VERIFY(strings::to_int64(...)), which
    // rejects trailing whitespace and any non-digit.
    assert.match(body, /^\d+$/, `404 body must be a bare integer, got ${JSON.stringify(body)}`);
  }
});

test('a 404 for a known country reports the newest version we hold', async () => {
  const { ctx } = setup();
  const res = await handleRequest(get(`/traffic/240101/${encoded}.traffic`), ctx);
  assert.equal(res.status, 404);
  assert.equal(await res.text(), String(VERSION));
});

test('requests without a valid key are rejected, on keys as well as values', async () => {
  const { ctx } = setup();
  for (const path of [`/traffic/${VERSION}/${encoded}.traffic`, `/traffic/${VERSION}/${encoded}.traffic.keys`]) {
    assert.equal((await handleRequest(new Request(url(path)), ctx)).status, 401, path);
    assert.equal(
      (await handleRequest(new Request(url(path), { headers: { 'x-api-key': 'wrong' } }), ctx)).status,
      401,
      path,
    );
  }
});

test('anonymous mode serves without a key', async () => {
  const { storage, config } = setup();
  const ctx = { storage, config: { ...config, allowAnonymous: true } };
  const res = await handleRequest(new Request(url(`/traffic/${VERSION}/${encoded}.traffic`)), ctx);
  assert.equal(res.status, 200);
});

test('pairing hands out a key that then authorises requests', async () => {
  const { ctx } = setup();

  const minted = await handleRequest(
    new Request(url('/admin/pairing-token'), {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token' },
    }),
    ctx,
  );
  assert.equal(minted.status, 200);
  const { token, uri } = (await minted.json()) as { token: string; uri: string };
  assert.match(uri, /^comaps:\/\/traffic\/pair\?/);
  assert.ok(uri.includes(encodeURIComponent('http://192.168.1.50:8080/')));

  const paired = await handleRequest(
    new Request(url('/v1/pair'), { method: 'POST', body: JSON.stringify({ token, device: 'Pixel' }) }),
    ctx,
  );
  assert.equal(paired.status, 200);
  const { apiKey, baseUrl } = (await paired.json()) as { apiKey: string; baseUrl: string };
  assert.equal(baseUrl, 'http://192.168.1.50:8080/');

  const res = await handleRequest(
    new Request(url(`/traffic/${VERSION}/${encoded}.traffic`), { headers: { 'x-api-key': apiKey } }),
    ctx,
  );
  assert.equal(res.status, 200);

  // Single use: the same token must not mint a second key.
  const replay = await handleRequest(
    new Request(url('/v1/pair'), { method: 'POST', body: JSON.stringify({ token, device: 'Attacker' }) }),
    ctx,
  );
  assert.equal(replay.status, 410);
});

test('admin endpoints require the admin token', async () => {
  const { ctx } = setup();
  const res = await handleRequest(new Request(url('/admin/pairing-token'), { method: 'POST' }), ctx);
  assert.equal(res.status, 401);
});

test('healthz reports per-area freshness', async () => {
  const { ctx } = setup();
  const res = await handleRequest(new Request(url('/healthz')), ctx);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; areas: { country: string; hasIndex: boolean }[] };
  assert.equal(body.status, 'ok');
  assert.equal(body.areas[0].country, COUNTRY);
  assert.equal(body.areas[0].hasIndex, true);
});

test('config parsing and budget validation', () => {
  assert.deepEqual(parseAreas('Germany_Berlin@250628, Belarus_Minsk Region@250628'), [
    { country: 'Germany_Berlin', mapVersion: 250628 },
    { country: 'Belarus_Minsk Region', mapVersion: 250628 },
  ]);
  assert.throws(() => parseAreas('NoVersion'), /Country@version/);

  // 8 areas every 5 minutes is 2304 provider requests/day, over a 2000 budget.
  const tight = loadConfig({
    TOMTOM_API_KEY: 'k',
    TRAFFIC_ALLOW_ANONYMOUS: 'true',
    TRAFFIC_REFRESH_SECONDS: '300',
    TRAFFIC_AREAS: 'A@1,B@1,C@1,D@1,E@1,F@1,G@1,H@1',
  });
  assert.match(validateConfig(tight).join('\n'), /over the 2000 budget/);

  // An interval outside the choice list is refused: the cron ticks at the shortest choice, so
  // an arbitrary number would just be rounded up to a tick boundary without saying so.
  const odd = loadConfig({
    TOMTOM_API_KEY: 'k',
    TRAFFIC_ALLOW_ANONYMOUS: 'true',
    TRAFFIC_REFRESH_SECONDS: '90',
  });
  assert.match(validateConfig(odd).join('\n'), /must be one of 300, 600, 1800, 3600/);
});
