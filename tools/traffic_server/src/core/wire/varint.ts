/** LEB128 varints, matching libs/coding/varint.hpp. */

export function writeVarUint(value: number): number[] {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`varuint requires a non-negative integer, got ${value}`);
  }
  const out: number[] = [];
  let v = value;
  while (v > 0x7f) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

export function readVarUint(data: Uint8Array, offset: number): { value: number; length: number } {
  let value = 0;
  let shift = 1;
  let i = offset;
  for (;;) {
    const byte = data[i];
    if (byte === undefined) throw new RangeError('varuint truncated');
    value += (byte & 0x7f) * shift;
    i++;
    if ((byte & 0x80) === 0) break;
    shift *= 128;
    if (shift > 2 ** 53) throw new RangeError('varuint too large');
  }
  return { value, length: i - offset };
}
