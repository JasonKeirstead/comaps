/**
 * Writes a small .cmti fixture to disk, for smoke-testing the Node entry point without a
 * generator_tool build. Not part of the test suite.
 *
 *   node --experimental-strip-types test/make-fixture-index.ts <dir> <Country> <mapVersion>
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIndex } from './helpers/build-index.ts';

const [dir, country, version] = process.argv.slice(2);
if (!dir || !country || !version) {
  console.error('usage: make-fixture-index.ts <dir> <Country> <mapVersion>');
  process.exit(1);
}

const buf = buildIndex({
  countryName: country,
  mwmVersion: Number(version),
  features: [
    { fid: 10, numSegs: 2, oneWay: false },
    { fid: 11, numSegs: 1, oneWay: true },
  ],
  segments: [
    { segmentIndex: 0, lat: 53.9, lon: 27.56, bearingDeg: 90 },
    { segmentIndex: 1, lat: 53.9, lon: 27.56, bearingDeg: 90 },
    { segmentIndex: 2, lat: 53.901, lon: 27.562, bearingDeg: 90 },
    { segmentIndex: 3, lat: 53.901, lon: 27.562, bearingDeg: 90 },
    { segmentIndex: 4, lat: 53.91, lon: 27.58, bearingDeg: 0 },
  ],
  bbox: { minLat: 53.8, minLon: 27.4, maxLat: 54.0, maxLon: 27.7 },
});

const target = join(dir, 'index', version);
mkdirSync(target, { recursive: true });
writeFileSync(join(target, `${country}.cmti`), Buffer.from(buf));
console.log(`wrote ${join(target, `${country}.cmti`)} (${buf.byteLength} bytes)`);
