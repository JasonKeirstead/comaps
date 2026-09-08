/**
 * Builds a CMTI index in memory, so tests can exercise the runtime without an MWM or the C++
 * generator. Mirrors what generator/traffic_index_generator.cpp writes.
 */

import { CMTI_FORMAT_VERSION, HEADER_BYTES, SEGMENT_RECORD_BYTES } from '../../src/core/index/format.ts';
import { countSegments, serializeKeys, type KeyFeature } from '../../src/core/wire/keys.ts';

export interface SegmentSpec {
  /** Index into the expanded key list. */
  segmentIndex: number;
  lat: number;
  lon: number;
  bearingDeg: number;
  roadClass?: number;
}

export interface BuildIndexOptions {
  countryName: string;
  mwmVersion: number;
  features: KeyFeature[];
  segments: SegmentSpec[];
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  gridCols?: number;
  gridRows?: number;
}

const align4 = (n: number) => (n + 3) & ~3;
const e7 = (v: number) => Math.round(v * 1e7);

export function buildIndex(options: BuildIndexOptions): ArrayBuffer {
  const { countryName, mwmVersion, features, bbox } = options;
  const gridCols = options.gridCols ?? 8;
  const gridRows = options.gridRows ?? 8;

  const keysBlob = serializeKeys(features);
  const expected = countSegments(features);
  if (options.segments.length !== expected) {
    throw new Error(`index needs ${expected} segment records, got ${options.segments.length}`);
  }

  // Bucket segments by cell, then lay them out in cell order with a CSR offset array.
  const latStep = (bbox.maxLat - bbox.minLat) / gridRows;
  const lonStep = (bbox.maxLon - bbox.minLon) / gridCols;
  const buckets: SegmentSpec[][] = Array.from({ length: gridCols * gridRows }, () => []);
  for (const s of options.segments) {
    const col = Math.min(gridCols - 1, Math.max(0, Math.floor((s.lon - bbox.minLon) / lonStep)));
    const row = Math.min(gridRows - 1, Math.max(0, Math.floor((s.lat - bbox.minLat) / latStep)));
    buckets[row * gridCols + col].push(s);
  }

  const nameBytes = new TextEncoder().encode(countryName);
  const numCells = gridCols * gridRows;

  let off = HEADER_BYTES;
  const nameOffset = off;
  off = align4(off + nameBytes.length);
  const keysOffset = off;
  off = align4(off + keysBlob.length);
  const cellOffsetsOffset = off;
  off += (numCells + 1) * 4;
  const segmentsOffset = off;
  off += options.segments.length * SEGMENT_RECORD_BYTES;

  const buf = new ArrayBuffer(off);
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);

  bytes.set(new TextEncoder().encode('CMTI'), 0);
  dv.setUint16(4, CMTI_FORMAT_VERSION, true);
  dv.setUint16(6, 0, true);
  dv.setBigUint64(8, BigInt(mwmVersion), true);
  dv.setInt32(16, e7(bbox.minLat), true);
  dv.setInt32(20, e7(bbox.minLon), true);
  dv.setInt32(24, e7(bbox.maxLat), true);
  dv.setInt32(28, e7(bbox.maxLon), true);
  dv.setUint32(32, gridCols, true);
  dv.setUint32(36, gridRows, true);
  dv.setUint32(40, options.segments.length, true);
  dv.setUint32(44, nameBytes.length, true);
  dv.setUint32(48, keysBlob.length, true);
  dv.setUint32(52, 0, true);

  bytes.set(nameBytes, nameOffset);
  bytes.set(keysBlob, keysOffset);

  let cursor = 0;
  for (let cell = 0; cell < numCells; cell++) {
    dv.setUint32(cellOffsetsOffset + cell * 4, cursor, true);
    for (const s of buckets[cell]) {
      const o = segmentsOffset + cursor * SEGMENT_RECORD_BYTES;
      dv.setUint32(o, s.segmentIndex, true);
      dv.setInt32(o + 4, e7(s.lat), true);
      dv.setInt32(o + 8, e7(s.lon), true);
      dv.setUint16(o + 12, s.bearingDeg, true);
      dv.setUint8(o + 14, s.roadClass ?? 0);
      dv.setUint8(o + 15, 0);
      cursor++;
    }
  }
  dv.setUint32(cellOffsetsOffset + numCells * 4, cursor, true);

  return buf;
}
