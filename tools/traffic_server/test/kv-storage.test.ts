/**
 * The KV-only backend is what a free Cloudflare account actually runs, so it gets the same
 * exercise the R2 path gets: binary round-trips, metadata survival, version listing, TTLs.
 *
 * FakeKv models the parts of the KV contract we depend on -- notably that `list` pages at 1000
 * keys and that metadata comes back only via `getWithMetadata`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { KvStorage } from '../src/storage/kv.ts';

const PAGE_SIZE = 1000;

class FakeKv {
  entries = new Map<string, { value: ArrayBuffer | string; metadata?: unknown; expiresAt: number | null }>();

  async get(key: string, type: 'text' | 'arrayBuffer') {
    const entry = this.live(key);
    if (!entry) return null;
    if (type === 'text') return typeof entry.value === 'string' ? entry.value : null;
    return typeof entry.value === 'string' ? null : entry.value;
  }

  async getWithMetadata(key: string, opts: { type: 'arrayBuffer' }) {
    const entry = this.live(key);
    if (!entry) return { value: null, metadata: null };
    void opts;
    return { value: entry.value as ArrayBuffer, metadata: entry.metadata ?? null };
  }

  async put(key: string, value: ArrayBuffer | string, opts?: { metadata?: unknown; expirationTtl?: number }) {
    if (opts?.expirationTtl !== undefined && opts.expirationTtl < 60) {
      throw new Error(`KV rejects expirationTtl below 60, got ${opts.expirationTtl}`);
    }
    this.entries.set(key, {
      value,
      metadata: opts?.metadata,
      expiresAt: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null,
    });
  }

  async delete(key: string) {
    this.entries.delete(key);
  }

  async list(opts: { prefix: string; cursor?: string }) {
    const all = [...this.entries.keys()].filter((k) => k.startsWith(opts.prefix)).sort();
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const page = all.slice(start, start + PAGE_SIZE);
    const end = start + page.length;
    return {
      keys: page.map((name) => ({ name })),
      list_complete: end >= all.length,
      cursor: String(end),
    };
  }

  private live(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }
}

function makeStorage() {
  const kv = new FakeKv();
  return { kv, storage: new KvStorage({ KV_STATE: kv as unknown as KVNamespace }) };
}

const COUNTRY = 'Belarus_Minsk Region';

test('index round-trips through KV byte for byte', async () => {
  const { storage } = makeStorage();
  const body = new Uint8Array([0, 1, 2, 253, 254, 255]);

  assert.equal(await storage.readIndex(COUNTRY, 260906), null);
  await storage.writeIndex(COUNTRY, 260906, body);

  const read = await storage.readIndex(COUNTRY, 260906);
  assert.ok(read);
  assert.deepEqual([...new Uint8Array(read)], [...body]);
});

test('writeIndex stores a view without dragging in the rest of its buffer', async () => {
  const { storage } = makeStorage();
  // A Uint8Array over part of a larger buffer is what parsing code hands us; storing the whole
  // backing buffer would silently corrupt the index.
  const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
  const view = backing.subarray(2, 5);

  await storage.writeIndex(COUNTRY, 1, view);

  const read = await storage.readIndex(COUNTRY, 1);
  assert.ok(read);
  assert.deepEqual([...new Uint8Array(read)], [1, 2, 3]);
});

test('generated body keeps its etag and counters across a round-trip', async () => {
  const { storage } = makeStorage();
  const blob = {
    body: new Uint8Array([1, 2, 3, 4]),
    etag: '"abc123"',
    generatedAt: 1_700_000_000_000,
    coloredSegments: 20057,
  };

  await storage.writeGenerated(COUNTRY, 260906, blob);
  const read = await storage.readGenerated(COUNTRY, 260906);

  assert.ok(read);
  assert.deepEqual([...read.body], [...blob.body]);
  assert.equal(read.etag, blob.etag);
  assert.equal(read.generatedAt, blob.generatedAt);
  assert.equal(read.coloredSegments, blob.coloredSegments);
});

test('a generated body with no metadata yields an etag that cannot match', async () => {
  const { kv, storage } = makeStorage();
  await kv.put('generated/260906/Belarus_Minsk Region.traffic', new Uint8Array([1]).buffer as ArrayBuffer);

  const read = await storage.readGenerated(COUNTRY, 260906);
  assert.ok(read);
  // Serving a real-looking etag here would make a stale client cache look fresh forever.
  assert.equal(read.etag, '"unknown"');
  assert.equal(read.generatedAt, 0);
});

test('indexVersions lists newest first and ignores other countries', async () => {
  const { storage } = makeStorage();
  const body = new Uint8Array([1]);
  await storage.writeIndex(COUNTRY, 250628, body);
  await storage.writeIndex(COUNTRY, 260906, body);
  await storage.writeIndex('Poland_Lesser Poland', 260906, body);

  assert.deepEqual(await storage.indexVersions(COUNTRY), [260906, 250628]);
  assert.deepEqual(await storage.indexVersions('Poland_Lesser Poland'), [260906]);
  assert.deepEqual(await storage.indexVersions('France_Paris'), []);
});

test('indexVersions does not confuse a country with one whose name it ends with', async () => {
  const { storage } = makeStorage();
  await storage.writeIndex('Sudan', 100, new Uint8Array([1]));
  await storage.writeIndex('South Sudan', 200, new Uint8Array([1]));

  assert.deepEqual(await storage.indexVersions('Sudan'), [100]);
  assert.deepEqual(await storage.indexVersions('South Sudan'), [200]);
});

test('listState follows the cursor past a single KV page', async () => {
  const { storage } = makeStorage();
  const total = PAGE_SIZE + 7;
  for (let i = 0; i < total; i += 1) {
    await storage.putState(`demand/${String(i).padStart(5, '0')}`, 'x');
  }

  const listed = await storage.listState('demand/');
  assert.equal(listed.length, total);
});

test('state TTLs are raised to the 60s KV floor rather than rejected', async () => {
  const { kv, storage } = makeStorage();
  // Pairing tokens are short-lived; a sub-60s TTL must not throw.
  await storage.putState('pairing/abc', 'token', 5);

  assert.equal(await storage.getState('pairing/abc'), 'token');
  assert.equal(kv.entries.get('pairing/abc')?.expiresAt !== null, true);
});

test('state without a TTL persists, and delete removes it', async () => {
  const { storage } = makeStorage();
  await storage.putState('device/1', 'hash');
  assert.equal(await storage.getState('device/1'), 'hash');

  await storage.deleteState('device/1');
  assert.equal(await storage.getState('device/1'), null);
});
