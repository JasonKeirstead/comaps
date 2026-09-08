/**
 * The `.traffic` payload, matching TrafficInfo::{Serialize,Deserialize}TrafficValues
 * in libs/traffic/traffic_info.cpp.
 *
 * Inner (uncompressed) layout:
 *     u8      version = 0
 *     varuint n
 *     n x 3 bits, LSB-first, zero-padded
 *
 * The whole thing is then zlib-deflated -- RFC 1950, not gzip and not raw deflate. The client
 * inflates with Format::ZLib, which is MAX_WBITS without the autodetect bit, so a gzip stream
 * will not decode.
 *
 * Note that zlib output is implementation-defined: our bytes need not match the C++ encoder's
 * byte for byte, only decode to the same thing. Golden tests therefore assert on the *inner*
 * payload, and ETags are derived from it too, so tags survive moving between runtimes.
 */

import { deflateSync } from 'node:zlib';
import { BitWriter } from './bit-writer.ts';
import { writeVarUint } from './varint.ts';
import { SPEED_GROUP_COUNT, SpeedGroup } from '../speed-groups.ts';

export const VALUES_VERSION = 0;

/**
 * Packs 3-bit speed groups. Hot path, so this indexes the output buffer directly rather than
 * going through BitWriter; `packSpeedGroupsReference` below is the obvious version the tests
 * check it against.
 */
export function packSpeedGroups(values: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil((values.length * 3) / 8));
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v >= SPEED_GROUP_COUNT) throw new RangeError(`speed group ${v} does not fit in 3 bits`);
    const b = i * 3;
    const byte = b >> 3;
    const shift = b & 7;
    // A group straddles at most two bytes since 3 < 8.
    out[byte] |= (v << shift) & 0xff;
    if (shift > 5) out[byte + 1] |= v >> (8 - shift);
  }
  return out;
}

/** Same result via the shared BitWriter; kept as the test oracle. */
export function packSpeedGroupsReference(values: Uint8Array): Uint8Array {
  const w = new BitWriter();
  for (const v of values) w.write(v, 3);
  return w.finish();
}

/** The inner, uncompressed payload. */
export function serializeValuesPlain(values: Uint8Array): Uint8Array {
  const header = [VALUES_VERSION, ...writeVarUint(values.length)];
  const packed = packSpeedGroups(values);
  const out = new Uint8Array(header.length + packed.length);
  out.set(header);
  out.set(packed, header.length);
  return out;
}

/** The wire payload: the inner payload, zlib-deflated. */
export function serializeValues(values: Uint8Array): Uint8Array {
  // Level 9 to match coding::ZLib::Deflate::Level::BestCompression. windowBits 15 selects the
  // zlib wrapper; anything else (e.g. 31 for gzip, -15 for raw) will not decode on the client.
  return deflateSync(serializeValuesPlain(values), { level: 9, windowBits: 15, memLevel: 8 });
}

/** Builds an all-Unknown value array, the correct starting point for a refresh. */
export function unknownValues(n: number): Uint8Array {
  return new Uint8Array(n).fill(SpeedGroup.Unknown);
}
