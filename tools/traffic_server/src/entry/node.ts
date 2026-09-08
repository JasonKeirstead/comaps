/**
 * Self-hosted entry point: a plain node:http server.
 *
 * Same router and same refresh path as the Worker; only storage differs. There is no background
 * timer -- an area is refreshed by a client asking for it, so an idle service makes no provider
 * calls. `comaps-traffic refresh` is there for when you want one by hand.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describeRefresh, loadConfig, validateConfig } from '../core/config.ts';
import { handleRequest } from '../http/router.ts';
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


server.listen(port, host, () => {
  console.log(`CoMaps traffic service listening on http://${host}:${port}/`);
  console.log(`Areas: ${config.areas.map((a) => `${a.country}@${a.mapVersion}`).join(', ')}`);
  console.log(
    `Refresh: on request, at most every ${describeRefresh(config.refreshSeconds)} per area ` +
      '(changeable via PUT /admin/refresh-interval)',
  );
});
