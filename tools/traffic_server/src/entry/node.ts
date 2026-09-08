/**
 * Self-hosted entry point: a plain node:http server plus a refresh timer.
 *
 * Same router and same refresh job as the Worker; only storage and scheduling differ.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describeRefresh, loadConfig, REFRESH_TICK_SECONDS, validateConfig } from '../core/config.ts';
import { handleRequest } from '../http/router.ts';
import { refreshAll } from '../refresh.ts';
import { FsStorage } from '../storage/fs.ts';

const config = loadConfig(process.env);
const errors = validateConfig(config);
if (errors.length > 0) {
  console.error('Configuration problems:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const storage = new FsStorage(config.indexDir);
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';

/** node:http request -> WHATWG Request, so the router stays runtime-agnostic. */
async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    for await (const chunk of req) chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
    method: req.method,
    headers,
    body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
  });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const body = response.body ? Buffer.from(await response.arrayBuffer()) : null;
  res.end(body ?? undefined);
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      await send(res, await handleRequest(await toRequest(req), { config, storage }));
    } catch (err) {
      console.error('request failed', err);
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  })();
});

async function runRefresh(): Promise<void> {
  const results = await refreshAll(config, storage);
  for (const r of results) {
    const suffix = r.coloredSegments !== undefined ? ` ${r.coloredSegments}/${r.segmentCount} coloured` : '';
    const line = `[refresh] ${r.country}@${r.mapVersion}: ${r.status}${r.detail ? ` (${r.detail})` : ''}${suffix}`;
    if (r.status === 'failed') console.error(line);
    else console.log(line);
  }
}

server.listen(port, host, () => {
  console.log(`CoMaps traffic service listening on http://${host}:${port}/`);
  console.log(`Areas: ${config.areas.map((a) => `${a.country}@${a.mapVersion}`).join(', ')}`);
  console.log(`Refresh: every ${describeRefresh(config.refreshSeconds)} (changeable via PUT /admin/refresh-interval)`);
  void runRefresh();
  // Ticks at the same fixed cadence as the Worker's cron, and refreshAll decides whether the
  // chosen interval has elapsed. Timing the interval here instead would make the runtime setting
  // work on Cloudflare and not under Node, and would need a restart to take effect.
  setInterval(() => void runRefresh(), REFRESH_TICK_SECONDS * 1000);
});
