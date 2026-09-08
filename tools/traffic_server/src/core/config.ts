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
   * Areas to report on in /healthz, and the ones `comaps-traffic refresh` walks.
   *
   * Not a coverage list: an area is served, and refreshed, because a client asks for it and we
   * hold an index for it. Nothing here causes any provider traffic on its own.
   */
  areas: CoverageArea[];
  /** How stale a stored body may be before a client request refreshes it. */
  refreshSeconds: number;
  /**
   * Hard cap on refreshes per UTC day, to stay inside a free tier.
   *
   * One refresh is one provider call and one stored write, so this bounds both. On Cloudflare's
   * free plan the binding limit is KV's 1,000 writes/day rather than TomTom's 2,500 calls.
   */
  dailyRequestBudget: number;
  /** Serve without an API key. Reasonable on a trusted LAN, not on the public internet. */
  allowAnonymous: boolean;
  /** A fixed key, as an alternative to QR pairing. */
  staticApiKey: string;
  /**
   * Optional. When unset, one is generated on first use and shown on /setup -- see core/admin.ts.
   * Set it only if you want a token you chose yourself.
   */
  adminToken: string;
  /** Base URL handed to phones during pairing. */
  publicBaseUrl: string;
  serverName: string;
  /** Local directory holding .cmti index files. Container only. */
  indexDir: string;
  matchOptions: MatchOptions;
}

export type Env = Record<string, string | undefined>;

/**
 * The refresh intervals an operator may choose, in seconds.
 *
 * This is a staleness bound, not a schedule: a stored body older than this is refreshed by the
 * next client request for it, and nothing happens in between. Nothing shorter than 5 minutes is
 * offered because the client polls once a minute and a shorter bound would spend provider quota
 * on data that has barely changed.
 */
export const REFRESH_CHOICES = [300, 600, 1800, 3600] as const;

export const describeRefresh = (seconds: number): string =>
  seconds % 3600 === 0 ? `${seconds / 3600}h` : `${Math.round(seconds / 60)} min`;

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
    refreshSeconds: num(env, 'TRAFFIC_REFRESH_SECONDS', 1800),
    dailyRequestBudget: num(env, 'TRAFFIC_DAILY_REQUEST_BUDGET', 2000),
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
  if (!(REFRESH_CHOICES as readonly number[]).includes(config.refreshSeconds)) {
    errors.push(
      `TRAFFIC_REFRESH_SECONDS must be one of ${REFRESH_CHOICES.join(', ')}, got ${config.refreshSeconds}`,
    );
  }
  if (config.dailyRequestBudget <= 0) {
    errors.push('TRAFFIC_DAILY_REQUEST_BUDGET must be positive; it is the only cap on provider spend');
  }
  return errors;
}

/**
 * How many refreshes a day one area costs at a given interval.
 *
 * Only an upper bound, and only reached while someone actually has that area on screen -- an
 * area nobody is looking at costs nothing at all.
 */
export const refreshesPerAreaPerDay = (refreshSeconds: number): number => 86400 / refreshSeconds;

/** How many areas can be watched continuously at this interval before the budget runs out. */
export const areasWithinBudget = (config: Config, refreshSeconds: number): number =>
  Math.floor(config.dailyRequestBudget / refreshesPerAreaPerDay(refreshSeconds));
