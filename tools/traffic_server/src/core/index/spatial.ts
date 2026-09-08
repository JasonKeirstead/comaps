/**
 * Grid lookup over a traffic index: given a point (and optionally a direction of travel),
 * find the road segments an incident should be applied to.
 *
 * Incidents are sparse -- a busy metro has tens to low hundreds of them -- so this only ever
 * touches the handful of cells a piece of incident geometry falls in.
 */

import { readSegment, type SegmentRecord, type TrafficIndex } from './format.ts';

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

/** Great-circle distance in metres. Equirectangular is plenty at incident-matching scale. */
export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const x = (lon2 - lon1) * DEG * Math.cos(((lat1 + lat2) / 2) * DEG);
  const y = (lat2 - lat1) * DEG;
  return Math.sqrt(x * x + y * y) * EARTH_RADIUS_M;
}

/** Initial bearing from point 1 to point 2, in degrees clockwise from north. */
export function bearingDegrees(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = (lon2 - lon1) * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2 * DEG);
  const x =
    Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) - Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos(dLon);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/** Smallest absolute difference between two bearings, 0..180. */
export function bearingDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export interface Match {
  record: SegmentRecord;
  distance: number;
}

export class SpatialIndex {
  private readonly index: TrafficIndex;
  private readonly latStep: number;
  private readonly lonStep: number;

  constructor(index: TrafficIndex) {
    this.index = index;
    const { bbox, gridCols, gridRows } = index;
    this.latStep = (bbox.maxLat - bbox.minLat) / Math.max(1, gridRows);
    this.lonStep = (bbox.maxLon - bbox.minLon) / Math.max(1, gridCols);
  }

  private cellOf(lat: number, lon: number): { col: number; row: number } | null {
    const { bbox, gridCols, gridRows } = this.index;
    if (lat < bbox.minLat || lat > bbox.maxLat || lon < bbox.minLon || lon > bbox.maxLon) return null;
    const col = Math.min(gridCols - 1, Math.max(0, Math.floor((lon - bbox.minLon) / this.lonStep)));
    const row = Math.min(gridRows - 1, Math.max(0, Math.floor((lat - bbox.minLat) / this.latStep)));
    return { col, row };
  }

  /**
   * Segments within `radiusMeters` of the point. When `bearing` is given, segments whose own
   * bearing differs by more than `bearingToleranceDeg` in both directions are rejected -- that
   * keeps an incident on one carriageway off the opposite one.
   */
  near(
    lat: number,
    lon: number,
    radiusMeters: number,
    bearing?: number,
    bearingToleranceDeg = 45,
  ): Match[] {
    const home = this.cellOf(lat, lon);
    if (!home) return [];

    // How many cells the radius spans, so a point near a cell edge still sees its neighbours.
    const latSpan = Math.ceil(radiusMeters / Math.max(1, this.latStep * DEG * EARTH_RADIUS_M));
    const lonSpan = Math.ceil(
      radiusMeters / Math.max(1, this.lonStep * DEG * EARTH_RADIUS_M * Math.cos(lat * DEG)),
    );

    const { gridCols, gridRows, cellOffsets } = this.index;
    const out: Match[] = [];

    for (let row = home.row - latSpan; row <= home.row + latSpan; row++) {
      if (row < 0 || row >= gridRows) continue;
      for (let col = home.col - lonSpan; col <= home.col + lonSpan; col++) {
        if (col < 0 || col >= gridCols) continue;
        const cell = row * gridCols + col;
        for (let i = cellOffsets[cell]; i < cellOffsets[cell + 1]; i++) {
          const record = readSegment(this.index, i);
          const distance = distanceMeters(lat, lon, record.lat, record.lon);
          if (distance > radiusMeters) continue;
          if (bearing !== undefined) {
            // A segment record's bearing describes dir=0; dir=1 runs the opposite way, so a
            // match against either orientation is acceptable here and direction is resolved
            // by the caller.
            const forward = bearingDelta(bearing, record.bearingDeg);
            const backward = bearingDelta(bearing, (record.bearingDeg + 180) % 360);
            if (Math.min(forward, backward) > bearingToleranceDeg) continue;
          }
          out.push({ record, distance });
        }
      }
    }

    out.sort((a, b) => a.distance - b.distance);
    return out;
  }
}

/**
 * Inserts intermediate points so a sparse polyline still lands in every cell it crosses.
 * TomTom returns incident geometry with fairly wide spacing on motorways.
 */
export function densify(points: [number, number][], stepMeters: number): [number, number][] {
  if (points.length === 0) return [];
  const out: [number, number][] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [lat1, lon1] = points[i - 1];
    const [lat2, lon2] = points[i];
    const d = distanceMeters(lat1, lon1, lat2, lon2);
    const steps = Math.max(1, Math.ceil(d / stepMeters));
    for (let s = 1; s <= steps; s++) {
      out.push([lat1 + ((lat2 - lat1) * s) / steps, lon1 + ((lon2 - lon1) * s) / steps]);
    }
  }
  return out;
}
