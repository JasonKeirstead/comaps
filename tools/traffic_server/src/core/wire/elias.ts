/**
 * Elias-gamma coding as implemented by libs/coding/elias_coder.hpp.
 *
 * The C++ encoder is:
 *     n = floorLog2(value)
 *     WriteAtMost64Bits(1 << n, n + 1)   // n zero bits, then a 1
 *     WriteAtMost64Bits(value, n)        // low n bits, LSB-first
 *
 * Because the underlying bit writer is LSB-first, this is *not* the textbook MSB-first gamma:
 * the unary prefix is reversed and the payload bits come out in reverse order. Do not swap in
 * an off-the-shelf gamma implementation.
 */

import { BitReader, BitWriter, floorLog2 } from './bit-writer.ts';

/** Encodes `value` (which must be >= 1). */
export function writeGamma(w: BitWriter, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`gamma coding requires a positive integer, got ${value}`);
  }
  const n = floorLog2(value);
  w.write(0, n);
  w.write(1, 1);
  w.write(value, n);
}

export function readGamma(r: BitReader): number {
  let n = 0;
  while (r.read(1) === 0) {
    if (++n > 53) throw new RangeError('gamma prefix too long');
  }
  // 2**n rather than 1 << n so values above 2^31 stay exact.
  return 2 ** n + (n > 0 ? r.read(n) : 0);
}
