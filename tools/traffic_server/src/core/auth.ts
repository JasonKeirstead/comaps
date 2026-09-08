/**
 * Request authentication.
 *
 * The client sends its key as `x-api-key` on both the values and the keys request
 * (libs/traffic/traffic_info.cpp attaches it via ApplyTrafficAuth). Note it sends the header
 * only when the setting is non-empty, so an unpaired app arrives anonymous.
 */

import type { Config } from './config.ts';
import { isKnownDevice, timingSafeEqual } from './pairing.ts';
import type { Storage } from '../storage/types.ts';

export async function isAuthorized(config: Config, storage: Storage, request: Request): Promise<boolean> {
  if (config.allowAnonymous) return true;

  const key = request.headers.get('x-api-key') ?? '';
  if (!key) return false;

  if (config.staticApiKey && timingSafeEqual(key, config.staticApiKey)) return true;
  return await isKnownDevice(storage, key);
}
