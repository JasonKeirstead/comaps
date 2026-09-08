/**
 * Request routing. Runtime-agnostic: it takes a Request and returns a Response, so the
 * Cloudflare fetch handler and the Node server share it exactly.
 *
 * Client-facing paths are matched from the *end* of the URL, because the operator chooses the
 * mount point -- TRAFFIC_DATA_BASE_URL might be "https://host/traffic/" or just "https://host/".
 * The client builds `{base}{version}/{urlencoded country}.traffic`, and omits the version
 * segment entirely when the MWM version is 0.
 */

import { isAdmin, isAuthorized } from '../core/auth.ts';
import type { Config } from '../core/config.ts';
import { etagMatches } from '../core/etag.ts';
import { createPairingToken, listDevices, pairingUri, redeemPairingToken, revokeDevice } from '../core/pairing.ts';
import { parseTrafficIndex } from '../core/index/format.ts';
import type { Storage } from '../storage/types.ts';

export interface RouterContext {
  config: Config;
  storage: Storage;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const text = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

interface TrafficRequest {
  country: string;
  /** null when the client omitted the version segment (MWM version 0). */
  mapVersion: number | null;
  wantsKeys: boolean;
}

/**
 * Parses `.../{version}/{name}.traffic` or `.../{name}.traffic`, with an optional `.keys`
 * suffix. The name is percent-decoded: url::UrlEncode escapes everything outside
 * [A-Za-z0-9-._~] byte by byte, so decodeURIComponent recovers the exact countries.txt name.
 */
export function parseTrafficPath(pathname: string): TrafficRequest | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  let last = segments[segments.length - 1];
  let wantsKeys = false;
  if (last.endsWith('.traffic.keys')) {
    wantsKeys = true;
    last = last.slice(0, -'.keys'.length);
  }
  if (!last.endsWith('.traffic')) return null;

  let country: string;
  try {
    country = decodeURIComponent(last.slice(0, -'.traffic'.length));
  } catch {
    return null;
  }
  if (!country) return null;

  const previous = segments[segments.length - 2];
  const mapVersion = previous !== undefined && /^\d+$/.test(previous) ? Number(previous) : null;
  return { country, mapVersion, wantsKeys };
}

export async function handleRequest(request: Request, ctx: RouterContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/healthz') return await handleHealth(ctx);
  if (path === '/v1/pair' && request.method === 'POST') return await handlePair(request, ctx);
  if (path.startsWith('/admin/')) return await handleAdmin(request, ctx, path);

  const parsed = parseTrafficPath(path);
  if (!parsed) return text('Not Found', 404);
  if (request.method !== 'GET' && request.method !== 'HEAD') return text('Method Not Allowed', 405);

  if (!(await isAuthorized(ctx.config, ctx.storage, request))) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'www-authenticate': 'ApiKey' },
    });
  }

  return parsed.wantsKeys ? await handleKeys(ctx, parsed) : await handleValues(request, ctx, parsed);
}

/**
 * The 404 body must be a bare decimal integer -- the newest map version we hold data for.
 * TrafficInfo::ProcessFailure runs it through VERIFY(strings::to_int64(...)), which is a CHECK
 * in debug builds: any other body (JSON, HTML, even a trailing newline) aborts the app.
 *
 * Echoing the requested version back means "no data for this region", which is what we want
 * when we simply do not cover it. A *higher* version tells the client its map is stale.
 */
