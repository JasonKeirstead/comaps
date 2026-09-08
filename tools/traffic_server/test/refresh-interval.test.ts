/**
 * The refresh interval as a setting, and the demand-driven refresh it governs.
 *
 * The behaviour worth pinning down: an area is refreshed because a client asked for it, at most
 * once per interval, and never otherwise. Nothing runs on a timer, so a service nobody is using
 * makes no provider calls.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig, REFRESH_CHOICES, type Config } from '../src/core/config.ts';
import { describeChoices, getRefresh, setRefresh } from '../src/core/settings.ts';
import { refreshArea } from '../src/refresh.ts';
import type { GeneratedBlob, Storage } from '../src/storage/types.ts';
import type { TrafficProvider } from '../src/core/providers/types.ts';
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
    this.indexes.set(
      `${v}/${country}`,
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    );
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

function config(overrides: Record<string, string> = {}): Config {
  return loadConfig({ TOMTOM_API_KEY: 'k', TRAFFIC_ALLOW_ANONYMOUS: 'true', ...overrides });
}

function countingProvider(): TrafficProvider & { calls: number } {
  const provider = {
    name: 'counting' as const,
    calls: 0,
    async fetch() {
      provider.calls += 1;
      return [];
    },
  };
  return provider;
}

/** A storage already holding a usable index for COUNTRY@VERSION. */
async function storageWithIndex(): Promise<MemoryStorage> {
  const storage = new MemoryStorage();
  storage.indexes.set(
    `${VERSION}/${COUNTRY}`,
    buildIndex({
      countryName: COUNTRY,
      mwmVersion: VERSION,
      features: [{ fid: 3, numSegs: 2, oneWay: true }],
      segments: [
        { segmentIndex: 0, lat: 53.9, lon: 27.56, bearingDeg: 90 },
        { segmentIndex: 1, lat: 53.91, lon: 27.57, bearingDeg: 90 },
      ],
      bbox: { minLat: 53.8, minLon: 27.4, maxLat: 54.0, maxLon: 27.7 },
    }),
  );
  return storage;
}

test('the default interval is 30 minutes', () => {
  assert.equal(config().refreshSeconds, 1800);
});

test('the choice list is the four documented intervals', () => {
  assert.deepEqual([...REFRESH_CHOICES], [300, 600, 1800, 3600]);
});

test('with nothing set, the interval comes from the environment', async () => {
  const storage = new MemoryStorage();
  const current = await getRefresh(storage, config({ TRAFFIC_REFRESH_SECONDS: '600' }));
  assert.equal(current.seconds, 600);
  assert.equal(current.source, 'environment');
});

test('an override takes precedence and is reported as such', async () => {
  const storage = new MemoryStorage();
  const cfg = config({ TRAFFIC_REFRESH_SECONDS: '1800' });

  assert.equal((await setRefresh(storage, cfg, 3600)).ok, true);

  const current = await getRefresh(storage, cfg);
  assert.equal(current.seconds, 3600);
  assert.equal(current.source, 'override');
});

test('an interval outside the list is rejected', async () => {
  const result = await setRefresh(new MemoryStorage(), config(), 900);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.match(result.errors.join(' '), /one of 300, 600, 1800, 3600/);
  }
});

test('a stored override that is no longer a valid choice falls back instead of wedging', async () => {
  const storage = new MemoryStorage();
  await storage.putState('settings/refreshSeconds', '90');

  const current = await getRefresh(storage, config({ TRAFFIC_REFRESH_SECONDS: '1800' }));
  assert.equal(current.seconds, 1800);
  assert.equal(current.source, 'environment');
});

test('each choice reports what it costs and how many areas the budget covers', () => {
  const options = describeChoices(config({ TRAFFIC_DAILY_REQUEST_BUDGET: '900' }));

  assert.deepEqual(options.map((o) => o.label), ['5 min', '10 min', '30 min', '1h']);
  assert.equal(options.find((o) => o.seconds === 1800)?.perAreaPerDay, 48);
  assert.equal(options.find((o) => o.seconds === 1800)?.areasWithinBudget, 18);
  // Shorter intervals cost more per area, so fewer fit.
  assert.equal(options.find((o) => o.seconds === 300)?.areasWithinBudget, 3);
});

test('the first request for an area refreshes it', async () => {
  const storage = await storageWithIndex();
  const provider = countingProvider();

  const { blob, result } = await refreshArea(config(), storage, COUNTRY, VERSION, provider);
  assert.equal(result.status, 'updated');
  assert.equal(provider.calls, 1);
  assert.ok(blob);
});

test('a second request inside the interval is served from storage, with no provider call', async () => {
  const storage = await storageWithIndex();
  const provider = countingProvider();
  const cfg = config({ TRAFFIC_REFRESH_SECONDS: '1800' });

  await refreshArea(cfg, storage, COUNTRY, VERSION, provider);
  const { blob, result } = await refreshArea(cfg, storage, COUNTRY, VERSION, provider);

  assert.equal(result.status, 'fresh');
  assert.equal(provider.calls, 1, 'the provider must not be called again inside the interval');
  assert.ok(blob);
});

