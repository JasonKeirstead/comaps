/**
 * KV-only Cloudflare storage, for accounts that have not enabled R2.
 *
 * R2 has a free tier but is gated behind a subscription step that asks for a card, so a plain
 * free Workers account cannot provision the bucket the Deploy button asks for. KV is included in
 * the free plan outright, and the objects here are small enough to live in it: a whole-region
 * index is ~400 KB and a generated `.traffic` body is a few KB, against KV's 25 MiB value limit.
 *
 * The cost is write quota rather than size. The free plan allows 1,000 KV writes/day and the
 * refresh job writes one value per area per tick, so the practical ceiling is roughly
 * 86400 / TRAFFIC_REFRESH_SECONDS x areas < 1000. R2Storage lifts that if you enable R2 later.
 */

import { generatedKey, indexKey, type GeneratedBlob, type Storage } from './types.ts';

export interface KvBindings {
  KV_STATE: KVNamespace;
}

/** Metadata ridden along with a generated body. KV caps this at 1024 bytes; ours is ~100. */
interface GeneratedMeta {
  etag: string;
  generatedAt: number;
  coloredSegments: number;
}

export class KvStorage implements Storage {
  protected readonly kv: KVNamespace;

  constructor(bindings: KvBindings) {
    this.kv = bindings.KV_STATE;
  }

  async readIndex(country: string, mapVersion: number): Promise<ArrayBuffer | null> {
    return await this.kv.get(indexKey(country, mapVersion), 'arrayBuffer');
  }

  async writeIndex(country: string, mapVersion: number, body: Uint8Array): Promise<void> {
    await this.kv.put(indexKey(country, mapVersion), body as unknown as ArrayBuffer);
  }

  async indexVersions(country: string): Promise<number[]> {
    const suffix = `/${country}.cmti`;
    const out: number[] = [];
    for (const name of await this.listAll('index/')) {
      if (!name.endsWith(suffix)) continue;
      const version = Number(name.slice('index/'.length, name.length - suffix.length));
      if (Number.isInteger(version)) out.push(version);
    }
    return out.sort((a, b) => b - a);
  }

  async readGenerated(country: string, mapVersion: number): Promise<GeneratedBlob | null> {
    const { value, metadata } = await this.kv.getWithMetadata<GeneratedMeta>(
      generatedKey(country, mapVersion),
      { type: 'arrayBuffer' },
    );
    if (!value) return null;
    return {
      body: new Uint8Array(value),
      // Without metadata we cannot honour a conditional request, so fall back to an etag that
      // never matches rather than one that wrongly does.
      etag: metadata?.etag ?? '"unknown"',
      generatedAt: Number(metadata?.generatedAt ?? 0),
      coloredSegments: Number(metadata?.coloredSegments ?? 0),
    };
  }

  async writeGenerated(country: string, mapVersion: number, blob: GeneratedBlob): Promise<void> {
    const metadata: GeneratedMeta = {
      etag: blob.etag,
      generatedAt: blob.generatedAt,
      coloredSegments: blob.coloredSegments,
    };
    await this.kv.put(generatedKey(country, mapVersion), blob.body as unknown as ArrayBuffer, { metadata });
  }

  async getState(key: string): Promise<string | null> {
    return await this.kv.get(key, 'text');
  }

  async putState(key: string, value: string, ttlSeconds?: number): Promise<void> {
    // KV rejects TTLs below 60 seconds.
    const expirationTtl = ttlSeconds ? Math.max(60, Math.ceil(ttlSeconds)) : undefined;
    await this.kv.put(key, value, expirationTtl ? { expirationTtl } : undefined);
  }

  async deleteState(key: string): Promise<void> {
    await this.kv.delete(key);
  }

  async listState(prefix: string): Promise<string[]> {
    return await this.listAll(prefix);
  }

  /** KV returns at most 1000 keys per call; follow the cursor so nothing is silently dropped. */
  private async listAll(prefix: string): Promise<string[]> {
    const names: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.kv.list({ prefix, cursor });
      for (const key of page.keys) names.push(key.name);
      if (page.list_complete) return names;
      cursor = page.cursor;
    }
  }
}
