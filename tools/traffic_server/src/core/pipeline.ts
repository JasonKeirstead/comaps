/**
 * Turns provider events into a `.traffic` body.
 *
 * Everything starts as Unknown and only sampled segments are overwritten. That matters: the
 * client drops Unknown entries instead of inserting them into its coloring map, so unsampled
 * roads cost nothing and are not painted. Filling with G5 instead would both claim "verified
 * free-flowing" for roads we never looked at and materialise a map node per segment, which the
 * drape engine then copies wholesale to the render thread.
 */

import { SpeedGroup } from './speed-groups.ts';
import { bearingDegrees, densify, SpatialIndex } from './index/spatial.ts';
import type { TrafficIndex } from './index/format.ts';
import type { TrafficEvent } from './providers/types.ts';
import { serializeValues, unknownValues } from './wire/values.ts';
import { etagFor } from './etag.ts';

export interface MatchOptions {
  /** How far from incident geometry a segment can be and still count. */
  radiusMeters: number;
  /** Densification step for incident polylines. */
  densifyStepMeters: number;
  /** Reject segments whose orientation disagrees with the incident's direction of travel. */
  bearingToleranceDeg: number;
  /** Cap on segments a single incident may colour, as a guard against runaway geometry. */
  maxSegmentsPerEvent: number;
}

/**
 * Severity order for resolving overlapping incidents; lower wins.
 *
 * The enum's numeric order is *not* severity order: TempBlock is 6 and Unknown is 7, so a naive
 * numeric comparison would let a minor slowdown overwrite a road closure. A closure is the most
 * severe thing we can report -- the router special-cases it and reroutes -- and Unknown is the
 * least, since it means "no data".
 */
function severity(group: number): number {
  if (group === SpeedGroup.TempBlock) return -1;
  if (group === SpeedGroup.Unknown) return 100;
  return group; // G0 (gridlock) through G5 (free flow)
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
  radiusMeters: 40,
  densifyStepMeters: 25,
  bearingToleranceDeg: 50,
  maxSegmentsPerEvent: 4000,
};

export interface GeneratedTraffic {
  /** The deflated `.traffic` body. */
  body: Uint8Array;
  /** Derived from the *uncompressed* payload, so it survives moving between runtimes. */
  etag: string;
  /** How many segments got a group other than Unknown. */
  coloredSegments: number;
  generatedAt: number;
}

/**
 * Applies events to the index and returns the value array. Exposed separately from
 * `generateTraffic` so tests can assert on groups rather than bytes.
 */
export function applyEvents(
  index: TrafficIndex,
  events: readonly TrafficEvent[],
  options: MatchOptions = DEFAULT_MATCH_OPTIONS,
): Uint8Array {
  const values = unknownValues(index.segmentCount);
  const spatial = new SpatialIndex(index);

  for (const event of events) {
    const points = densify(event.geometry, options.densifyStepMeters);
    let colored = 0;

    for (let i = 0; i < points.length && colored < options.maxSegmentsPerEvent; i++) {
      const [lat, lon] = points[i];
      // Direction of travel along the incident, used to keep one carriageway's jam off the other.
      const next = points[i + 1] ?? points[i - 1];
      const bearing =
        next && (next[0] !== lat || next[1] !== lon) ? bearingDegrees(lat, lon, next[0], next[1]) : undefined;

      for (const match of spatial.near(
        lat,
        lon,
        options.radiusMeters,
        bearing,
        options.bearingToleranceDeg,
      )) {
        const idx = match.record.segmentIndex;
        if (idx >= values.length) continue;
        // Worst condition wins where incidents overlap: a closure must not be softened by a
        // neighbouring slowdown, and any real reading replaces Unknown.
        if (severity(event.group) < severity(values[idx])) {
          values[idx] = event.group;
          colored++;
        }
      }
    }
  }

  return values;
}

export function generateTraffic(
  index: TrafficIndex,
  events: readonly TrafficEvent[],
  options: MatchOptions = DEFAULT_MATCH_OPTIONS,
): GeneratedTraffic {
  const values = applyEvents(index, events, options);

  let coloredSegments = 0;
  for (const v of values) if (v !== SpeedGroup.Unknown) coloredSegments++;

  return {
    body: serializeValues(values),
    etag: etagFor(values),
    coloredSegments,
    generatedAt: Date.now(),
  };
}
