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

export function createProvider(config: Config, fetchImpl?: typeof fetch): TrafficProvider {
  return new TomTomProvider({ apiKey: config.tomtomApiKey, fetchImpl });
}

/**
 * Refreshes every configured area. Failures are per-area: one unreachable region must not stop
 * the others, since the client will happily keep serving stale data for the rest.
 */
export async function refreshAll(
  config: Config,
  storage: Storage,
  provider: TrafficProvider = createProvider(config),
): Promise<RefreshResult[]> {
  const results: RefreshResult[] = [];

  for (const area of config.areas) {
    try {
      const used = Number((await storage.getState(quotaKey())) ?? 0);
      if (used >= config.dailyRequestBudget) {
        results.push({
          ...area,
          status: 'skipped',
          detail: `daily provider budget of ${config.dailyRequestBudget} reached`,
        });
        continue;
      }

      const raw = await storage.readIndex(area.country, area.mapVersion);
      if (!raw) {
        results.push({
          ...area,
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
          ...area,
          status: 'failed',
          detail: `index is for map version ${index.mwmVersion}, configured as ${area.mapVersion}`,
        });
        continue;
      }

      const events = await provider.fetch(index.bbox);
      await storage.putState(quotaKey(), String(used + 1), 2 * 86400);

      const generated = generateTraffic(index, events, config.matchOptions);
      await storage.writeGenerated(area.country, area.mapVersion, {
        body: generated.body,
        etag: generated.etag,
        generatedAt: generated.generatedAt,
        coloredSegments: generated.coloredSegments,
      });

      results.push({
        ...area,
        status: 'updated',
        coloredSegments: generated.coloredSegments,
        segmentCount: index.segmentCount,
      });
    } catch (err) {
      results.push({ ...area, status: 'failed', detail: err instanceof Error ? err.message : String(err) });
    }
  }

  return results;
}
