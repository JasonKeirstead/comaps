/**
 * Producing a `.traffic` body: pull current conditions from the provider, encode, store.
 *
 * Driven by client requests, not by a timer. The client asks for an area once a minute; if what
 * we hold is older than the chosen interval, that request refreshes it and gets the fresh bytes,
 * and otherwise it is served from storage for about a millisecond. Nobody looking at an area
 * means no provider calls for it at all.
 *
 * There was a cron here, on the theory that encoding was too expensive for the request path.
 * It is not: parsing a 22k-segment index is 0.1 ms and encoding it against 200 incidents is
 * 3.4 ms, against a 10 ms free-plan budget. The cron shared that same 10 ms budget anyway, and
 * refreshing several areas in one firing came closer to blowing it than any single request does.
 */

import type { Config } from './core/config.ts';
import { parseTrafficIndex } from './core/index/format.ts';
import { generateTraffic } from './core/pipeline.ts';
import { TomTomProvider } from './core/providers/tomtom.ts';
import type { TrafficProvider } from './core/providers/types.ts';
import { refreshSeconds } from './core/settings.ts';
import type { GeneratedBlob, Storage } from './storage/types.ts';

export interface RefreshResult {
  country: string;
  mapVersion: number;
  status: 'updated' | 'fresh' | 'skipped' | 'failed';
  detail?: string;
  coloredSegments?: number;
  segmentCount?: number;
}

const quotaKey = () => `quota/${new Date().toISOString().slice(0, 10)}`;
const inFlightKey = (country: string, mapVersion: number) => `refreshing/${mapVersion}/${country}`;

/**
 * How long another request assumes an in-progress refresh is still running.
 *
 * KV's minimum TTL is 60 s, which is also roughly the client's poll period, so at worst one extra
 * poll is served stale after a refresh that died mid-flight.
 */
const IN_FLIGHT_TTL_SECONDS = 60;

export function createProvider(config: Config, fetchImpl?: typeof fetch): TrafficProvider {
  return new TomTomProvider({ apiKey: config.tomtomApiKey, fetchImpl });
}

export interface RefreshOptions {
  /** Refresh even if what we hold is still within the interval. */
  force?: boolean;
}

/**
 * Brings one area up to date if it needs it, and returns what should be served.
 *
 * Returns the existing blob untouched when it is still fresh, when another request is already
 * refreshing this area, or when the day's provider budget is gone -- serving slightly old data
 * beats spending quota twice over or failing a request outright.
 */
export async function refreshArea(
  config: Config,
  storage: Storage,
  country: string,
  mapVersion: number,
  provider: TrafficProvider = createProvider(config),
  options: RefreshOptions = {},
): Promise<{ blob: GeneratedBlob | null; result: RefreshResult }> {
  const existing = await storage.readGenerated(country, mapVersion);
  const base = { country, mapVersion };

  if (!options.force && existing) {
    const interval = await refreshSeconds(storage, config);
    if (Date.now() - existing.generatedAt < interval * 1000) {
      return { blob: existing, result: { ...base, status: 'fresh' } };
    }
  }

  // One refresh per area at a time. Without this, every phone polling the same city the moment
  // its data goes stale would call the provider simultaneously.
  if (!options.force) {
    const inFlight = await storage.getState(inFlightKey(country, mapVersion));
    if (inFlight) {
      return { blob: existing, result: { ...base, status: 'skipped', detail: 'refresh already in progress' } };
    }
  }

  const used = Number((await storage.getState(quotaKey())) ?? 0);
  if (used >= config.dailyRequestBudget) {
    return {
      blob: existing,
      result: {
        ...base,
        status: 'skipped',
        detail: `daily provider budget of ${config.dailyRequestBudget} reached`,
      },
    };
  }

  const raw = await storage.readIndex(country, mapVersion);
  if (!raw) {
    return {
      blob: existing,
      result: {
        ...base,
        status: 'failed',
        detail: `no index for ${country}@${mapVersion}; cover this area first`,
      },
    };
  }

  const index = parseTrafficIndex(raw);
  if (index.mwmVersion !== mapVersion) {
    // Serving values built against a different map release would produce a key-count mismatch,
    // and the client discards the whole payload without saying why.
    return {
      blob: existing,
      result: {
        ...base,
        status: 'failed',
        detail: `index is for map version ${index.mwmVersion}, asked for ${mapVersion}`,
      },
    };
  }

  await storage.putState(inFlightKey(country, mapVersion), '1', IN_FLIGHT_TTL_SECONDS);

  try {
    const events = await provider.fetch(index.bbox);
    await storage.putState(quotaKey(), String(used + 1), 2 * 86400);

    const generated = generateTraffic(index, events, config.matchOptions);
    const blob: GeneratedBlob = {
      body: generated.body,
      etag: generated.etag,
      generatedAt: generated.generatedAt,
      coloredSegments: generated.coloredSegments,
    };
    await storage.writeGenerated(country, mapVersion, blob);

    return {
      blob,
      result: {
        ...base,
        status: 'updated',
        coloredSegments: generated.coloredSegments,
        segmentCount: index.segmentCount,
      },
    };
  } catch (err) {
    // Keep serving what we have. A provider outage should degrade to stale data, not to no data.
    return {
      blob: existing,
      result: { ...base, status: 'failed', detail: err instanceof Error ? err.message : String(err) },
    };
  } finally {
    await storage.deleteState(inFlightKey(country, mapVersion));
  }
}

/**
 * Refreshes every area we hold an index for. Only for an operator asking by hand -- normal
 * operation refreshes one area at a time, when a client asks for it.
 */
export async function refreshAll(
  config: Config,
  storage: Storage,
  provider: TrafficProvider = createProvider(config),
  options: RefreshOptions = { force: true },
): Promise<RefreshResult[]> {
  const seen = new Set<string>();
  const areas: { country: string; mapVersion: number }[] = [];

  const add = (country: string, mapVersion: number) => {
    const key = `${mapVersion}/${country}`;
    if (seen.has(key)) return;
    seen.add(key);
    areas.push({ country, mapVersion });
  };

  for (const area of config.areas) {
    add(area.country, area.mapVersion);
    // Also pick up other map versions we hold for the same country, so an operator sees the
    // stale ones left behind by a map update rather than only what is configured.
    for (const version of await storage.indexVersions(area.country)) add(area.country, version);
  }

  const results: RefreshResult[] = [];
  for (const area of areas) {
    const { result } = await refreshArea(config, storage, area.country, area.mapVersion, provider, options);
    results.push(result);
  }
  return results;
}
