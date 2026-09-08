/**
 * TomTom Traffic Incidents provider.
 *
 * Deliberately uses the Incidents API rather than Flow Segment Data: the free tier allows
 * 2,500 non-tile requests per day, and Flow Segment Data is a *point* query. Sampling even a
 * modest city per segment would exhaust the daily quota in seconds. Incidents takes a bounding
 * box and returns every event inside it with geometry, so one request covers a whole coverage
 * area.
 *
 * Docs: https://developer.tomtom.com/traffic-api/documentation/traffic-incidents/incident-details
 */

import { SpeedGroup, speedGroupFromSpeeds, type SpeedGroupValue } from '../speed-groups.ts';
import type { BBox, TrafficEvent, TrafficProvider } from './types.ts';

const ENDPOINT = 'https://api.tomtom.com/traffic/services/5/incidentDetails';

/**
 * magnitudeOfDelay -> speed group. TomTom's scale is
 *   0 unknown, 1 minor, 2 moderate, 3 major, 4 undefined (used for closures and the like).
 * We only fall back to this when the richer speed fields are absent.
 */
const DELAY_TO_GROUP: Record<number, SpeedGroupValue> = {
  0: SpeedGroup.G4,
  1: SpeedGroup.G4,
  2: SpeedGroup.G3,
  3: SpeedGroup.G1,
  4: SpeedGroup.G2,
};

/** iconCategory values that mean the road is not passable. */
const CLOSURE_CATEGORIES = new Set([8]); // 8 = road closed

interface TomTomIncident {
  geometry?: { type: string; coordinates: number[][] | number[] };
  properties?: {
    iconCategory?: number;
    magnitudeOfDelay?: number;
    delay?: number;
    /** metres per second */
    currentSpeed?: number;
    freeFlowSpeed?: number;
  };
}

export interface TomTomOptions {
  apiKey: string;
  /** Passed through to TomTom; higher means more geometry detail. */
  zoom?: number;
  fetchImpl?: typeof fetch;
}

export class TomTomProvider implements TrafficProvider {
  readonly name = 'tomtom';
  private readonly apiKey: string;
  private readonly zoom: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TomTomOptions) {
    if (!options.apiKey) throw new Error('TomTom provider requires an API key');
    this.apiKey = options.apiKey;
    this.zoom = options.zoom ?? 12;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  buildUrl(bbox: BBox): string {
    const params = new URLSearchParams({
      key: this.apiKey,
      // TomTom wants minLon,minLat,maxLon,maxLat.
      bbox: [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat].join(','),
      fields:
        '{incidents{type,geometry{type,coordinates},properties{iconCategory,magnitudeOfDelay,delay,' +
        'currentSpeed,freeFlowSpeed}}}',
      language: 'en-GB',
      categoryFilter: '0,1,2,3,4,5,6,7,8,9,10,11,14',
      timeValidityFilter: 'present',
    });
    return `${ENDPOINT}?${params.toString()}&zoom=${this.zoom}`;
  }

  async fetch(bbox: BBox, signal?: AbortSignal): Promise<TrafficEvent[]> {
    const response = await this.fetchImpl(this.buildUrl(bbox), { signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`TomTom request failed: ${response.status} ${body.slice(0, 200)}`);
    }
    return parseIncidents(await response.json());
  }
}

/** Exported so tests can run against a recorded response without a network call. */
export function parseIncidents(payload: unknown): TrafficEvent[] {
  const incidents = (payload as { incidents?: TomTomIncident[] })?.incidents ?? [];
  const out: TrafficEvent[] = [];

  for (const incident of incidents) {
    const geometry = toLatLonPairs(incident.geometry);
    if (geometry.length === 0) continue;

    const props = incident.properties ?? {};
    let group: SpeedGroupValue;

    if (props.iconCategory !== undefined && CLOSURE_CATEGORIES.has(props.iconCategory)) {
      // The router special-cases TempBlock and will route around it.
      group = SpeedGroup.TempBlock;
    } else if (typeof props.currentSpeed === 'number' && typeof props.freeFlowSpeed === 'number') {
      group = speedGroupFromSpeeds(props.currentSpeed, props.freeFlowSpeed);
    } else if (typeof props.magnitudeOfDelay === 'number') {
      group = DELAY_TO_GROUP[props.magnitudeOfDelay] ?? SpeedGroup.G4;
    } else {
      // Nothing usable: leave these segments Unknown rather than guessing.
      continue;
    }

    out.push({ geometry, group });
  }

  return out;
}

/** TomTom emits GeoJSON [lon, lat]; everything downstream here works in [lat, lon]. */
function toLatLonPairs(geometry: TomTomIncident['geometry']): [number, number][] {
  if (!geometry || !Array.isArray(geometry.coordinates)) return [];
  const coords = geometry.coordinates;

  if (typeof coords[0] === 'number') {
    const [lon, lat] = coords as number[];
    return Number.isFinite(lat) && Number.isFinite(lon) ? [[lat, lon]] : [];
  }

  const out: [number, number][] = [];
  for (const pair of coords as number[][]) {
    if (Array.isArray(pair) && Number.isFinite(pair[0]) && Number.isFinite(pair[1])) {
      out.push([pair[1], pair[0]]);
    }
  }
  return out;
}
