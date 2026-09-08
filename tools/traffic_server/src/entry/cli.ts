#!/usr/bin/env node
/**
 * Operator CLI for the self-hosted container.
 *
 *   comaps-traffic pair            mint a pairing code and print it as a QR
 *   comaps-traffic devices         list paired devices
 *   comaps-traffic revoke <id>     revoke one device
 *   comaps-traffic refresh         run a refresh now
 *   comaps-traffic check           validate configuration and indexes
 *
 * Works directly against the storage directory, so `docker exec <container> comaps-traffic pair`
 * needs no admin token and no network round trip. On Cloudflare, use the /admin endpoints
 * instead -- see the README.
 */

import QRCode from 'qrcode';
import { loadConfig, validateConfig } from '../core/config.ts';
import { parseTrafficIndex } from '../core/index/format.ts';
import { createPairingToken, listDevices, pairingUri, revokeDevice } from '../core/pairing.ts';
import { refreshAll } from '../refresh.ts';
import { FsStorage } from '../storage/fs.ts';

const config = loadConfig(process.env);
const storage = new FsStorage(config.indexDir);
const [command, ...args] = process.argv.slice(2);

function baseUrl(): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  console.error('TRAFFIC_PUBLIC_BASE_URL is not set; the phone will not know how to reach this server.');
  console.error('Set it to the URL the phone should use, e.g. http://192.168.1.50:8080/');
  process.exit(1);
}

async function pair(): Promise<void> {
  const base = baseUrl();
  const { token, expiresIn } = await createPairingToken(storage);
  const uri = pairingUri(base, token);

  console.log(await QRCode.toString(uri, { type: 'terminal', small: true }));
  console.log(`  Server : ${base}`);
  console.log(`  Code   : ${token}`);
  console.log(`  Expires: ${expiresIn / 60} minutes\n`);
  console.log('In CoMaps: Settings -> Advanced -> Traffic server -> Scan QR code.');
  console.log('The code is single use. Run this again for another device.');
}

async function check(): Promise<void> {
  const errors = validateConfig(config);
  for (const e of errors) console.error(`  ! ${e}`);

  for (const area of config.areas) {
    const raw = await storage.readIndex(area.country, area.mapVersion);
    if (!raw) {
      console.error(`  ! no index for ${area.country}@${area.mapVersion}`);
      continue;
    }
    try {
      const index = parseTrafficIndex(raw);
      const mismatch = index.mwmVersion !== area.mapVersion ? `  <-- built for ${index.mwmVersion}!` : '';
      console.log(
        `  ok ${area.country}@${area.mapVersion}: ${index.segmentCount} segments, ` +
          `${(index.keysBlob.length / 1024).toFixed(1)} KiB of keys${mismatch}`,
      );
    } catch (err) {
      console.error(`  ! ${area.country}@${area.mapVersion}: ${(err as Error).message}`);
    }
  }
  if (errors.length > 0) process.exit(1);
}

async function main(): Promise<void> {
  switch (command) {
    case 'pair':
      await pair();
      break;
    case 'devices': {
      const devices = await listDevices(storage);
      if (devices.length === 0) console.log('No paired devices.');
      for (const d of devices) console.log(`${d.id}  ${new Date(d.pairedAt).toISOString()}  ${d.name}`);
      break;
    }
    case 'revoke': {
      if (!args[0]) {
        console.error('usage: comaps-traffic revoke <device-id>');
        process.exit(1);
      }
      console.log((await revokeDevice(storage, args[0])) ? `Revoked ${args[0]}` : `No such device: ${args[0]}`);
      break;
    }
    case 'refresh': {
      for (const r of await refreshAll(config, storage)) {
        console.log(`${r.country}@${r.mapVersion}: ${r.status}${r.detail ? ` (${r.detail})` : ''}`);
      }
      break;
    }
    case 'check':
      await check();
      break;
    default:
      console.error('usage: comaps-traffic <pair|devices|revoke|refresh|check>');
      process.exit(1);
  }
}

void main();
