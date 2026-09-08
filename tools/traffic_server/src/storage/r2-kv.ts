/**
 * Cloudflare storage using R2 for the index and generated bodies, KV for small mutable state.
 *
 * Optional. R2 needs a subscription step that a free Workers account has not been through, so
 * the default deployment is KV-only (see kv.ts) and this takes over automatically once an
 * R2_INDEX binding exists. Worth adding if you outgrow the free plan's 1,000 KV writes/day,
 * since R2 charges nothing for the volume of writes this service makes.
 */

import { KvStorage, type KvBindings } from './kv.ts';
import { generatedKey, indexKey, type GeneratedBlob } from './types.ts';

export interface CloudflareBindings extends KvBindings {
  R2_INDEX: R2Bucket;
}

export class R2KvStorage extends KvStorage {
  private readonly bucket: R2Bucket;

  constructor(bindings: CloudflareBindings) {
    super(bindings);
    this.bucket = bindings.R2_INDEX;
  }

  override async readIndex(country: string, mapVersion: number): Promise<ArrayBuffer | null> {
    const object = await this.bucket.get(indexKey(country, mapVersion));
    return object ? await object.arrayBuffer() : null;
  }

  override async writeIndex(country: string, mapVersion: number, body: Uint8Array): Promise<void> {
    await this.bucket.put(indexKey(country, mapVersion), body as unknown as ArrayBuffer);
  }

  override async indexVersions(country: string): Promise<number[]> {
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

  override async readGenerated(country: string, mapVersion: number): Promise<GeneratedBlob | null> {
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

  override async writeGenerated(country: string, mapVersion: number, blob: GeneratedBlob): Promise<void> {
    await this.bucket.put(generatedKey(country, mapVersion), blob.body as unknown as ArrayBuffer, {
      customMetadata: {
        trafficEtag: blob.etag,
        generatedAt: String(blob.generatedAt),
        coloredSegments: String(blob.coloredSegments),
      },
    });
  }
}
