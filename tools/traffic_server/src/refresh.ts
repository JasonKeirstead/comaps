/**
 * The refresh job: pull current conditions from the provider, encode a `.traffic` body, store it.
 *
 * Deliberately out of the request path. Two reasons:
 *   - Provider quota. The client polls once a minute per visible MWM; on a free TomTom key
 *     (2,500 non-tile requests/day) serving each poll live would be exhausted in minutes.
 *   - Cloudflare CPU. Bit-packing and deflating an area's values is tens of milliseconds, well
 *     over the 10 ms/request free-plan budget. Serving a stored blob is ~2 ms.
 */

import type { Config } from './core/config.ts';
import { activeAreas } from './core/demand.ts';
import { refreshSeconds } from './core/settings.ts';
import { parseTrafficIndex } from './core/index/format.ts';
import { generateTraffic } from './core/pipeline.ts';
import { TomTomProvider } from './core/providers/tomtom.ts';
import type { TrafficProvider } from './core/providers/types.ts';
import type { Storage } from './storage/types.ts';

export interface RefreshResult {
  country: string;
  mapVersion: number;
  status: 'updated' | 'skipped' | 'failed';
  detail?: string;
  coloredSegments?: number;
  segmentCount?: number;
}

const quotaKey = () => `quota/${new Date().toISOString().slice(0, 10)}`;
const LAST_REFRESH_KEY = 'refresh/lastAt';

/**
 * How early a tick may run and still count as due.
 *
 * The Worker is driven by a cron firing every REFRESH_TICK_SECONDS, and cron delivery is not
 * precise to the second. Without slack, a tick arriving a moment early is not due, the next one
 * is a whole tick later, and a 30 min interval silently becomes 35.
 */
const DUE_TOLERANCE_MS = 30_000;

export function createProvider(config: Config, fetchImpl?: typeof fetch): TrafficProvider {
  return new TomTomProvider({ apiKey: config.tomtomApiKey, fetchImpl });
}

/**
 * Refreshes every configured area. Failures are per-area: one unreachable region must not stop
 * the others, since the client will happily keep serving stale data for the rest.
 */
export interface RefreshOptions {
  /** Run regardless of when the last refresh was. For an operator asking for one by hand. */
  force?: boolean;
}

export async function refreshAll(
  config: Config,
  storage: Storage,
  provider: TrafficProvider = createProvider(config),
  options: RefreshOptions = {},
): Promise<RefreshResult[]> {
  const results: RefreshResult[] = [];

  // The schedule that drives this is a fixed tick -- a cron on Cloudflare, a timer under Node --
  // and the chosen interval is enforced here, against the last run. Doing it this way is what
  // lets the interval be a setting at all: a Worker cannot rewrite its own cron, so if the cron
  // were the interval then TRAFFIC_REFRESH_SECONDS would be decorative.
  const interval = await refreshSeconds(storage, config);
  const now = Date.now();
  const lastAt = Number((await storage.getState(LAST_REFRESH_KEY)) ?? 0);
  if (!options.force && now - lastAt < interval * 1000 - DUE_TOLERANCE_MS) return results;

  // Areas come from what clients have actually asked for, plus anything pinned in config.
  const areas = await activeAreas(storage, config);

  // Counted in memory across the tick rather than re-read per area: KV is eventually consistent,
  // so a read here would not see the write from the previous iteration and every area in a tick
  // would charge itself against the same starting number.
  const startingQuota = Number((await storage.getState(quotaKey())) ?? 0);
  let used = startingQuota;

  for (const area of areas) {
    try {
      if (used >= config.dailyRequestBudget) {
        results.push({
          country: area.country,
          mapVersion: area.mapVersion,
          status: 'skipped',
          detail: `daily provider budget of ${config.dailyRequestBudget} reached`,
        });
        continue;
      }

      const raw = await storage.readIndex(area.country, area.mapVersion);
      if (!raw) {
        results.push({
          country: area.country,
          mapVersion: area.mapVersion,
          status: 'failed',
          detail: `no index for ${area.country}@${area.mapVersion}; build and upload one`,
        });
        continue;
      }

      const index = parseTrafficIndex(raw);
      if (index.mwmVersion !== area.mapVersion) {
        // Serving values built against a different map release would produce a key-count
        // mismatch, and the client discards the whole payload without saying why.
        results.push({
          country: area.country,
          mapVersion: area.mapVersion,
          status: 'failed',
          detail: `index is for map version ${index.mwmVersion}, configured as ${area.mapVersion}`,
        });
        continue;
      }

      const events = await provider.fetch(index.bbox);
      used += 1;

      const generated = generateTraffic(index, events, config.matchOptions);
      await storage.writeGenerated(area.country, area.mapVersion, {
        body: generated.body,
        etag: generated.etag,
        generatedAt: generated.generatedAt,
        coloredSegments: generated.coloredSegments,
      });

      results.push({
        country: area.country,
        mapVersion: area.mapVersion,
        status: 'updated',
        coloredSegments: generated.coloredSegments,
        segmentCount: index.segmentCount,
      });
    } catch (err) {
      results.push({ country: area.country, mapVersion: area.mapVersion, status: 'failed', detail: err instanceof Error ? err.message : String(err) });
    }
  }

  // Once per tick rather than once per area. On KV that halves the writes a tick costs, which
  // matters on a free plan capped at 1,000/day. The cost is that a worker killed mid-tick loses
  // this tick's count; the provider's own rate limit is the backstop if that ever compounds.
  if (used !== startingQuota) {
    await storage.putState(quotaKey(), String(used), 2 * 86400);
  }

  // Stamped even when every area failed. Retrying a broken provider on every tick would spend
  // the interval's worth of quota in one go, and the client keeps serving what it has anyway.
  await storage.putState(LAST_REFRESH_KEY, String(now));

  return results;
}