test('once the interval has passed, the next request refreshes', async () => {
  const storage = await storageWithIndex();
  const provider = countingProvider();
  const cfg = config({ TRAFFIC_REFRESH_SECONDS: '300' });

  await refreshArea(cfg, storage, COUNTRY, VERSION, provider);

  // Backdate what we hold by six minutes.
  const held = storage.generated.get(`${VERSION}/${COUNTRY}`)!;
  storage.generated.set(`${VERSION}/${COUNTRY}`, { ...held, generatedAt: Date.now() - 6 * 60 * 1000 });

  const { result } = await refreshArea(cfg, storage, COUNTRY, VERSION, provider);
  assert.equal(result.status, 'updated');
  assert.equal(provider.calls, 2);
});

test('an area nobody asks for is never refreshed', async () => {
  const storage = await storageWithIndex();
  const provider = countingProvider();

  // Simply not calling refreshArea is the whole point: there is no timer that would.
  assert.equal(provider.calls, 0);
  assert.equal(await storage.readGenerated(COUNTRY, VERSION), null);
});

test('a refresh already in progress serves what we have rather than calling the provider again', async () => {
  const storage = await storageWithIndex();
  const provider = countingProvider();
  const cfg = config({ TRAFFIC_REFRESH_SECONDS: '300' });

  await refreshArea(cfg, storage, COUNTRY, VERSION, provider);
  const held = storage.generated.get(`${VERSION}/${COUNTRY}`)!;
  storage.generated.set(`${VERSION}/${COUNTRY}`, { ...held, generatedAt: Date.now() - 6 * 60 * 1000 });

  // Pretend another request got there first.
  await storage.putState(`refreshing/${VERSION}/${COUNTRY}`, '1');

  const { blob, result } = await refreshArea(cfg, storage, COUNTRY, VERSION, provider);
  assert.equal(result.status, 'skipped');
  assert.match(result.detail ?? '', /already in progress/);
  assert.equal(provider.calls, 1);
  assert.ok(blob, 'stale data still beats no data');
});

test('the daily budget stops provider calls but keeps serving', async () => {
  const storage = await storageWithIndex();
  const provider = countingProvider();
  const cfg = config({ TRAFFIC_REFRESH_SECONDS: '300', TRAFFIC_DAILY_REQUEST_BUDGET: '1' });

  await refreshArea(cfg, storage, COUNTRY, VERSION, provider);
  const held = storage.generated.get(`${VERSION}/${COUNTRY}`)!;
  storage.generated.set(`${VERSION}/${COUNTRY}`, { ...held, generatedAt: Date.now() - 6 * 60 * 1000 });

  const { blob, result } = await refreshArea(cfg, storage, COUNTRY, VERSION, provider);
  assert.equal(result.status, 'skipped');
  assert.match(result.detail ?? '', /budget/);
  assert.equal(provider.calls, 1);
  assert.ok(blob);
});

test('a provider failure leaves the previous body in place', async () => {
  const storage = await storageWithIndex();
  const cfg = config({ TRAFFIC_REFRESH_SECONDS: '300' });

  const good = countingProvider();
  await refreshArea(cfg, storage, COUNTRY, VERSION, good);
  const before = storage.generated.get(`${VERSION}/${COUNTRY}`)!;
  storage.generated.set(`${VERSION}/${COUNTRY}`, { ...before, generatedAt: Date.now() - 6 * 60 * 1000 });

  const broken: TrafficProvider = {
    name: 'broken',
    async fetch() {
      throw new Error('TomTom request failed: 401');
    },
  };
  const { blob, result } = await refreshArea(cfg, storage, COUNTRY, VERSION, broken);

  assert.equal(result.status, 'failed');
  assert.ok(blob, 'an outage must degrade to stale data, not to no data');
  assert.deepEqual([...blob.body], [...before.body]);
  // And the in-flight marker was cleared, so the next request can try again.
  assert.equal(await storage.getState(`refreshing/${VERSION}/${COUNTRY}`), null);
});

test('the interval is read per request, so a change takes effect immediately', async () => {
  const storage = await storageWithIndex();
  const provider = countingProvider();
  const cfg = config({ TRAFFIC_REFRESH_SECONDS: '3600' });

  await refreshArea(cfg, storage, COUNTRY, VERSION, provider);
  const held = storage.generated.get(`${VERSION}/${COUNTRY}`)!;
  storage.generated.set(`${VERSION}/${COUNTRY}`, { ...held, generatedAt: Date.now() - 10 * 60 * 1000 });

  // Ten minutes old, but the interval is an hour, so still fresh.
  assert.equal((await refreshArea(cfg, storage, COUNTRY, VERSION, provider)).result.status, 'fresh');

  assert.equal((await setRefresh(storage, cfg, 300)).ok, true);
  assert.equal((await refreshArea(cfg, storage, COUNTRY, VERSION, provider)).result.status, 'updated');
});
