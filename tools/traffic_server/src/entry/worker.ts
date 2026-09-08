/**
 * Cloudflare Workers entry point.
 *
 * `fetch` serves stored bytes and does nothing expensive; `scheduled` (a Cron Trigger) does the
 * provider call and the encoding. That split is what keeps the request path inside the free
 * plan's 10 ms CPU budget.
 */

import { loadConfig, type Env as ConfigEnv } from '../core/config.ts';
import { handleRequest } from '../http/router.ts';
import { refreshAll } from '../refresh.ts';
import { KvStorage, type KvBindings } from '../storage/kv.ts';
import { R2KvStorage } from '../storage/r2-kv.ts';
import type { Storage } from '../storage/types.ts';

type WorkerEnv = KvBindings & Partial<{ R2_INDEX: R2Bucket }> & ConfigEnv;

/**
 * KV alone by default, so the Deploy button works on a free account: R2 has a free tier but is
 * behind a subscription step, and provisioning fails without it. Bind R2_INDEX and this picks it
 * up with no code change -- worth doing if you outgrow 1,000 KV writes/day.
 */
function createStorage(env: WorkerEnv): Storage {
  return env.R2_INDEX ? new R2KvStorage({ ...env, R2_INDEX: env.R2_INDEX }) : new KvStorage(env);
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const config = loadConfig(env);
    const storage = createStorage(env);
    try {
      return await handleRequest(request, { config, storage });
    } catch (err) {
      console.error('request failed', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  },

  async scheduled(_event: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const config = loadConfig(env);
    const storage = createStorage(env);
    ctx.waitUntil(
      refreshAll(config, storage).then((results) => {
        for (const r of results) {
          const line = `${r.country}@${r.mapVersion}: ${r.status}${r.detail ? ` (${r.detail})` : ''}`;
          if (r.status === 'failed') console.error(line);
          else console.log(line, r.coloredSegments !== undefined ? `${r.coloredSegments}/${r.segmentCount}` : '');
        }
      }),
    );
  },
};
