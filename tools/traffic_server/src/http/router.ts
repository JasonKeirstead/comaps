/**
 * Request routing. Runtime-agnostic: it takes a Request and returns a Response, so the
 * Cloudflare fetch handler and the Node server share it exactly.
 *
 * Client-facing paths are matched from the *end* of the URL, because the operator chooses the
 * mount point -- TRAFFIC_DATA_BASE_URL might be "https://host/traffic/" or just "https://host/".
 * The client builds `{base}{version}/{urlencoded country}.traffic`, and omits the version
 * segment entirely when the MWM version is 0.
 */

import { getAdminToken, isAdmin } from '../core/admin.ts';
import { isAuthorized } from '../core/auth.ts';
import type { Config } from '../core/config.ts';
import type { TrafficProvider } from '../core/providers/types.ts';
import { etagMatches } from '../core/etag.ts';
import { parseTrafficIndex } from '../core/index/format.ts';
import {
  createPairingToken,
  isKnownDevice,
  listDevices,
  pairingUri,
  redeemPairingToken,
  revokeDevice,
} from '../core/pairing.ts';
import { pairingQrSvg, renderLockedPage, renderSetupPage } from './setup.ts';
import { describeChoices, getRefresh, setRefresh } from '../core/settings.ts';
import { refreshArea } from '../refresh.ts';
import type { Storage } from '../storage/types.ts';

export interface RouterContext {
  config: Config;
  storage: Storage;
  /** Injected by tests; production builds one from the config on first use. */
  provider?: TrafficProvider;
}

/**
 * Upload ceiling. A 250k-segment index is about 4 MB; this leaves headroom without letting a
 * paired device fill the bucket.
 */
const MAX_INDEX_BYTES = 16 * 1024 * 1024;

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
  if (path === '/setup' || path === '/') return await handleSetup(request, ctx);
  if (path === '/v1/pair' && request.method === 'POST') return await handlePair(request, ctx);
  if (path === '/v1/index' && request.method === 'POST') return await handleIndexUpload(request, ctx);
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
 * Accepts a .cmti index built by a paired client from a map on its own device.
 *
 * Authenticated with the device's pairing key rather than the admin token: the phone already
 * holds one, and it means no cloud credential ever lives on the device. Indexes are per
 * (country, map version) and immutable, so an upload for a pair we already have is a no-op.
 */
async function handleIndexUpload(request: Request, ctx: RouterContext): Promise<Response> {
  const apiKey = request.headers.get('x-api-key') ?? '';
  const authorised =
    ctx.config.allowAnonymous ||
    (ctx.config.staticApiKey !== '' && apiKey === ctx.config.staticApiKey) ||
    (await isKnownDevice(ctx.storage, apiKey));
  if (!authorised) return json({ error: 'pair this device first' }, 401);

  const country = request.headers.get('x-traffic-country') ?? '';
  const mapVersion = Number(request.headers.get('x-traffic-map-version') ?? '0');
  if (!country || !Number.isInteger(mapVersion) || mapVersion <= 0) {
    return json({ error: 'x-traffic-country and x-traffic-map-version headers are required' }, 400);
  }

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length < 56) return json({ error: 'index too small to be valid' }, 400);
  if (body.length > MAX_INDEX_BYTES) {
    return json({ error: `index exceeds ${MAX_INDEX_BYTES} bytes` }, 413);
  }

  // Parse before storing: a corrupt index would otherwise fail later, inside the cron, where
  // nobody is watching.
  let parsed;
  try {
    parsed = parseTrafficIndex(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer);
  } catch (err) {
    return json({ error: `not a usable index: ${err instanceof Error ? err.message : String(err)}` }, 400);
  }

  if (parsed.mwmVersion !== mapVersion || parsed.countryName !== country) {
    return json(
      {
        error: `index is for ${parsed.countryName}@${parsed.mwmVersion}, headers say ${country}@${mapVersion}`,
      },
      400,
    );
  }

  const existing = await ctx.storage.readIndex(country, mapVersion);
  if (existing) {
    return json({ status: 'already-present', country, mapVersion, segments: parsed.segmentCount });
  }

  await ctx.storage.writeIndex(country, mapVersion, body);
  // Nothing else to register: the client's next poll for this area is what generates data for it.
  return json({ status: 'stored', country, mapVersion, segments: parsed.segmentCount });
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

  // This request is the trigger. If what we hold is still inside the chosen interval it comes
  // straight back; otherwise this call is what goes to the provider. Nothing refreshes an area
  // that nobody is asking for.
  const { blob, result } = await refreshArea(ctx.config, ctx.storage, parsed.country, version, ctx.provider);
  if (!blob) {
    if (result.status === 'failed' && result.detail) console.warn(`${parsed.country}@${version}: ${result.detail}`);
    return await notFoundWithVersion(ctx, parsed);
  }

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
      'x-traffic-refresh': result.status,
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
    refreshSeconds: (await getRefresh(ctx.storage, ctx.config)).seconds,
  });
}

