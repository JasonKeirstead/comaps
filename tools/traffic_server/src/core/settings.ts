/**
 * Settings an operator can change on a running service, without a redeploy.
 *
 * Only the refresh interval so far. It lives here rather than in Config because Config is built
 * from environment variables, and changing one of those on Cloudflare means editing wrangler.toml
 * and deploying again -- too much ceremony for a dial you are expected to turn while watching
 * what it costs you.
 */

import { areasWithinBudget, describeRefresh, refreshesPerAreaPerDay, REFRESH_CHOICES, type Config } from './config.ts';
import type { Storage } from '../storage/types.ts';

const REFRESH_KEY = 'settings/refreshSeconds';

export interface RefreshSetting {
  seconds: number;
  choices: readonly number[];
  /** Where the current value came from, which is the first thing you want when it surprises you. */
  source: 'override' | 'environment';
}

/**
 * The interval in force. Falls back to TRAFFIC_REFRESH_SECONDS when nothing has been set, and
 * also when a stored value is no longer valid -- an override written before the choice list
 * changed must not wedge the service.
 */
export async function getRefresh(storage: Storage, config: Config): Promise<RefreshSetting> {
  const raw = await storage.getState(REFRESH_KEY);
  const stored = raw === null ? NaN : Number(raw);
  const valid = (REFRESH_CHOICES as readonly number[]).includes(stored);
  return {
    seconds: valid ? stored : config.refreshSeconds,
    choices: REFRESH_CHOICES,
    source: valid ? 'override' : 'environment',
  };
}

/** Convenience for the callers that only want the number. */
export async function refreshSeconds(storage: Storage, config: Config): Promise<number> {
  return (await getRefresh(storage, config)).seconds;
}

export type SetRefreshResult =
  | { ok: true; seconds: number }
  | { ok: false; status: number; errors: string[] };

export async function setRefresh(
  storage: Storage,
  config: Config,
  seconds: number,
): Promise<SetRefreshResult> {
  if (!Number.isInteger(seconds) || !(REFRESH_CHOICES as readonly number[]).includes(seconds)) {
    return {
      ok: false,
      status: 400,
      errors: [`seconds must be one of ${REFRESH_CHOICES.join(', ')}`],
    };
  }

  await storage.putState(REFRESH_KEY, String(seconds));
  return { ok: true, seconds };
}

export interface RefreshChoice {
  seconds: number;
  label: string;
  /** Refreshes one continuously-watched area costs per day at this interval. */
  perAreaPerDay: number;
  /** How many areas can be watched all day at this interval before the budget runs out. */
  areasWithinBudget: number;
}

/**
 * The choices, with what each one costs.
 *
 * Deliberately not a pass/fail: since a refresh only happens when someone asks, the real spend
 * depends on how much the service is used, and no setting can be ruled out in advance. What is
 * worth showing is how many areas you could watch continuously before the daily budget stops you.
 */
export function describeChoices(config: Config): RefreshChoice[] {
  return REFRESH_CHOICES.map((seconds) => ({
    seconds,
    label: describeRefresh(seconds),
    perAreaPerDay: refreshesPerAreaPerDay(seconds),
    areasWithinBudget: areasWithinBudget(config, seconds),
  }));
}
