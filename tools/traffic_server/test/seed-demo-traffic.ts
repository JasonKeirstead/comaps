/**
 * Seeds a generated `.traffic` blob from synthetic events, so the whole client path can be
 * exercised without a provider API key.
 *
 * Uses the production pipeline and storage, so what it writes is byte-identical to what a real
 * refresh would produce -- only the events are made up.
 *
 *   node --experimental-strip-types test/seed-demo-traffic.ts <dataDir> <Country> <mapVersion>
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTrafficIndex, readSegment } from '../src/core/index/format.ts';
import { generateTraffic } from '../src/core/pipeline.ts';
import { SpeedGroup, type SpeedGroupValue } from '../src/core/speed-groups.ts';
import type { TrafficEvent } from '../src/core/providers/types.ts';
import { FsStorage } from '../src/storage/fs.ts';

const [dataDir, country, versionArg] = process.argv.slice(2);
if (!dataDir || !country || !versionArg) {
  console.error('usage: seed-demo-traffic.ts <dataDir> <Country> <mapVersion>');
  process.exit(1);
}
const mapVersion = Number(versionArg);

const buf = readFileSync(join(dataDir, 'index', versionArg, `${country}.cmti`));
const index = parseTrafficIndex(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);

// Walk the segment table and drop a short incident on roughly every fifth segment, cycling
// through the groups so every colour the renderer knows about appears somewhere.
const groups: SpeedGroupValue[] = [
  SpeedGroup.G0,
  SpeedGroup.G1,
  SpeedGroup.G2,
  SpeedGroup.G3,
  SpeedGroup.G4,
  SpeedGroup.TempBlock,
];

const events: TrafficEvent[] = [];
for (let i = 0; i < index.segmentCount; i += 5) {
  const s = readSegment(index, i);
  // A two-point line through the segment's midpoint, oriented along it, so the bearing filter
  // behaves the way it would for a real incident.
  const rad = (s.bearingDeg * Math.PI) / 180;
  const d = 0.00015;
  events.push({
    geometry: [
      [s.lat - Math.cos(rad) * d, s.lon - Math.sin(rad) * d],
      [s.lat + Math.cos(rad) * d, s.lon + Math.sin(rad) * d],
    ],
    group: groups[(i / 5) % groups.length],
  });
}

const generated = generateTraffic(index, events);
const storage = new FsStorage(dataDir);
await storage.writeGenerated(country, mapVersion, {
  body: generated.body,
  etag: generated.etag,
  generatedAt: generated.generatedAt,
  coloredSegments: generated.coloredSegments,
});

console.log(`seeded ${country}@${mapVersion}`);
console.log(`  events         ${events.length}`);
console.log(`  coloured       ${generated.coloredSegments}/${index.segmentCount} segments`);
console.log(`  body           ${generated.body.length} bytes deflated`);
console.log(`  etag           ${generated.etag}`);
