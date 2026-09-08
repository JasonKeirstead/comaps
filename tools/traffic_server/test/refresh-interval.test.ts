/**
 * The refresh interval as a setting: chosen from a fixed list, changeable at runtime, and
 * actually honoured by the refresh job.
 *
 * The last part is the one worth guarding. Before this, the Cloudflare cron *was* the interval,
 * so TRAFFIC_REFRESH_SECONDS only affected validation and /healthz -- changing it looked like it
 * worked and changed nothing about how often the provider was called.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig, REFRESH_CHOICES, type Config } from '../src/core/config.ts';
import { affordableChoices, getRefresh, setRefresh } from '../src/core/settings.ts';
import { refreshAll } from '../src/refresh.ts';
import type { GeneratedBlob, Storage } from '../src/storage/types.ts';
import type { TrafficProvider } from '../src/core/providers/types.ts';

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

/** Counts provider calls; the index is never read because no area is ever configured as present. */
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

  const result = await setRefresh(storage, cfg, 3600);
  assert.equal(result.ok, true);

  const current = await getRefresh(storage, cfg);
  assert.equal(current.seconds, 3600);
  assert.equal(current.source, 'override');
});

test('an interval outside the list is rejected', async () => {
  const storage = new MemoryStorage();
  const result = await setRefresh(storage, config(), 900);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.match(result.errors.join(' '), /one of 300, 600, 1800, 3600/);
  }
});

test('an interval the budget cannot pay for is rejected, not silently accepted', async () => {
  const storage = new MemoryStorage();
  // 8 areas every 5 minutes is 2,592 KV writes/day against a free plan's 1,000.
  const cfg = config({
    TRAFFIC_MAX_ACTIVE_AREAS: '8',
    TRAFFIC_DAILY_WRITE_BUDGET: '1000',
    TRAFFIC_DAILY_REQUEST_BUDGET: '100000',
  });

  const result = await setRefresh(storage, cfg, 300);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 409);
    assert.match(result.errors.join(' '), /storage writes\/day/);
  }
  // And nothing was stored, so the service keeps running at the interval it had.
  assert.equal((await getRefresh(storage, cfg)).source, 'environment');
});

test('a stored override that is no longer a valid choice falls back instead of wedging', async () => {
  const storage = new MemoryStorage();
  await storage.putState('settings/refreshSeconds', '90');

  const current = await getRefresh(storage, config({ TRAFFIC_REFRESH_SECONDS: '1800' }));
  assert.equal(current.seconds, 1800);
  assert.equal(current.source, 'environment');
});

test('affordableChoices marks the ones this deployment cannot pay for', () => {
  const cfg = config({
    TRAFFIC_MAX_ACTIVE_AREAS: '8',
    TRAFFIC_DAILY_WRITE_BUDGET: '1000',
    TRAFFIC_DAILY_REQUEST_BUDGET: '2000',
  });
  const options = affordableChoices(cfg);

  assert.deepEqual(options.map((o) => o.label), ['5 min', '10 min', '30 min', '1h']);
  assert.equal(options.find((o) => o.seconds === 300)?.affordable, false);
  assert.equal(options.find((o) => o.seconds === 1800)?.affordable, true);
  assert.ok(options.find((o) => o.seconds === 300)?.why);
});

test('refreshAll does nothing until the chosen interval has elapsed', async () => {
  const storage = new MemoryStorage();
  const cfg = config({ TRAFFIC_AREAS: 'A@1', TRAFFIC_REFRESH_SECONDS: '1800' });
  const provider = countingProvider();

  // First call: nothing has run, so it is due. The area has no index, so it fails -- but the
  // point is that it got as far as trying.
  const first = await refreshAll(cfg, storage, provider);
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'failed');

  // Second call moments later: not due, so no areas are even considered.
  const second = await refreshAll(cfg, storage, provider);
  assert.deepEqual(second, []);
});

test('a tick that is not due costs one read and touches nothing else', async () => {
  const storage = new MemoryStorage();
  const cfg = config({ TRAFFIC_AREAS: 'A@1' });

  await refreshAll(cfg, storage, countingProvider());
  const stateAfterFirst = new Map(storage.state);

  await refreshAll(cfg, storage, countingProvider());
  // No new keys, and no value changed: an idle tick must not spend write quota.
  assert.deepEqual([...storage.state.entries()], [...stateAfterFirst.entries()]);
});

test('the interval is re-read each tick, so a change takes effect without a restart', async () => {
  const storage = new MemoryStorage();
  const cfg = config({ TRAFFIC_AREAS: 'A@1', TRAFFIC_REFRESH_SECONDS: '3600' });

  await refreshAll(cfg, storage, countingProvider());
  assert.deepEqual(await refreshAll(cfg, storage, countingProvider()), []);

  // Backdate the last run by ten minutes, then shorten the interval to five.
  storage.state.set('refresh/lastAt', String(Date.now() - 10 * 60 * 1000));
  assert.deepEqual(await refreshAll(cfg, storage, countingProvider()), []);

  const set = await setRefresh(storage, cfg, 300);
  assert.equal(set.ok, true);

  const after = await refreshAll(cfg, storage, countingProvider());
  assert.equal(after.length, 1);
});
