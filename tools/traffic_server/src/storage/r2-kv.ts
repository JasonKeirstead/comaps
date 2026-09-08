/** Cloudflare storage: R2 for the index and generated bodies, KV for small mutable state. */

import { generatedKey, indexKey, type GeneratedBlob, type Storage } from './types.ts';

export interface CloudflareBindings {
  R2_INDEX: R2Bucket;
  KV_STATE: KVNamespace;
}

export class R2KvStorage implements Storage {
  private readonly bucket: R2Bucket;
  private readonly kv: KVNamespace;

  constructor(bindings: CloudflareBindings) {
    this.bucket = bindings.R2_INDEX;
    this.kv = bindings.KV_STATE;
  }

  async readIndex(country: string, mapVersion: number): Promise<ArrayBuffer | null> {
    const object = await this.bucket.get(indexKey(country, mapVersion));
    return object ? await object.arrayBuffer() : null;
  }

  async writeIndex(country: string, mapVersion: number, body: Uint8Array): Promise<void> {
    await this.bucket.put(indexKey(country, mapVersion), body as unknown as ArrayBuffer);
  }

  async indexVersions(country: string): Promise<number[]> {
    const listed = await this.bucket.list({ prefix: 'index/' });
    const suffix = `/${country}.cmti`;
    const out: number[] = [];
    for (const object of listed.objects) {
      if (!object.key.endsWith(suffix)) continue;
      const version = Number(object.key.slice('index/'.length, object.key.length - suffix.length));
      if (Number.isInteger(version)) out.push(version);
    }
    return out.sort((a, b) => b - a);
  }

  async readGenerated(country: string, mapVersion: number): Promise<GeneratedBlob | null> {
    const object = await this.bucket.get(generatedKey(country, mapVersion));
    if (!object) return null;
    const meta = object.customMetadata ?? {};
    return {
      body: new Uint8Array(await object.arrayBuffer()),
      // Fall back to R2's own etag only if ours is missing; ours is derived from the
      // uncompressed payload and is stable across runtimes.
      etag: meta.trafficEtag ?? `"${object.etag}"`,
      generatedAt: Number(meta.generatedAt ?? 0),
      coloredSegments: Number(meta.coloredSegments ?? 0),
    };
  }

  async writeGenerated(country: string, mapVersion: number, blob: GeneratedBlob): Promise<void> {
    await this.bucket.put(generatedKey(country, mapVersion), blob.body as unknown as ArrayBuffer, {
      customMetadata: {
        trafficEtag: blob.etag,
        generatedAt: String(blob.generatedAt),
        coloredSegments: String(blob.coloredSegments),
      },
    });
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
    const listed = await this.kv.list({ prefix });
    return listed.keys.map((k) => k.name);
  }
}
