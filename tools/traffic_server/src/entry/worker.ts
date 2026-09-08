/**
 * Cloudflare Workers entry point.
 *
 * Just `fetch`. There is no Cron Trigger: an area is refreshed by a client asking for it, so a
 * service nobody is using makes no provider calls and costs nothing. Serving a stored body is
 * about a millisecond, and a refresh adds ~3.5 ms of encoding plus a provider call that is
 * network wait, not CPU -- comfortably inside the free plan's 10 ms CPU budget.
 */

import { loadConfig, type Env as ConfigEnv } from '../core/config.ts';
import { handleRequest } from '../http/router.ts';
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
};
