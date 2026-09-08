import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import test from 'node:test';

import { parseTrafficIndex } from '../src/core/index/format.ts';
import { applyEvents, generateTraffic } from '../src/core/pipeline.ts';
import { parseIncidents } from '../src/core/providers/tomtom.ts';
import { SpeedGroup } from '../src/core/speed-groups.ts';
import { deserializeKeys, expandKeys } from '../src/core/wire/keys.ts';
import { etagFor, etagMatches } from '../src/core/etag.ts';
import { buildIndex } from './helpers/build-index.ts';

/**
 * A tiny synthetic area: two two-way features running east-west along 52.50 N, one segment each,
 * so the expanded key list is [f0 dir0, f0 dir1, f1 dir0, f1 dir1].
 */
function fixture() {
  const buf = buildIndex({
    countryName: 'Testland_City',
    mwmVersion: 250628,
    features: [
      { fid: 10, numSegs: 1, oneWay: false },
      { fid: 11, numSegs: 1, oneWay: false },
    ],
    segments: [
      { segmentIndex: 0, lat: 52.5, lon: 13.4, bearingDeg: 90 },
      { segmentIndex: 1, lat: 52.5, lon: 13.4, bearingDeg: 90 },
      { segmentIndex: 2, lat: 52.6, lon: 13.6, bearingDeg: 0 },
      { segmentIndex: 3, lat: 52.6, lon: 13.6, bearingDeg: 0 },
    ],
    bbox: { minLat: 52.4, minLon: 13.3, maxLat: 52.7, maxLon: 13.7 },
  });
  return parseTrafficIndex(buf);
}

test('index round-trips through the parser', () => {
  const index = fixture();
  assert.equal(index.countryName, 'Testland_City');
  assert.equal(index.mwmVersion, 250628);
  assert.equal(index.segmentCount, 4);
  assert.deepEqual(expandKeys(deserializeKeys(index.keysBlob)), [
    { fid: 10, idx: 0, dir: 0 },
    { fid: 10, idx: 0, dir: 1 },
    { fid: 11, idx: 0, dir: 0 },
    { fid: 11, idx: 0, dir: 1 },
  ]);
});

test('unsampled segments stay Unknown rather than being claimed free-flowing', () => {
  const index = fixture();
  const values = applyEvents(index, []);
  assert.equal(values.length, index.segmentCount);
  assert.ok(values.every((v) => v === SpeedGroup.Unknown));
});

test('an incident colours only the segments near it', () => {
  const index = fixture();
  const values = applyEvents(index, [
    { geometry: [[52.5, 13.3995], [52.5, 13.4005]], group: SpeedGroup.G1 },
  ]);
  assert.equal(values[0], SpeedGroup.G1);
  assert.equal(values[1], SpeedGroup.G1);
  // The other feature is 10+ km away and must be untouched.
  assert.equal(values[2], SpeedGroup.Unknown);
  assert.equal(values[3], SpeedGroup.Unknown);
});

test('bearing filtering keeps a jam off a perpendicular road', () => {
  const index = fixture();
  // A north-south incident sitting on top of the east-west segments.
  const values = applyEvents(index, [
    { geometry: [[52.4995, 13.4], [52.5005, 13.4]], group: SpeedGroup.G0 },
  ]);
  assert.ok(values.every((v) => v === SpeedGroup.Unknown), 'perpendicular incident should not match');
});

test('the worst condition wins where incidents overlap', () => {
  const index = fixture();
  const geometry: [number, number][] = [[52.5, 13.3995], [52.5, 13.4005]];

  // A closure must survive a later, milder incident on the same stretch. TempBlock is 6 and
  // G3 is 3, so a naive numeric comparison gets this backwards.
  assert.equal(
    applyEvents(index, [
      { geometry, group: SpeedGroup.G3 },
      { geometry, group: SpeedGroup.TempBlock },
      { geometry, group: SpeedGroup.G4 },
    ])[0],
    SpeedGroup.TempBlock,
    'a closure outranks any slowdown',
  );

  // Among ordinary groups the slower one wins.
  assert.equal(
    applyEvents(index, [
      { geometry, group: SpeedGroup.G4 },
      { geometry, group: SpeedGroup.G1 },
    ])[0],
    SpeedGroup.G1,
  );

  // And anything real beats Unknown, whichever order they arrive in.
  assert.equal(
    applyEvents(index, [
      { geometry, group: SpeedGroup.G5 },
      { geometry, group: SpeedGroup.Unknown },
    ])[0],
    SpeedGroup.G5,
  );
});

test('generateTraffic produces a body the client can inflate, with a stable ETag', () => {
  const index = fixture();
  const events = [{ geometry: [[52.5, 13.3995], [52.5, 13.4005]] as [number, number][], group: SpeedGroup.G2 }];

  const a = generateTraffic(index, events);
  const b = generateTraffic(index, events);
  assert.equal(a.etag, b.etag, 'same values must yield the same tag');
  assert.equal(a.coloredSegments, 2);

  const plain = new Uint8Array(inflateSync(a.body));
  assert.equal(plain[0], 0, 'values version byte');
  assert.equal(plain[1], 4, 'varuint segment count');

  const different = generateTraffic(index, []);
  assert.notEqual(a.etag, different.etag);
});

test('ETag matching handles the empty header the client sends first', () => {
  const tag = etagFor(Uint8Array.from([7, 7, 7]));
  assert.equal(etagMatches(null, tag), false);
  assert.equal(etagMatches('', tag), false);
  assert.equal(etagMatches(tag, tag), true);
  assert.equal(etagMatches(`W/${tag}`, tag), true);
  assert.equal(etagMatches('"something-else"', tag), false);
});

test('TomTom incidents map to the expected groups', () => {
  const events = parseIncidents({
    incidents: [
      {
        geometry: { type: 'LineString', coordinates: [[13.4, 52.5], [13.41, 52.51]] },
        properties: { iconCategory: 6, currentSpeed: 10, freeFlowSpeed: 100 },
      },
      {
        geometry: { type: 'LineString', coordinates: [[13.42, 52.52], [13.43, 52.53]] },
        properties: { iconCategory: 8, magnitudeOfDelay: 4 },
      },
      {
        geometry: { type: 'Point', coordinates: [13.44, 52.54] },
        properties: { magnitudeOfDelay: 3 },
      },
      // No usable speed or delay: skipped rather than guessed at.
      { geometry: { type: 'Point', coordinates: [13.45, 52.55] }, properties: {} },
    ],
  });

  assert.equal(events.length, 3);
  // 10/100 = 10%, which lands in G1 (threshold 16).
  assert.equal(events[0].group, SpeedGroup.G1);
  // iconCategory 8 is a closure, and must win over magnitudeOfDelay.
  assert.equal(events[1].group, SpeedGroup.TempBlock);
  assert.equal(events[2].group, SpeedGroup.G1);
  // GeoJSON is [lon, lat]; everything downstream works in [lat, lon].
  assert.deepEqual(events[0].geometry[0], [52.5, 13.4]);
});
