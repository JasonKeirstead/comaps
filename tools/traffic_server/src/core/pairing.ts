/**
 * QR pairing.
 *
 * Two phases on purpose. The QR carries a short-lived, single-use token rather than the API key
 * itself, so the code can be displayed on a screen (or printed) without the long-lived secret
 * ever being visible, and so an individual device can be revoked later. The provider key never
 * appears in any response -- only the refresh job ever sees it.
 *
 *   1. operator: POST /admin/pairing-token   -> token, 5 minute TTL
 *   2. QR:       comaps://traffic/pair?u=<base>&t=<token>
 *   3. phone:    POST /v1/pair {token}       -> apiKey + settings
 *
 * Only the SHA-256 of each secret is stored, so a leaked state store does not hand over
 * working credentials.
 */

import type { Storage } from '../storage/types.ts';

const PAIRING_TOKEN_TTL_SECONDS = 300;
const TOKEN_PREFIX = 'pair/';
const DEVICE_PREFIX = 'device/';

/** Crockford base32: no I, L, O or U, so codes survive being read aloud or retyped. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface DeviceRecord {
  id: string;
  name: string;
  pairedAt: number;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function encodeBase32(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 0x1f] + ALPHABET[(b >> 5) & 0x1f];
  return out.slice(0, Math.ceil((bytes.length * 8) / 5));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Length-independent comparison, so a mismatch does not leak where it happened. */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** Mints a single-use pairing token and returns the value to put in the QR. */
export async function createPairingToken(storage: Storage): Promise<{ token: string; expiresIn: number }> {
  const token = encodeBase32(randomBytes(16));
  await storage.putState(
    TOKEN_PREFIX + (await sha256Hex(token)),
    JSON.stringify({ createdAt: Date.now() }),
    PAIRING_TOKEN_TTL_SECONDS,
  );
  return { token, expiresIn: PAIRING_TOKEN_TTL_SECONDS };
}

export function pairingUri(baseUrl: string, token: string): string {
  const params = new URLSearchParams({ u: baseUrl, t: token });
  return `comaps://traffic/pair?${params.toString()}`;
}

export type PairResult =
  | { ok: true; apiKey: string; device: DeviceRecord }
  | { ok: false; status: 400 | 404 | 410; reason: string };

/**
 * Redeems a pairing token. The token is deleted before the device key is minted, so a token
 * raced by two devices can only ever succeed once.
 */
export async function redeemPairingToken(
  storage: Storage,
  token: string,
  deviceName: string,
): Promise<PairResult> {
  if (!token || token.length < 8) return { ok: false, status: 400, reason: 'malformed token' };

  const key = TOKEN_PREFIX + (await sha256Hex(token));
  const record = await storage.getState(key);
  if (!record) {
    // Expired and already-used tokens are indistinguishable here, which is fine: both mean
    // "ask the operator for a fresh code".
    return { ok: false, status: 410, reason: 'pairing code expired or already used' };
  }
  await storage.deleteState(key);

  const apiKey = encodeBase32(randomBytes(32));
  const device: DeviceRecord = {
    id: encodeBase32(randomBytes(6)),
    name: deviceName.slice(0, 120) || 'unnamed device',
    pairedAt: Date.now(),
  };
  await storage.putState(DEVICE_PREFIX + (await sha256Hex(apiKey)), JSON.stringify(device));

  return { ok: true, apiKey, device };
}

export async function isKnownDevice(storage: Storage, apiKey: string): Promise<boolean> {
  if (!apiKey) return false;
  return (await storage.getState(DEVICE_PREFIX + (await sha256Hex(apiKey)))) !== null;
}

export async function listDevices(storage: Storage): Promise<DeviceRecord[]> {
  const keys = await storage.listState(DEVICE_PREFIX);
  const out: DeviceRecord[] = [];
  for (const key of keys) {
    const raw = await storage.getState(key);
    if (raw) out.push(JSON.parse(raw) as DeviceRecord);
  }
  return out.sort((a, b) => b.pairedAt - a.pairedAt);
}

export async function revokeDevice(storage: Storage, deviceId: string): Promise<boolean> {
  for (const key of await storage.listState(DEVICE_PREFIX)) {
    const raw = await storage.getState(key);
    if (raw && (JSON.parse(raw) as DeviceRecord).id === deviceId) {
      await storage.deleteState(key);
      return true;
    }
  }
  return false;
}
