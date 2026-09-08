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

/**
 * The refresh intervals an operator may choose, in seconds.
 *
 * A closed list rather than a free number because the Cloudflare cron fires at a fixed cadence
 * and the interval is enforced against it in code: every choice must be a whole multiple of the
 * smallest one, or a refresh would land between ticks and run late by up to one tick.
 */
export const REFRESH_CHOICES = [300, 600, 1800, 3600] as const;

/** The cron cadence, and so the resolution at which any longer interval can be honoured. */
export const REFRESH_TICK_SECONDS = REFRESH_CHOICES[0];

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
    autoDiscoverAreas: bool(env, 'TRAFFIC_AUTO_DISCOVER_AREAS', true),
    // At the 30 min default this is 288 provider requests and 336 writes/day -- comfortable.
    // It is deliberately not raised further: the interval is settable at runtime, and a high
    // ceiling here would make the shorter intervals unpickable on a free account.
    maxActiveAreas: num(env, 'TRAFFIC_MAX_ACTIVE_AREAS', 6),
    refreshSeconds: num(env, 'TRAFFIC_REFRESH_SECONDS', 1800),
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
  if (!(REFRESH_CHOICES as readonly number[]).includes(config.refreshSeconds)) {
    errors.push(
      `TRAFFIC_REFRESH_SECONDS must be one of ${REFRESH_CHOICES.join(', ')}, got ${config.refreshSeconds}`,
    );
  }
  if (!config.allowAnonymous && !config.staticApiKey && !config.adminToken) {
    errors.push(
      'set TRAFFIC_ADMIN_TOKEN (to issue pairing codes), or TRAFFIC_API_KEY, or TRAFFIC_ALLOW_ANONYMOUS=true',
    );
  }

  errors.push(...budgetErrors(config, config.refreshSeconds));
  return errors;
}

/**
 * Whether an interval fits the configured budgets. Split out of validateConfig because the
 * interval is also settable at runtime, and picking one the account cannot afford has to be
 * refused there with the same arithmetic and the same wording.
 */
export function budgetErrors(config: Config, refreshSeconds: number): string[] {
  const errors: string[] = [];

  // At one provider request per area per refresh. With discovery on, the worst case is the
  // ceiling rather than the pinned list, so check against that.
  const worstCaseAreas = config.autoDiscoverAreas
    ? Math.max(config.areas.length, config.maxActiveAreas)
    : config.areas.length;
  const ticksPerDay = 86400 / refreshSeconds;

  const perDay = ticksPerDay * worstCaseAreas;
  if (perDay > config.dailyRequestBudget) {
    errors.push(
      `${worstCaseAreas} area(s) refreshed every ${describeRefresh(refreshSeconds)} needs ` +
        `${Math.ceil(perDay)} provider requests/day, over the ${config.dailyRequestBudget} budget. ` +
        'Choose a longer refresh interval, or lower TRAFFIC_MAX_ACTIVE_AREAS.',
    );
  }

  // Each refreshed area writes its generated body, and the tick's bookkeeping is written
  // alongside. Catching this beats the alternative: KV starts rejecting writes partway through
  // the day and traffic silently stops updating while every endpoint still looks healthy.
  if (config.dailyWriteBudget > 0) {
    const writesPerDay = ticksPerDay * (worstCaseAreas + 1);
    if (writesPerDay > config.dailyWriteBudget) {
      errors.push(
        `${worstCaseAreas} area(s) refreshed every ${describeRefresh(refreshSeconds)} needs ` +
          `${Math.ceil(writesPerDay)} storage writes/day, over the ${config.dailyWriteBudget} budget. ` +
          'Choose a longer refresh interval, lower TRAFFIC_MAX_ACTIVE_AREAS, or bind R2 and raise ' +
          'TRAFFIC_DAILY_WRITE_BUDGET.',
      );
    }
  }

  return errors;
}
