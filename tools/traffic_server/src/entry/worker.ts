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
import { R2KvStorage, type CloudflareBindings } from '../storage/r2-kv.ts';

type WorkerEnv = CloudflareBindings & ConfigEnv;

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const config = loadConfig(env);
    const storage = new R2KvStorage(env);
    try {
      return await handleRequest(request, { config, storage });
    } catch (err) {
      console.error('request failed', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  },

  async scheduled(_event: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const config = loadConfig(env);
    const storage = new R2KvStorage(env);
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