async function notFoundWithVersion(ctx: RouterContext, parsed: TrafficRequest): Promise<Response> {
  const known = await ctx.storage.indexVersions(parsed.country);
  const newest = known.length > 0 ? known[0] : (parsed.mapVersion ?? 0);
  return new Response(String(newest), {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/** Resolves the version to use, honouring the version-less request form. */
async function resolveVersion(ctx: RouterContext, parsed: TrafficRequest): Promise<number | null> {
  if (parsed.mapVersion !== null) return parsed.mapVersion;
  const known = await ctx.storage.indexVersions(parsed.country);
  return known.length > 0 ? known[0] : null;
}

async function handleKeys(ctx: RouterContext, parsed: TrafficRequest): Promise<Response> {
  const version = await resolveVersion(ctx, parsed);
  if (version === null) return await notFoundWithVersion(ctx, parsed);

  const raw = await ctx.storage.readIndex(parsed.country, version);
  if (!raw) return await notFoundWithVersion(ctx, parsed);

  const index = parseTrafficIndex(raw);
  return new Response(index.keysBlob as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      // The key set is immutable for a given (country, version): a new map release publishes
      // under a new version prefix.
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}

async function handleValues(request: Request, ctx: RouterContext, parsed: TrafficRequest): Promise<Response> {
  const version = await resolveVersion(ctx, parsed);
  if (version === null) return await notFoundWithVersion(ctx, parsed);

  const blob = await ctx.storage.readGenerated(parsed.country, version);
  if (!blob) return await notFoundWithVersion(ctx, parsed);

  if (etagMatches(request.headers.get('if-none-match'), blob.etag)) {
    // The client keeps the tag it sent, so we must keep honouring it.
    return new Response(null, { status: 304, headers: { etag: blob.etag } });
  }

  return new Response(blob.body as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      // Mandatory: the client only updates its stored tag from this header.
      etag: blob.etag,
      'cache-control': 'no-cache',
      'x-traffic-generated-at': new Date(blob.generatedAt).toISOString(),
      'x-traffic-colored-segments': String(blob.coloredSegments),
    },
  });
}

async function handlePair(request: Request, ctx: RouterContext): Promise<Response> {
  let body: { token?: string; device?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'expected a JSON body' }, 400);
  }

  const result = await redeemPairingToken(ctx.storage, body.token ?? '', body.device ?? '');
  if (!result.ok) return json({ error: result.reason }, result.status);

  return json({
    apiKey: result.apiKey,
    baseUrl: ctx.config.publicBaseUrl || new URL(request.url).origin + '/',
    serverName: ctx.config.serverName,
    deviceId: result.device.id,
    areas: ctx.config.areas,
    refreshSeconds: ctx.config.refreshSeconds,
  });
}

async function handleAdmin(request: Request, ctx: RouterContext, path: string): Promise<Response> {
  if (!isAdmin(ctx.config, request)) return json({ error: 'admin token required' }, 401);

  if (path === '/admin/pairing-token' && request.method === 'POST') {
    const { token, expiresIn } = await createPairingToken(ctx.storage);
    const base = ctx.config.publicBaseUrl || new URL(request.url).origin + '/';
    return json({ token, expiresIn, uri: pairingUri(base, token) });
  }

  if (path === '/admin/devices' && request.method === 'GET') {
    return json({ devices: await listDevices(ctx.storage) });
  }

  if (path.startsWith('/admin/devices/') && request.method === 'DELETE') {
    const id = path.slice('/admin/devices/'.length);
    return (await revokeDevice(ctx.storage, id))
      ? json({ revoked: id })
      : json({ error: 'no such device' }, 404);
  }

  return json({ error: 'not found' }, 404);
}

async function handleHealth(ctx: RouterContext): Promise<Response> {
  const now = Date.now();
  const areas = [];
  for (const area of ctx.config.areas) {
    const blob = await ctx.storage.readGenerated(area.country, area.mapVersion);
    const hasIndex = (await ctx.storage.readIndex(area.country, area.mapVersion)) !== null;
    areas.push({
      country: area.country,
      mapVersion: area.mapVersion,
      hasIndex,
      generatedAt: blob ? new Date(blob.generatedAt).toISOString() : null,
      ageSeconds: blob ? Math.round((now - blob.generatedAt) / 1000) : null,
      coloredSegments: blob?.coloredSegments ?? null,
    });
  }

  const budgetRaw = await ctx.storage.getState(`quota/${new Date().toISOString().slice(0, 10)}`);
  const used = budgetRaw ? Number(budgetRaw) : 0;

  // Stale beyond twice the refresh interval is worth flagging: the client treats data older
  // than six minutes as outdated.
  const stale = areas.some((a) => a.ageSeconds === null || a.ageSeconds > ctx.config.refreshSeconds * 2);

  return json(
    {
      status: stale ? 'degraded' : 'ok',
      refreshSeconds: ctx.config.refreshSeconds,
      providerRequestsToday: used,
      providerDailyBudget: ctx.config.dailyRequestBudget,
      areas,
    },
    stale ? 503 : 200,
  );
}
