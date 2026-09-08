/**
 * Which areas the refresh job should keep fresh.
 *
 * Areas are discovered rather than declared. A phone downloads a map, asks for traffic, and the
 * pair gets recorded here; the cron then refreshes what has been asked for recently. Nothing to
 * edit when you download another region, and nothing to edit when the map version rolls over --
 * the client starts asking for the new version and the old entry expires.
 *
 * This also bounds provider spend to maps someone is actually looking at. The previous static
 * TRAFFIC_AREAS list burned quota on every configured area whether or not anyone had it on
 * screen.
 */

import type { Config } from './config.ts';
import { demandKey, type DemandRecord, type Storage } from '../storage/types.ts';

/** How long an area stays "wanted" after its last request. */
export const DEMAND_TTL_SECONDS = 3600;

/**
 * Records that a client wants this area.
 *
 * Deliberately cheap and best-effort: it runs on the serving path, where the client is polling
 * every minute per visible map, so it must not add latency or fail a request. Writes are skipped
 * when the record is already fresh, which matters on Cloudflare's free plan (1,000 KV writes/day
 * would otherwise be spent in a few hours by a single phone).
 */
export async function recordDemand(
  storage: Storage,
  country: string,
  mapVersion: number,
  config: Config,
): Promise<void> {
  if (!config.autoDiscoverAreas) return;

  const key = demandKey(country, mapVersion);
  try {
    const existing = await storage.getState(key);
    if (existing) {
      const record = JSON.parse(existing) as DemandRecord;
      // Only re-write once the record is halfway to expiry.
      if (Date.now() - record.lastRequestedAt < (DEMAND_TTL_SECONDS * 1000) / 2) return;
    }

    const record: DemandRecord = { country, mapVersion, lastRequestedAt: Date.now() };
    await storage.putState(key, JSON.stringify(record), DEMAND_TTL_SECONDS);
  } catch {
    // Never fail a client request because bookkeeping did.
  }
}

/**
 * Areas to refresh: those requested within the TTL, most recently requested first, capped.
 *
 * The cap is what stops a user with thirty downloaded maps from silently exhausting a free
 * provider tier. Busiest areas win, since the list is sorted by last request.
 */
export async function activeAreas(storage: Storage, config: Config): Promise<DemandRecord[]> {
  if (!config.autoDiscoverAreas) {
    return config.areas.map((a) => ({ ...a, lastRequestedAt: Date.now() }));
  }

  const keys = await storage.listState('demand/');
  const records: DemandRecord[] = [];
  const cutoff = Date.now() - DEMAND_TTL_SECONDS * 1000;

  for (const key of keys) {
    const raw = await storage.getState(key);
    if (!raw) continue;
    try {
      const record = JSON.parse(raw) as DemandRecord;
      // The filesystem backend has no TTL of its own, so check the timestamp here too.
      if (record.lastRequestedAt >= cutoff) records.push(record);
    } catch {
      // Ignore anything unparseable rather than stalling the whole refresh.
    }
  }

  // Areas named in config are always kept fresh, whether or not anyone has asked lately: that is
  // what TRAFFIC_AREAS now means -- a pinned set, not the complete set.
  for (const pinned of config.areas) {
    if (!records.some((r) => r.country === pinned.country && r.mapVersion === pinned.mapVersion)) {
      records.push({ ...pinned, lastRequestedAt: Date.now() });
    }
  }

  records.sort((a, b) => b.lastRequestedAt - a.lastRequestedAt);
  return records.slice(0, config.maxActiveAreas);
}
