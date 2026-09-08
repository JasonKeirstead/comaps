/**
 * The storage write budget, and a guard that the settings actually shipped in wrangler.toml
 * pass their own validation.
 *
 * The Deploy to Cloudflare button hands those values straight to a free account, where KV
 * allows 1,000 writes/day. Getting them wrong does not fail the deploy -- it fails hours later,
 * as writes start being rejected while every endpoint still reports healthy.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, REFRESH_CHOICES, REFRESH_TICK_SECONDS, validateConfig, type Env } from '../src/core/config.ts';

const here = dirname(fileURLToPath(import.meta.url));
const wranglerToml = readFileSync(join(here, '..', 'wrangler.toml'), 'utf8');

/** Pulls the `[vars]` block out of wrangler.toml. Enough TOML for a flat table of strings. */
function wranglerVars(): Env {
  const start = wranglerToml.indexOf('[vars]');
  assert.notEqual(start, -1, 'wrangler.toml has no [vars] block');
  const rest = wranglerToml.slice(start + '[vars]'.length);
  // Stop at the next table header that is not commented out.
  const end = rest.search(/\n\[[^\]]+\]/);
  const block = end === -1 ? rest : rest.slice(0, end);

  const env: Env = {};
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Z0-9_]+)\s*=\s*"(.*)"$/.exec(trimmed);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

/** The cron cadence in seconds. Only the every-N-minutes form is used here. */
function cronSeconds(): number {
  const match = /crons\s*=\s*\["\*\/(\d+) \* \* \* \*"\]/.exec(wranglerToml);
  assert.ok(match, 'wrangler.toml cron is not in the expected */N minutes form');
  return Number(match[1]) * 60;
}

test('the wrangler.toml [vars] shipped to users pass validation', () => {
  const env = wranglerVars();
  // Supplied as secrets by the deploy flow, not committed.
  env.TOMTOM_API_KEY = 'supplied-at-deploy';
  env.TRAFFIC_ADMIN_TOKEN = 'supplied-at-deploy';

  assert.deepEqual(validateConfig(loadConfig(env)), []);
});

test('the cron fires at the tick cadence, not at the chosen interval', () => {
  // The cron is a fixed tick and refresh.ts enforces the chosen interval against it. A cron
  // slower than the shortest selectable interval would make that interval look settable while
  // silently delivering the cron's rate instead.
  assert.equal(cronSeconds(), REFRESH_TICK_SECONDS);
});

test('every refresh choice is a whole multiple of the tick', () => {
  // Otherwise a refresh falls due between ticks and runs late by up to a full tick, every time.
  for (const seconds of REFRESH_CHOICES) {
    assert.equal(seconds % REFRESH_TICK_SECONDS, 0, `${seconds}s is not a multiple of the tick`);
  }
});

test('the shipped settings fit inside the free KV write allowance', () => {
  const env = wranglerVars();
  const config = loadConfig({ ...env, TOMTOM_API_KEY: 'k', TRAFFIC_ADMIN_TOKEN: 't' });

  const ticks = 86400 / config.refreshSeconds;
  const writes = ticks * (config.maxActiveAreas + 1);
  assert.ok(
    writes <= 1000,
    `shipped settings need ${Math.ceil(writes)} KV writes/day, over the free plan's 1000`,
  );
});

test('the built-in defaults validate, with nothing configured but credentials', () => {
  // These are what the Docker deployment runs on. They were previously self-contradictory --
  // 8 areas at 300s needed 2,304 provider requests/day against a 2,000 default budget -- so the
  // container refused to start on its own defaults.
  const config = loadConfig({ TOMTOM_API_KEY: 'k', TRAFFIC_ADMIN_TOKEN: 't' });
  assert.deepEqual(validateConfig(config), []);
});

test('an over-budget write load is refused at startup', () => {
  // 8 areas every 5 minutes is 2,592 writes/day, well over a free KV plan.
  const config = loadConfig({
    TOMTOM_API_KEY: 'k',
    TRAFFIC_ALLOW_ANONYMOUS: 'true',
    TRAFFIC_REFRESH_SECONDS: '300',
    TRAFFIC_MAX_ACTIVE_AREAS: '8',
    TRAFFIC_DAILY_WRITE_BUDGET: '1000',
    TRAFFIC_DAILY_REQUEST_BUDGET: '100000',
  });
  assert.match(validateConfig(config).join('\n'), /storage writes\/day, over the 1000 budget/);
});

test('a zero write budget means unlimited, as the container needs', () => {
  // Disk has no per-day write ceiling; the check must not fire for the Docker deployment.
  const config = loadConfig({
    TOMTOM_API_KEY: 'k',
    TRAFFIC_ALLOW_ANONYMOUS: 'true',
    TRAFFIC_REFRESH_SECONDS: '300',
    TRAFFIC_MAX_ACTIVE_AREAS: '50',
    TRAFFIC_DAILY_REQUEST_BUDGET: '100000',
  });
  assert.equal(config.dailyWriteBudget, 0);
  assert.equal(validateConfig(config).join('\n').includes('storage writes'), false);
});
