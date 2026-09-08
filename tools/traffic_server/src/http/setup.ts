/**
 * The setup page: what you open in a browser straight after deploying.
 *
 * It exists because pairing used to mean inventing an admin token at deploy time, then running a
 * curl command against /admin/pairing-token, then turning the result into a QR code yourself.
 * Every one of those steps is something the person deploying has no way to know.
 *
 * Open while nothing is paired, admin-only afterwards. That is the router-setup model: the window
 * is from deploy until you scan, usually under a minute, and it closes by itself the moment the
 * first device pairs. The alternative -- a token the operator has to produce before anything
 * works -- is what made the deploy unusable in the first place.
 */

import QRCode from 'qrcode';

import { describeRefresh } from '../core/config.ts';
import { pairingUri } from '../core/pairing.ts';

export interface SetupPageData {
  serverName: string;
  baseUrl: string;
  pairingUri: string;
  /** A real device key, present only when one was explicitly asked for. */
  typedKey: string | null;
  adminToken: string;
  refreshSeconds: number;
  expiresInSeconds: number;
  /** Shown only the first time, when the operator still needs to be told to save it. */
  showAdminToken: boolean;
}

export async function pairingQrSvg(baseUrl: string, token: string): Promise<string> {
  // Error correction M and a quiet margin: this gets scanned off a laptop screen, sometimes at
  // an angle, by whatever camera the phone has.
  return await QRCode.toString(pairingUri(baseUrl, token), {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2,
  });
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Renders the page. Self-contained: no external CSS, fonts or scripts, so it works offline. */
export function renderSetupPage(data: SetupPageData, qrSvg: string): string {
  const minutes = Math.round(data.expiresInSeconds / 60);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair with ${escapeHtml(data.serverName)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --card: #fff; --ink: #14161a; --muted: #5b6270; --line: #dfe3ea;
    --accent: #1f6feb;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #14161a; --card: #1c1f26; --ink: #e9ecf1; --muted: #9aa3b2; --line: #2b303a; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px; background: var(--bg); color: var(--ink);
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 560px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 24px; }
  section {
    background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    padding: 20px; margin-bottom: 16px;
  }
  h2 { font-size: 15px; margin: 0 0 12px; }
  .qr { display: flex; justify-content: center; padding: 8px 0 16px; }
  .qr svg { width: 240px; height: 240px; background: #fff; border-radius: 8px; padding: 8px; }
  ol { margin: 0; padding-left: 20px; color: var(--muted); }
  ol li { margin-bottom: 4px; }
  dl { margin: 0; display: grid; grid-template-columns: 1fr; gap: 12px; }
  dt { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  dd {
    margin: 4px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
    word-break: break-all; background: var(--bg); border: 1px solid var(--line);
    border-radius: 8px; padding: 8px 10px;
  }
  .warn {
    border-left: 3px solid var(--accent); padding-left: 12px; color: var(--muted); font-size: 14px;
  }
  footer { color: var(--muted); font-size: 13px; text-align: center; margin-top: 24px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(data.serverName)}</h1>
  <p class="sub">Your traffic server is running. Pair a phone with it to start using it.</p>

  <section>
    <h2>Scan this in CoMaps</h2>
    <div class="qr">${qrSvg}</div>
    <ol>
      <li>On the phone: <strong>Settings &rarr; Advanced &rarr; Traffic server</strong></li>
      <li>Choose <strong>Scan QR code</strong></li>
      <li>Point it at this screen</li>
    </ol>
    <p class="warn">This code is single-use and expires in ${minutes} minutes. Reload the page for a new one.</p>
  </section>

  <section>
    <h2>Can&rsquo;t scan it?</h2>
    ${
      data.typedKey
        ? `<p class="sub" style="margin:0 0 12px">
             Choose <strong>Enter manually</strong> in the same menu and type these in.
           </p>
           <dl>
             <dt>Server address</dt><dd>${escapeHtml(data.baseUrl)}</dd>
             <dt>Key</dt><dd>${escapeHtml(data.typedKey)}</dd>
           </dl>
           <p class="warn">
             This key is live now, so this page has locked itself. Use the admin token to come back.
           </p>`
        : `<p class="sub" style="margin:0 0 12px">
             Get a key you can type into <strong>Enter manually</strong> instead. Doing so pairs a
             device immediately, which closes this page &mdash; so save the admin token below first.
           </p>
           <p><a href="?key=1">Show me a key to type in</a></p>`
    }
  </section>

  ${
    data.showAdminToken
      ? `<section>
    <h2>Save your admin token</h2>
    <p class="sub" style="margin:0 0 12px">
      This page stops being public the moment a phone pairs. To pair another one later, or to
      change settings, come back to <code>/setup?token=&hellip;</code> with this:
    </p>
    <dl><dt>Admin token</dt><dd>${escapeHtml(data.adminToken)}</dd></dl>
    <p class="warn">Shown here because it was generated for you. It is not shown again once a device is paired.</p>
  </section>`
      : ''
  }

  <footer>
    Refreshes at most every ${escapeHtml(describeRefresh(data.refreshSeconds))} per area, and only
    while someone is looking at the map.
  </footer>
</main>
</body>
</html>`;
}

/** The page shown once setup has closed and the caller did not present the admin token. */
export function renderLockedPage(serverName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(serverName)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 48px 16px; background: #f6f7f9; color: #14161a;
    font: 15px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: dark) { body { background: #14161a; color: #e9ecf1; } }
  main { max-width: 460px; margin: 0 auto; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<main>
  <h1>Already set up</h1>
  <p>A device is paired with this server, so this page is no longer public.</p>
  <p>To pair another one, open <code>/setup?token=YOUR_ADMIN_TOKEN</code> using the admin token
  you were shown when you first set this up.</p>
  <p>Lost it? Delete the <code>settings/adminToken</code> key from the Worker's KV namespace in
  the Cloudflare dashboard and reload; a new one will be generated.</p>
</main>
</body>
</html>`;
}
