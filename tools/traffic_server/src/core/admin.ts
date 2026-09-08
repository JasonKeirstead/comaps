/**
 * The admin token, which the operator should never have to invent.
 *
 * TRAFFIC_ADMIN_TOKEN used to be a required secret, prompted for by the Deploy to Cloudflare
 * flow before the user had any idea what it was for. It is now optional: when unset, one is
 * generated on first use and kept in the state store.
 *
 * That means it is stored recoverably, unlike device keys, which are only ever kept as hashes.
 * The difference is deliberate -- this one has to be shown to the operator on the setup page,
 * because a value nobody can read is a value nobody can use to re-pair a second phone later.
 * It is readable only by this Worker and by whoever already controls the Cloudflare account.
 */

import { encodeBase32, randomBytes, timingSafeEqual } from './pairing.ts';
import type { Config } from './config.ts';
import type { Storage } from '../storage/types.ts';

const ADMIN_TOKEN_KEY = 'settings/adminToken';

/**
 * The token in force: the configured one if there is one, otherwise the generated one, minting
 * it on first call.
 */
export async function getAdminToken(storage: Storage, config: Config): Promise<string> {
  if (config.adminToken) return config.adminToken;

  const existing = await storage.getState(ADMIN_TOKEN_KEY);
  if (existing) return existing;

  const token = encodeBase32(randomBytes(20));
  await storage.putState(ADMIN_TOKEN_KEY, token);
  return token;
}

/**
 * Whether the request carries the admin token, as `Authorization: Bearer` or a `token` query
 * parameter.
 *
 * The query parameter is there for the setup page, which is opened by tapping a link in a
 * browser and cannot set a header.
 */
export async function isAdmin(storage: Storage, config: Config, request: Request): Promise<boolean> {
  const expected = config.adminToken || (await storage.getState(ADMIN_TOKEN_KEY));
  // Nothing configured and nothing generated yet: there is no token to match, so no request can
  // be admin. Minting one here would let an unauthenticated caller create the credential.
  if (!expected) return false;

  const header = request.headers.get('authorization') ?? '';
  const prefix = 'Bearer ';
  if (header.startsWith(prefix) && timingSafeEqual(header.slice(prefix.length), expected)) return true;

  const query = new URL(request.url).searchParams.get('token');
  return query !== null && timingSafeEqual(query, expected);
}
