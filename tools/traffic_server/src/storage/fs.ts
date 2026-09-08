/** Filesystem storage for the self-hosted container. */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GeneratedBlob, Storage } from './types.ts';

interface StateEntry {
  value: string;
  expiresAt: number | null;
}

export class FsStorage implements Storage {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private path(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  private async readJson<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  }

  async readIndex(country: string, mapVersion: number): Promise<ArrayBuffer | null> {
    try {
      const buf = await readFile(this.path('index', String(mapVersion), `${country}.cmti`));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async writeIndex(country: string, mapVersion: number, body: Uint8Array): Promise<void> {
    const dir = this.path('index', String(mapVersion));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${country}.cmti`), body);
  }

  async indexVersions(country: string): Promise<number[]> {
    let versions: string[];
    try {
      versions = await readdir(this.path('index'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const out: number[] = [];
    for (const v of versions) {
      const n = Number(v);
      if (!Number.isInteger(n)) continue;
      const files = await readdir(this.path('index', v)).catch(() => [] as string[]);
      if (files.includes(`${country}.cmti`)) out.push(n);
    }
    return out.sort((a, b) => b - a);
  }

  async readGenerated(country: string, mapVersion: number): Promise<GeneratedBlob | null> {
    const meta = await this.readJson<Omit<GeneratedBlob, 'body'>>(
      this.path('generated', String(mapVersion), `${country}.json`),
    );
    if (!meta) return null;
    try {
      const body = await readFile(this.path('generated', String(mapVersion), `${country}.traffic`));
      return { ...meta, body: new Uint8Array(body) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async writeGenerated(country: string, mapVersion: number, blob: GeneratedBlob): Promise<void> {
    const dir = this.path('generated', String(mapVersion));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${country}.traffic`), blob.body);
    await this.writeJson(join(dir, `${country}.json`), {
      etag: blob.etag,
      generatedAt: blob.generatedAt,
      coloredSegments: blob.coloredSegments,
    });
  }

  async getState(key: string): Promise<string | null> {
    const entry = await this.readJson<StateEntry>(this.path('state', `${encodeURIComponent(key)}.json`));
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      await this.deleteState(key);
      return null;
    }
    return entry.value;
  }

  async putState(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const entry: StateEntry = {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    };
    await this.writeJson(this.path('state', `${encodeURIComponent(key)}.json`), entry);
  }

  async deleteState(key: string): Promise<void> {
    await rm(this.path('state', `${encodeURIComponent(key)}.json`), { force: true });
  }

  async listState(prefix: string): Promise<string[]> {
    const files = await readdir(this.path('state')).catch(() => [] as string[]);
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => decodeURIComponent(f.slice(0, -'.json'.length)))
      .filter((k) => k.startsWith(prefix));
  }
}
