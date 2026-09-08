import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { BitReader, BitWriter, floorLog2 } from '../src/core/wire/bit-writer.ts';
import { readGamma, writeGamma } from '../src/core/wire/elias.ts';
import { readVarUint, writeVarUint } from '../src/core/wire/varint.ts';
import { deserializeKeys, expandKeys, serializeKeys, type KeyFeature } from '../src/core/wire/keys.ts';
import {
  packSpeedGroups,
  packSpeedGroupsReference,
  serializeValues,
  serializeValuesPlain,
} from '../src/core/wire/values.ts';
import { SpeedGroup, speedGroupByPercentage } from '../src/core/speed-groups.ts';

const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(here, '..', '..', '..', 'libs', 'traffic', 'traffic_tests', 'golden_traffic_vectors.json');

interface Vector {
  name: string;
  features: KeyFeature[];
  keys: [number, number, number][];
  values: (keyof typeof SpeedGroup)[];
  keysHex: string;
  valuesPlainHex: string;
}

const golden: { vectors: Vector[] } = JSON.parse(readFileSync(goldenPath, 'utf8'));

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));

test('golden vectors: keys serialise to the exact bytes the C++ client expects', () => {
  for (const v of golden.vectors) {
    assert.equal(hex(serializeKeys(v.features)), v.keysHex, `keys mismatch for "${v.name}"`);
  }
});

test('golden vectors: values serialise to the exact pre-deflate payload', () => {
  for (const v of golden.vectors) {
    const values = Uint8Array.from(v.values.map((n) => SpeedGroup[n]));
    assert.equal(hex(serializeValuesPlain(values)), v.valuesPlainHex, `values mismatch for "${v.name}"`);
  }
});

test('golden vectors: key expansion matches the client key list', () => {
  for (const v of golden.vectors) {
    const expanded = expandKeys(v.features).map((k) => [k.fid, k.idx, k.dir]);
    assert.deepEqual(expanded, v.keys, `expansion mismatch for "${v.name}"`);
  }
});

test('golden vectors: keys round-trip through our own decoder', () => {
  for (const v of golden.vectors) {
    assert.deepEqual(deserializeKeys(unhex(v.keysHex)), v.features, `round-trip failed for "${v.name}"`);
  }
});

test('values are zlib (RFC 1950), not gzip or raw deflate', () => {
  const values = Uint8Array.from([0, 1, 3, 2, 2, 2, 5, 6]);
  const wire = serializeValues(values);
  // A zlib stream starts with a CMF byte whose low nibble is 8 (deflate), and the first two
  // bytes form a big-endian multiple of 31.
  assert.equal(wire[0] & 0x0f, 8, 'not a deflate stream');
  assert.equal(((wire[0] << 8) | wire[1]) % 31, 0, 'bad zlib header checksum');
  assert.deepEqual(new Uint8Array(inflateSync(wire)), serializeValuesPlain(values));
});

test('bit writer is LSB-first within each byte and zero-pads the tail', () => {
  const w = new BitWriter();
  w.write(1, 1); // bit 0
  w.write(0, 1);
  w.write(1, 1); // bit 2
  assert.deepEqual(w.finish(), Uint8Array.from([0b0000_0101]));

  const full = new BitWriter();
  full.write(0xff, 8);
  full.write(0x01, 1);
  assert.deepEqual(full.finish(), Uint8Array.from([0xff, 0x01]));
});

test('bit writer and reader round-trip across byte boundaries', () => {
  const widths = [1, 3, 7, 8, 5, 13, 32, 2, 17];
  const values = [1, 5, 100, 200, 17, 8000, 0xdeadbeef, 3, 99999];
  const w = new BitWriter();
  widths.forEach((n, i) => w.write(values[i], n));
  const r = new BitReader(w.finish());
  widths.forEach((n, i) => assert.equal(r.read(n), values[i] >>> 0, `width ${n}`));
});

test('gamma coding round-trips, including values above 2^31', () => {
  const cases = [1, 2, 3, 4, 5, 7, 8, 9, 127, 128, 1023, 65535, 2 ** 31, 4294967291, 4294967296];
  for (const v of cases) {
    const w = new BitWriter();
    writeGamma(w, v);
    // 2n+1 bits, where n = floor(log2 v).
    assert.equal(w.bitsWritten, 2 * floorLog2(v) + 1, `bit count for ${v}`);
    assert.equal(readGamma(new BitReader(w.finish())), v, `round-trip for ${v}`);
  }
});

test('gamma emits n zeros then a one, matching the LSB-first C++ layout', () => {
  // gamma(8): n = 3, so three 0 bits, a 1, then the low 3 bits of 8 (all zero).
  const w = new BitWriter();
  writeGamma(w, 8);
  assert.deepEqual(w.finish(), Uint8Array.from([0b0000_1000]));
});

test('gamma rejects zero, which the C++ encoder cannot represent', () => {
  assert.throws(() => writeGamma(new BitWriter(), 0), RangeError);
});

test('varuint round-trips at the LEB128 boundaries', () => {
  for (const v of [0, 1, 127, 128, 129, 16383, 16384, 2 ** 31, 2 ** 32 - 1]) {
    const bytes = Uint8Array.from(writeVarUint(v));
    assert.deepEqual(readVarUint(bytes, 0), { value: v, length: bytes.length }, `varuint ${v}`);
  }
  assert.deepEqual(writeVarUint(0), [0x00]);
  assert.deepEqual(writeVarUint(128), [0x80, 0x01]);
});

test('the fast speed-group packer agrees with the BitWriter reference', () => {
  for (let len = 0; len < 64; len++) {
    const values = new Uint8Array(len);
    for (let i = 0; i < len; i++) values[i] = (i * 5 + len) % 8;
    assert.deepEqual(packSpeedGroups(values), packSpeedGroupsReference(values), `length ${len}`);
  }
});

test('speedGroupByPercentage reproduces the C++ thresholds', () => {
  assert.equal(speedGroupByPercentage(0), SpeedGroup.G0);
  assert.equal(speedGroupByPercentage(8), SpeedGroup.G0);
  assert.equal(speedGroupByPercentage(8.1), SpeedGroup.G1);
  assert.equal(speedGroupByPercentage(16), SpeedGroup.G1);
  assert.equal(speedGroupByPercentage(33), SpeedGroup.G2);
  assert.equal(speedGroupByPercentage(58), SpeedGroup.G3);
  assert.equal(speedGroupByPercentage(83), SpeedGroup.G4);
  assert.equal(speedGroupByPercentage(100), SpeedGroup.G5);
  // Out-of-range input is clamped, never surfacing as TempBlock or Unknown.
  assert.equal(speedGroupByPercentage(1000), SpeedGroup.G5);
  assert.equal(speedGroupByPercentage(-5), SpeedGroup.G0);
});

test('serializeKeys rejects inputs the client format cannot express', () => {
  assert.throws(() => serializeKeys([{ fid: 5, numSegs: 1, oneWay: true }, { fid: 1, numSegs: 1, oneWay: true }]), /ascending/);
  // m_idx is a 15-bit field on the client.
  assert.throws(() => serializeKeys([{ fid: 0, numSegs: 32768, oneWay: true }]), /numSegs/);
});
