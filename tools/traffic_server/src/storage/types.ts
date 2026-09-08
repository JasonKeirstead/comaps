/** Storage seam: local disk in the container, R2 + KV on Cloudflare. */

export interface GeneratedBlob {
  body: Uint8Array;
  etag: string;
  generatedAt: number;
  coloredSegments: number;
}

export interface Storage {
  /** The offline .cmti artifact for an area, or null if it was never uploaded. */
  readIndex(country: string, mapVersion: number): Promise<ArrayBuffer | null>;

  /** Map versions we hold an index for, for a given country, newest first. */
  indexVersions(country: string): Promise<number[]>;

  /** The most recent generated `.traffic` body for an area. */
  readGenerated(country: string, mapVersion: number): Promise<GeneratedBlob | null>;
  writeGenerated(country: string, mapVersion: number, blob: GeneratedBlob): Promise<void>;

  /** Small mutable state: pairing tokens, device key hashes, quota counters. */
  getState(key: string): Promise<string | null>;
  putState(key: string, value: string, ttlSeconds?: number): Promise<void>;
  deleteState(key: string): Promise<void>;
  listState(prefix: string): Promise<string[]>;
}

export const indexKey = (country: string, mapVersion: number) => `index/${mapVersion}/${country}.cmti`;
export const generatedKey = (country: string, mapVersion: number) => `generated/${mapVersion}/${country}.traffic`;
