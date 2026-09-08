import type { SpeedGroupValue } from '../speed-groups.ts';

export interface BBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/** One piece of traffic information, already reduced to a speed group. */
export interface TrafficEvent {
  /** Polyline the event applies to, [lat, lon] pairs. A point event is a one-element array. */
  geometry: [number, number][];
  group: SpeedGroupValue;
}

export interface TrafficProvider {
  readonly name: string;
  /**
   * Fetches current conditions for a bounding box.
   * Implementations should make at most a couple of requests: free tiers are small and the
   * refresh job runs on a timer.
   */
  fetch(bbox: BBox, signal?: AbortSignal): Promise<TrafficEvent[]>;
}
