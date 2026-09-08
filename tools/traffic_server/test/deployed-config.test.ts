/**
 * Guards on the settings actually shipped in wrangler.toml.
 *
 * The Deploy to Cloudflare button hands these straight to a free account, where nobody will read
 * them before they take effect. A value that fails its own validation there is a deploy that
 * comes up broken.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, REFRESH_CHOICES, validateConfig, type Env } from '../src/core/config.ts';

const here = dirname(fileURLToPath(import.meta.url));
const wranglerToml = readFileSync(join(here, '..', 'wrangler.toml'), 'utf8');

/** Pulls the `[vars]` block out of wrangler.toml. Enough TOML for a flat table of strings. */
function wranglerVars(): Env {
  const start = wranglerToml.indexOf('[vars]');
  assert.notEqual(start, -1, 'wrangler.toml has no [vars] block');
  const rest = wranglerToml.slice(start + '[vars]'.length);
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

test('the wrangler.toml [vars] shipped to users pass validation', () => {
  const env = wranglerVars();
  // Supplied as secrets by the deploy flow, not committed.
  env.TOMTOM_API_KEY = 'supplied-at-deploy';
  env.TRAFFIC_ADMIN_TOKEN = 'supplied-at-deploy';

  assert.deepEqual(validateConfig(loadConfig(env)), []);
});

test('the shipped refresh interval is one of the offered choices', () => {
  const env = wranglerVars();
  assert.ok((REFRESH_CHOICES as readonly number[]).includes(Number(env.TRAFFIC_REFRESH_SECONDS)));
});

test('there is no cron trigger', () => {
  // A cron would mean refreshing areas nobody is looking at. It is also pointless: on the free
  // plan a Cron Trigger gets the same 10 ms CPU budget as a request, so it buys no headroom.
  assert.equal(/\bcrons\s*=/.test(wranglerToml), false, 'wrangler.toml still declares a cron trigger');
});

test("the shipped budget stays inside the free plan's KV write allowance", () => {
  // A refresh is one provider call and one stored write, so the budget bounds both. KV on the
  // free plan allows 1,000 writes/day, which binds before TomTom's 2,500 calls.
  const config = loadConfig({ ...wranglerVars(), TOMTOM_API_KEY: 'k', TRAFFIC_ADMIN_TOKEN: 't' });
  assert.ok(
    config.dailyRequestBudget <= 1000,
    `budget of ${config.dailyRequestBudget} exceeds the free plan's 1,000 KV writes/day`,
  );
});

test('the built-in defaults validate, with nothing configured but credentials', () => {
  const config = loadConfig({ TOMTOM_API_KEY: 'k', TRAFFIC_ADMIN_TOKEN: 't' });
  assert.deepEqual(validateConfig(config), []);
});

test('a non-positive budget is refused, since it is the only cap on spend', () => {
  const config = loadConfig({
    TOMTOM_API_KEY: 'k',
    TRAFFIC_ALLOW_ANONYMOUS: 'true',
    TRAFFIC_DAILY_REQUEST_BUDGET: '0',
  });
  assert.match(validateConfig(config).join('\n'), /must be positive/);
});
