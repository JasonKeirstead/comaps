/**
 * Configuration, read from environment variables so the Worker and the container are
 * configured identically.
 */

import { DEFAULT_MATCH_OPTIONS, type MatchOptions } from './pipeline.ts';

export interface CoverageArea {
  /** MWM country name exactly as it appears in data/countries.txt, e.g. "Belarus_Minsk Region". */
  country: string;
  /** Map series stamp of the MWM this index was built from, e.g. 250628. */
  mapVersion: number;
}

export interface Config {
  provider: 'tomtom';
  tomtomApiKey: string;
  /**
   * Areas kept fresh unconditionally. With auto-discovery on (the default) this is a pinned
   * set, not the complete set -- clients add areas by asking for them.
   */
  areas: CoverageArea[];
  /** Pick up areas from client requests instead of requiring them to be declared. */
  autoDiscoverAreas: boolean;
  /** Ceiling on areas refreshed per cycle, so discovery cannot exhaust a free provider tier. */
  maxActiveAreas: number;
  refreshSeconds: number;
  /** Hard cap on provider requests per UTC day, to stay inside a free tier. */
  dailyRequestBudget: number;
  /**
   * Storage writes allowed per UTC day, or 0 for no limit.
   *
   * Only the Cloudflare deployment sets this: the free plan allows 1,000 KV writes/day, which
   * is a tighter ceiling than the provider budget and would otherwise be discovered as refreshes
   * quietly failing partway through a day. Disk has no such limit, so the container leaves it 0.
   */
  dailyWriteBudget: number;
  /** Serve without an API key. Reasonable on a trusted LAN, not on the public internet. */
  allowAnonymous: boolean;
  /** A fixed key, as an alternative to QR pairing. */
  staticApiKey: string;
  adminToken: string;
  /** Base URL handed to phones during pairing. */
  publicBaseUrl: string;
  serverName: string;
  /** Local directory holding .cmti index files. Container only. */
  indexDir: string;
  matchOptions: MatchOptions;
}

export type Env = Record<string, string | undefined>;

