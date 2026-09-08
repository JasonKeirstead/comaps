/**
 * Reads a .cmti file with the production parser and prints what it found.
 * Used to check a C++-written index against the TypeScript reader.
 *
 *   node --experimental-strip-types test/read-cmti.ts <file.cmti>
 */

import { readFileSync } from 'node:fs';
import { parseTrafficIndex, readSegment } from '../src/core/index/format.ts';

const path = process.argv[2];
if (!path) {
  console.error('usage: read-cmti.ts <file.cmti>');
  process.exit(1);
}

const buf = readFileSync(path);
const index = parseTrafficIndex(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);

console.log('countryName   ', JSON.stringify(index.countryName));
console.log('mwmVersion    ', index.mwmVersion);
console.log('segmentCount  ', index.segmentCount);
console.log('keysBlob      ', Buffer.from(index.keysBlob).toString('hex'));
console.log('bbox          ', index.bbox);
console.log('grid          ', `${index.gridCols}x${index.gridRows}`);
console.log('cellOffsets[-1]', index.cellOffsets[index.cellOffsets.length - 1]);
console.log('segments:');
for (let i = 0; i < index.segmentCount; i++) {
  const s = readSegment(index, i);
  console.log(
    `  #${i} idx=${s.segmentIndex} lat=${s.lat.toFixed(5)} lon=${s.lon.toFixed(5)} ` +
      `bearing=${s.bearingDeg} class=${s.roadClass}`,
  );
}
