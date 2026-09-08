/**
 * The `.traffic.keys` payload, matching TrafficInfo::{Serialize,Deserialize}TrafficKeys
 * in libs/traffic/traffic_info.cpp.
 *
 * Layout (uncompressed -- unlike values, keys are served raw):
 *
 *     u8      version = 0
 *     varuint numFids
 *     bitstream, LSB-first:
 *       numFids x gamma(fid[i] - fid[i-1] + 1)   delta-coded, fid[-1] = 0
 *       numFids x gamma(numSegs[i] + 1)
 *       numFids x 1 bit                          1 = one-way
 *     zero-padded to a byte boundary
 *
 * The client expands this to RoadSegmentId(fid, idx, dir) for idx in [0, numSegs) and
 * dir in [0, oneWay ? 1 : 2), in that order. Direction count is derived per feature, not
 * stored per segment, which is why a feature is either wholly one-way or wholly two-way.
 */

import { BitReader, BitWriter } from './bit-writer.ts';
import { readGamma, writeGamma } from './elias.ts';
import { readVarUint, writeVarUint } from './varint.ts';

export const KEYS_VERSION = 0;

/** One road feature's contribution to the key space. */
export interface KeyFeature {
  /** Feature index within the MWM. Must be strictly increasing across the array. */
  fid: number;
  /** Number of segments, i.e. points - 1. */
  numSegs: number;
  /** One-way features contribute only dir=0. */
  oneWay: boolean;
}

export interface RoadSegmentId {
  fid: number;
  idx: number;
  dir: 0 | 1;
}

/** Number of RoadSegmentIds the given features expand to. */
export function countSegments(features: readonly KeyFeature[]): number {
  let n = 0;
  for (const f of features) n += f.numSegs * (f.oneWay ? 1 : 2);
  return n;
}

export function serializeKeys(features: readonly KeyFeature[]): Uint8Array {
  const header: number[] = [KEYS_VERSION, ...writeVarUint(features.length)];

  const w = new BitWriter();
  let prevFid = 0;
  for (const f of features) {
    if (!Number.isInteger(f.fid) || f.fid < 0 || f.fid > 0xffffffff) {
      throw new RangeError(`fid out of range: ${f.fid}`);
    }
    if (f.fid < prevFid) throw new RangeError(`fids must be ascending, saw ${f.fid} after ${prevFid}`);
    // The C++ computes fid - prevFid in uint32 arithmetic; ascending fids keep it non-negative.
    writeGamma(w, f.fid - prevFid + 1);
    prevFid = f.fid;
  }
  for (const f of features) {
    // m_idx is a 15-bit field on the client, so a feature cannot exceed 32767 segments.
    if (!Number.isInteger(f.numSegs) || f.numSegs < 0 || f.numSegs > 0x7fff) {
      throw new RangeError(`numSegs out of range: ${f.numSegs}`);
    }
    writeGamma(w, f.numSegs + 1);
  }
  for (const f of features) w.write(f.oneWay ? 1 : 0, 1);

  const bits = w.finish();
  const out = new Uint8Array(header.length + bits.length);
  out.set(header);
  out.set(bits, header.length);
  return out;
}

export function deserializeKeys(data: Uint8Array): KeyFeature[] {
  if (data.length < 1) throw new RangeError('keys blob truncated');
  if (data[0] !== KEYS_VERSION) throw new Error(`unsupported keys version ${data[0]}`);

  const { value: n, length } = readVarUint(data, 1);
  const r = new BitReader(data, 1 + length);

  const fids: number[] = [];
  let prevFid = 0;
  for (let i = 0; i < n; i++) {
    prevFid += readGamma(r) - 1;
    fids.push(prevFid);
  }
  const numSegs: number[] = [];
  for (let i = 0; i < n; i++) numSegs.push(readGamma(r) - 1);

  const out: KeyFeature[] = [];
  for (let i = 0; i < n; i++) out.push({ fid: fids[i], numSegs: numSegs[i], oneWay: false });
  for (let i = 0; i < n; i++) out[i].oneWay = r.read(1) > 0;
  return out;
}

/** Expands features to the ordered key list the client will build. */
export function expandKeys(features: readonly KeyFeature[]): RoadSegmentId[] {
  const out: RoadSegmentId[] = [];
  for (const f of features) {
    const numDirs = f.oneWay ? 1 : 2;
    for (let idx = 0; idx < f.numSegs; idx++) {
      for (let dir = 0; dir < numDirs; dir++) out.push({ fid: f.fid, idx, dir: dir as 0 | 1 });
    }
  }
  return out;
}