async function handleAdmin(request: Request, ctx: RouterContext, path: string): Promise<Response> {
  if (!(await isAdmin(ctx.storage, ctx.config, request))) return json({ error: 'admin token required' }, 401);

  if (path === '/admin/pairing-token' && request.method === 'POST') {
    const { token, expiresIn } = await createPairingToken(ctx.storage);
    const base = ctx.config.publicBaseUrl || new URL(request.url).origin + '/';
    return json({ token, expiresIn, uri: pairingUri(base, token) });
  }

  if (path === '/admin/devices' && request.method === 'GET') {
    return json({ devices: await listDevices(ctx.storage) });
  }

  if (path === '/admin/refresh-interval' && request.method === 'GET') {
    const current = await getRefresh(ctx.storage, ctx.config);
    return json({ ...current, options: describeChoices(ctx.config) });
  }

  if (path === '/admin/refresh-interval' && request.method === 'PUT') {
    let body: { seconds?: number };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: 'expected a JSON body like {"seconds": 1800}' }, 400);
    }

    const result = await setRefresh(ctx.storage, ctx.config, Number(body.seconds));
    if (!result.ok) return json({ error: result.errors.join('; '), errors: result.errors }, result.status);
    return json({ seconds: result.seconds, source: 'override' });
  }

  if (path.startsWith('/admin/devices/') && request.method === 'DELETE') {
    const id = path.slice('/admin/devices/'.length);
    return (await revokeDevice(ctx.storage, id))
      ? json({ revoked: id })
      : json({ error: 'no such device' }, 404);
  }

  return json({ error: 'not found' }, 404);
}

/**
 * The page you open after deploying: a QR code to scan, and a way to get a typed key instead.
 *
 * Public until the first device pairs, then admin-only. See setup.ts for why that trade is the
 * right one -- a token the operator must invent before anything works is what this replaces.
 *
 * Rendering the page deliberately creates nothing. An earlier version minted a device key on
 * every view so it could always show one to type in, which meant the first page load locked the
 * page against its own reload. Getting a typed key is now an explicit `?key=1`, because being
 * handed a working credential is exactly the moment setup should close.
 */
async function handleSetup(request: Request, ctx: RouterContext): Promise<Response> {
  const html = (body: string, status = 200) =>
    new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

  const devices = await listDevices(ctx.storage);
  const admin = await isAdmin(ctx.storage, ctx.config, request);
  if (devices.length > 0 && !admin) return html(renderLockedPage(ctx.config.serverName), 403);

  const baseUrl = ctx.config.publicBaseUrl || new URL(request.url).origin + '/';
  // Minting the admin token here, rather than lazily elsewhere, is what lets the page show it
  // while the operator is still looking at the screen that explains what it is for.
  const adminToken = await getAdminToken(ctx.storage, ctx.config);
  const refresh = await getRefresh(ctx.storage, ctx.config);

  let typedKey: string | null = null;
  if (new URL(request.url).searchParams.get('key') === '1') {
    // Redeeming a token we just minted is the same path the phone takes, so the key is a real
    // device key that can be revoked individually.
    const minted = await createPairingToken(ctx.storage);
    const result = await redeemPairingToken(ctx.storage, minted.token, 'Typed in during setup');
    if (!result.ok) return html(renderLockedPage(ctx.config.serverName), 500);
    typedKey = result.apiKey;
  }

  const pairing = await createPairingToken(ctx.storage);
  const qrSvg = await pairingQrSvg(baseUrl, pairing.token);

  return html(
    renderSetupPage(
      {
        serverName: ctx.config.serverName,
        baseUrl,
        pairingUri: pairingUri(baseUrl, pairing.token),
        typedKey,
        adminToken,
        refreshSeconds: refresh.seconds,
        expiresInSeconds: pairing.expiresIn,
        // Only worth shouting about while it is still news, and only when we generated it.
        showAdminToken: devices.length === 0 && !ctx.config.adminToken,
      },
      qrSvg,
    ),
  );
}

async function handleHealth(ctx: RouterContext): Promise<Response> {
  const now = Date.now();
  const refresh = await getRefresh(ctx.storage, ctx.config);

  const areas = [];
  for (const area of ctx.config.areas) {
    const blob = await ctx.storage.readGenerated(area.country, area.mapVersion);
    const hasIndex = (await ctx.storage.readIndex(area.country, area.mapVersion)) !== null;
    const ageSeconds = blob ? Math.round((now - blob.generatedAt) / 1000) : null;
    areas.push({
      country: area.country,
      mapVersion: area.mapVersion,
      hasIndex,
      generatedAt: blob ? new Date(blob.generatedAt).toISOString() : null,
      ageSeconds,
      coloredSegments: blob?.coloredSegments ?? null,
      // Not a health signal. Data goes stale simply because nobody is looking at the area, and
      // the next request for it is what refreshes it.
      refreshOnNextRequest: ageSeconds === null || ageSeconds >= refresh.seconds,
    });
  }

  const budgetRaw = await ctx.storage.getState(`quota/${new Date().toISOString().slice(0, 10)}`);
  const used = budgetRaw ? Number(budgetRaw) : 0;

  // What actually stops this service working: an area we are asked about but hold no index for
  // (nothing can ever be generated), or a spent budget (refreshes are skipped until midnight).
  // Stale data is not a fault -- since refreshes are demand-driven, an idle service is stale by
  // design, and reporting that as degraded would make the signal useless.
  const missingIndex = areas.filter((a) => !a.hasIndex).map((a) => `${a.country}@${a.mapVersion}`);
  const budgetSpent = used >= ctx.config.dailyRequestBudget;

  const problems: string[] = [];
  if (missingIndex.length > 0) problems.push(`no index for ${missingIndex.join(', ')}; cover the area from the app`);
  if (budgetSpent) problems.push(`daily budget of ${ctx.config.dailyRequestBudget} spent; serving stored data until 00:00 UTC`);

  return json(
    {
      status: problems.length > 0 ? 'degraded' : 'ok',
      problems,
      refreshSeconds: refresh.seconds,
      refreshSource: refresh.source,
      refreshedOnDemand: true,
      providerRequestsToday: used,
      providerDailyBudget: ctx.config.dailyRequestBudget,
      areas,
    },
    problems.length > 0 ? 503 : 200,
  );
}
