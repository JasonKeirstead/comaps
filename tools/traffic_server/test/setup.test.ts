/**
 * The setup page and the generated admin token.
 *
 * Both exist to remove things the person deploying cannot possibly know: an admin token they had
 * to invent before anything worked, and a pairing flow that needed curl and a QR generator. The
 * properties worth locking down are that viewing the page costs nothing, that it closes once a
 * device exists, and that the admin token is the way back in.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { getAdminToken, isAdmin } from '../src/core/admin.ts';
import { loadConfig, type Config } from '../src/core/config.ts';
import { listDevices } from '../src/core/pairing.ts';
import { handleRequest } from '../src/http/router.ts';
import type { GeneratedBlob, Storage } from '../src/storage/types.ts';

class MemoryStorage implements Storage {
  indexes = new Map<string, ArrayBuffer>();
  generated = new Map<string, GeneratedBlob>();
  state = new Map<string, string>();

  async readIndex(country: string, v: number) {
    return this.indexes.get(`${v}/${country}`) ?? null;
  }
  async writeIndex(country: string, v: number, body: Uint8Array) {
    this.indexes.set(
      `${v}/${country}`,
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    );
  }
  async indexVersions() {
    return [];
  }
  async readGenerated(country: string, v: number) {
    return this.generated.get(`${v}/${country}`) ?? null;
  }
  async writeGenerated(country: string, v: number, blob: GeneratedBlob) {
    this.generated.set(`${v}/${country}`, blob);
  }
  async getState(k: string) {
    return this.state.get(k) ?? null;
  }
  async putState(k: string, v: string) {
    this.state.set(k, v);
  }
  async deleteState(k: string) {
    this.state.delete(k);
  }
  async listState(prefix: string) {
    return [...this.state.keys()].filter((k) => k.startsWith(prefix));
  }
}

function ctxFor(overrides: Record<string, string> = {}) {
  const storage = new MemoryStorage();
  const config: Config = loadConfig({ TOMTOM_API_KEY: 'k', ...overrides });
  return { storage, config, ctx: { storage, config } };
}

const get = (path: string) => new Request(`http://server${path}`);

/** Text of the <dd> following a given <dt>, which is how the page presents each value. */
function field(html: string, label: string): string | null {
  const match = new RegExp(`<dt>${label}</dt><dd>([^<]*)</dd>`).exec(html.replace(/\n\s*/g, ''));
  return match ? match[1] : null;
}

test('a fresh deployment serves the setup page at / and at /setup', async () => {
  for (const path of ['/', '/setup']) {
    const { ctx } = ctxFor();
    const res = await handleRequest(get(path), ctx);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await res.text(), /<svg/, `${path} should carry a QR code`);
  }
});

test('viewing the page pairs nothing', async () => {
  const { storage, ctx } = ctxFor();

  await handleRequest(get('/'), ctx);
  await handleRequest(get('/'), ctx);

  // An earlier version minted a device key on every view so it could always show one to type in,
  // which meant the first page load locked the page against its own reload.
  assert.deepEqual(await listDevices(storage), []);
  const second = await handleRequest(get('/'), ctx);
  assert.equal(second.status, 200);
});

test('each view carries a different pairing code', async () => {
  const { ctx } = ctxFor();
  const first = await (await handleRequest(get('/'), ctx)).text();
  const second = await (await handleRequest(get('/'), ctx)).text();

  // Pairing tokens are single-use, so a reloaded page showing the spent one would be a dead end.
  const qr = (html: string) => /<path[^>]*d="([^"]*)"[^>]*\/>\s*<path[^>]*d="([^"]*)"/.exec(html.replace(/\n/g, ''))?.[2];
  assert.ok(qr(first));
  assert.notEqual(qr(first), qr(second));
});

test('asking for a typed key mints one, and that closes setup', async () => {
  const { storage, ctx } = ctxFor();

  const res = await handleRequest(get('/?key=1'), ctx);
  assert.equal(res.status, 200);
  const key = field(await res.text(), 'Key');
  assert.ok(key && key.length > 20, 'a real device key should be shown');

  assert.equal((await listDevices(storage)).length, 1);
  assert.equal((await handleRequest(get('/'), ctx)).status, 403);
});

test('a key from the page actually authorises a traffic request', async () => {
  const { ctx } = ctxFor();
  const key = field(await (await handleRequest(get('/?key=1'), ctx)).text(), 'Key');
  assert.ok(key);

  const authed = new Request('http://server/250628/Belarus.traffic', { headers: { 'x-api-key': key } });
  // 404 rather than 401: authorised, but this deployment holds no index for that area.
  assert.equal((await handleRequest(authed, ctx)).status, 404);
  assert.equal((await handleRequest(new Request('http://server/250628/Belarus.traffic'), ctx)).status, 401);
});

test('once locked, the admin token reopens the page and a wrong one does not', async () => {
  const { storage, config, ctx } = ctxFor();
  const token = await getAdminToken(storage, config);

  await handleRequest(get('/?key=1'), ctx);
  assert.equal((await handleRequest(get('/setup'), ctx)).status, 403);
  assert.equal((await handleRequest(get(`/setup?token=${token}`), ctx)).status, 200);
  assert.equal((await handleRequest(get('/setup?token=nope'), ctx)).status, 403);
});

test('the admin token is shown once, then not again', async () => {
  const { storage, config, ctx } = ctxFor();
  const token = await getAdminToken(storage, config);

  assert.equal(field(await (await handleRequest(get('/'), ctx)).text(), 'Admin token'), token);

  await handleRequest(get('/?key=1'), ctx);
  const reopened = await (await handleRequest(get(`/setup?token=${token}`), ctx)).text();
  assert.equal(field(reopened, 'Admin token'), null, 'whoever can reopen the page already has it');
});

test('the generated admin token is stable', async () => {
  const { storage, config } = ctxFor();
  const first = await getAdminToken(storage, config);
  assert.equal(await getAdminToken(storage, config), first);
  assert.ok(first.length >= 30, 'short enough to guess would defeat the point');
});

test('a configured admin token wins, and is never displayed', async () => {
  const { storage, config, ctx } = ctxFor({ TRAFFIC_ADMIN_TOKEN: 'chosen-by-hand' });

  assert.equal(await getAdminToken(storage, config), 'chosen-by-hand');
  // The operator picked it, so they have it already; printing it on a public page would be a leak.
  assert.equal(field(await (await handleRequest(get('/'), ctx)).text(), 'Admin token'), null);
});

test('no request can be admin before a token exists', async () => {
  const { storage, config } = ctxFor();
  // Minting on an unauthenticated check would let the caller create the credential it needs.
  assert.equal(await isAdmin(storage, config, get('/setup?token=anything')), false);
  assert.equal(storage.state.has('settings/adminToken'), false);
});

test('admin endpoints accept the generated token', async () => {
  const { storage, config, ctx } = ctxFor();
  const token = await getAdminToken(storage, config);

  const authed = new Request('http://server/admin/devices', { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await handleRequest(authed, ctx)).status, 200);
  assert.equal((await handleRequest(get('/admin/devices'), ctx)).status, 401);
});