const num = (env: Env, key: string, fallback: number): number => {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${key} must be a number, got "${raw}"`);
  return v;
};

const bool = (env: Env, key: string, fallback: boolean): boolean => {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
};

/**
 * TRAFFIC_AREAS is a comma-separated list of `Country@version`, e.g.
 *   "Belarus_Minsk Region@250628,Germany_Berlin@250628"
 * The version must match the MWM the user actually has: feature ids are only stable within a
 * single map build, so an index built for another release will produce a key-count mismatch
 * and the client will silently discard the payload.
 */
export function parseAreas(raw: string | undefined): CoverageArea[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.lastIndexOf('@');
      if (at < 1) throw new Error(`TRAFFIC_AREAS entry "${entry}" must look like "Country@version"`);
      const country = entry.slice(0, at).trim();
      const mapVersion = Number(entry.slice(at + 1));
      if (!Number.isInteger(mapVersion) || mapVersion <= 0) {
        throw new Error(`TRAFFIC_AREAS entry "${entry}" has a bad map version`);
      }
      return { country, mapVersion };
    });
}

export function loadConfig(env: Env): Config {
  const config: Config = {
    provider: 'tomtom',
    tomtomApiKey: env.TOMTOM_API_KEY ?? '',
    areas: parseAreas(env.TRAFFIC_AREAS),
    autoDiscoverAreas: bool(env, 'TRAFFIC_AUTO_DISCOVER_AREAS', true),
    // 6, not 8: at the default 300s that is 1,728 provider requests/day, inside the default
    // 2,000 budget. 8 needed 2,304 and made the service refuse to start on its own defaults.
    maxActiveAreas: num(env, 'TRAFFIC_MAX_ACTIVE_AREAS', 6),
    refreshSeconds: num(env, 'TRAFFIC_REFRESH_SECONDS', 300),
    dailyRequestBudget: num(env, 'TRAFFIC_DAILY_REQUEST_BUDGET', 2000),
    dailyWriteBudget: num(env, 'TRAFFIC_DAILY_WRITE_BUDGET', 0),
    allowAnonymous: bool(env, 'TRAFFIC_ALLOW_ANONYMOUS', false),
    staticApiKey: env.TRAFFIC_API_KEY ?? '',
    adminToken: env.TRAFFIC_ADMIN_TOKEN ?? '',
    publicBaseUrl: env.TRAFFIC_PUBLIC_BASE_URL ?? '',
    serverName: env.TRAFFIC_SERVER_NAME ?? 'CoMaps traffic',
    indexDir: env.TRAFFIC_INDEX_DIR ?? './index',
    matchOptions: {
      ...DEFAULT_MATCH_OPTIONS,
      radiusMeters: num(env, 'TRAFFIC_MATCH_RADIUS_M', DEFAULT_MATCH_OPTIONS.radiusMeters),
      bearingToleranceDeg: num(
        env,
        'TRAFFIC_BEARING_TOLERANCE_DEG',
        DEFAULT_MATCH_OPTIONS.bearingToleranceDeg,
      ),
    },
  };

  return config;
}

/** Problems worth refusing to start over, rather than failing one request at a time. */
export function validateConfig(config: Config): string[] {
  const errors: string[] = [];
  if (!config.tomtomApiKey) errors.push('TOMTOM_API_KEY is required');
  if (config.areas.length === 0 && !config.autoDiscoverAreas) {
    errors.push('set TRAFFIC_AREAS, or leave TRAFFIC_AUTO_DISCOVER_AREAS on so clients can add areas themselves');
  }
  if (config.refreshSeconds < 60) {
    errors.push('TRAFFIC_REFRESH_SECONDS below 60 wastes provider quota; the client polls once a minute');
  }
  if (!config.allowAnonymous && !config.staticApiKey && !config.adminToken) {
    errors.push(
      'set TRAFFIC_ADMIN_TOKEN (to issue pairing codes), or TRAFFIC_API_KEY, or TRAFFIC_ALLOW_ANONYMOUS=true',
    );
  }

  // At one provider request per area per refresh. With discovery on, the worst case is the
  // ceiling rather than the pinned list, so check against that.
  const worstCaseAreas = config.autoDiscoverAreas
    ? Math.max(config.areas.length, config.maxActiveAreas)
    : config.areas.length;
  const ticksPerDay = 86400 / config.refreshSeconds;
  const perDay = ticksPerDay * worstCaseAreas;
  if (perDay > config.dailyRequestBudget) {
    errors.push(
      `${worstCaseAreas} area(s) refreshed every ${config.refreshSeconds}s needs ` +
        `${Math.ceil(perDay)} provider requests/day, over the ${config.dailyRequestBudget} budget. ` +
        'Raise TRAFFIC_REFRESH_SECONDS, or lower TRAFFIC_MAX_ACTIVE_AREAS.',
    );
  }

  // Each refreshed area writes its generated body, and the quota counter is written alongside.
  // Catching this at startup beats the alternative: KV starts rejecting writes partway through
  // the day and traffic silently stops updating while every endpoint still looks healthy.
  if (config.dailyWriteBudget > 0) {
    const writesPerDay = ticksPerDay * (worstCaseAreas + 1);
    if (writesPerDay > config.dailyWriteBudget) {
      errors.push(
        `${worstCaseAreas} area(s) refreshed every ${config.refreshSeconds}s needs ` +
          `${Math.ceil(writesPerDay)} storage writes/day, over the ${config.dailyWriteBudget} budget. ` +
          'Raise TRAFFIC_REFRESH_SECONDS, lower TRAFFIC_MAX_ACTIVE_AREAS, or bind R2 and raise ' +
          'TRAFFIC_DAILY_WRITE_BUDGET.',
      );
    }
  }
  return errors;
}
