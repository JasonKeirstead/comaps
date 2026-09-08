/**
 * LSB-first bit streams, byte-compatible with libs/coding/bit_streams.hpp.
 *
 * The C++ BitWriter fills each byte from bit 0 upward: bit index `b` of the stream lives at
 * byte `b >> 3`, bit position `b & 7`. Values are written least-significant-bit first, and the
 * final partial byte is zero-padded on flush.
 *
 * Getting this backwards is the single easiest way to produce a blob the client silently
 * rejects, so the reader here exists mainly so tests can round-trip.
 */

/** Largest value we can bit-manipulate exactly with Number. */
const MAX_SAFE_BITS = 53;

export class BitWriter {
  private readonly bytes: number[] = [];
  private buf = 0;
  private nbits = 0;

  /** Number of bits written so far, including any not yet flushed. */
  get bitsWritten(): number {
    return this.bytes.length * 8 + this.nbits;
  }

  /** Writes the low `n` bits of `value`, least significant first. `n` <= 53. */
  write(value: number, n: number): void {
    if (n === 0) return;
    if (n > MAX_SAFE_BITS) throw new RangeError(`cannot write ${n} bits exactly`);

    // Split above 32 bits so the bitwise ops below stay in int32 range.
    if (n > 32) {
      const low = value >>> 0 === value ? value : value % 0x100000000;
      this.write(low >>> 0, 32);
      this.write(Math.floor(value / 0x100000000), n - 32);
      return;
    }

    for (let k = 0; k < n; k++) {
      if ((value >>> k) & 1) this.buf |= 1 << this.nbits;
      if (++this.nbits === 8) {
        this.bytes.push(this.buf);
        this.buf = 0;
        this.nbits = 0;
      }
    }
  }

  /** Flushes any partial byte with zero padding and returns the stream. */
  finish(): Uint8Array {
    const out = new Uint8Array(this.bytes.length + (this.nbits > 0 ? 1 : 0));
    out.set(this.bytes);
    if (this.nbits > 0) out[this.bytes.length] = this.buf;
    return out;
  }
}

export class BitReader {
  private pos = 0;
  private readonly data: Uint8Array;
  private readonly byteOffset: number;

  constructor(data: Uint8Array, byteOffset = 0) {
    this.data = data;
    this.byteOffset = byteOffset;
  }

  /** Bits consumed so far. */
  get bitsRead(): number {
    return this.pos;
  }

  /** Reads `n` bits, least significant first. `n` <= 32. */
  read(n: number): number {
    if (n === 0) return 0;
    if (n > 32) throw new RangeError(`cannot read ${n} bits into an int32`);

    let value = 0;
    for (let k = 0; k < n; k++) {
      const b = this.pos++;
      const byte = this.data[this.byteOffset + (b >> 3)];
      if (byte === undefined) throw new RangeError('bit stream exhausted');
      if ((byte >> (b & 7)) & 1) value += 2 ** k;
    }
    return value;
  }
}

/** floor(log2(v)) for v >= 1, exact up to 2^53. */
export function floorLog2(v: number): number {
  if (v < 1) throw new RangeError('floorLog2 requires v >= 1');
  if (v < 0x100000000) return 31 - Math.clz32(v);
  return 32 + floorLog2(Math.floor(v / 0x100000000));
}
