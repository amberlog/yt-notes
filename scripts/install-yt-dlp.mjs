// Download yt-dlp binary into ./bin/ if not already present.
// Idempotent: skip if exists. Use `node scripts/install-yt-dlp.mjs --force` to re-download.
//
// Failure policy: this script is run from `postinstall`, so a network failure
// here would otherwise break `npm install` for users behind a firewall or
// installing offline. We exit 0 on failure with a clear message — the app's
// /api/health endpoint will surface the missing binary on first launch.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const binDir = path.join(projectRoot, 'bin');

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const arch = process.arch;

let assetName;
let exeName;
if (isWindows) {
  assetName = 'yt-dlp.exe';
  exeName = 'yt-dlp.exe';
} else if (isMac) {
  assetName = 'yt-dlp_macos';
  exeName = 'yt-dlp';
} else {
  // Linux: x64 standard, plus arm64
  assetName = arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
  exeName = 'yt-dlp';
}

const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName}`;
const target = path.join(binDir, exeName);
const partial = target + '.partial';
const force = process.argv.includes('--force');

if (fs.existsSync(target) && !force) {
  console.log(`[yt-dlp] already at ${target} — skipping. Use --force to re-download.`);
  process.exit(0);
}

fs.mkdirSync(binDir, { recursive: true });

// Clean any stale partial from a previous failed run
if (fs.existsSync(partial)) {
  try { fs.unlinkSync(partial); } catch { /* ignore */ }
}

console.log(`[yt-dlp] downloading ${url}`);
console.log(`[yt-dlp]   -> ${target}`);

// Fail-soft: any error below logs a manual-install hint and exits 0
// so `npm install` keeps going.
function bail(msg) {
  console.error(`[yt-dlp] ${msg}`);
  console.error(`[yt-dlp] manual install: download from ${url}`);
  console.error(`[yt-dlp]   and place at ${target}`);
  if (!isWindows) console.error(`[yt-dlp]   then: chmod +x "${target}"`);
  // Clean up half-written file
  if (fs.existsSync(partial)) {
    try { fs.unlinkSync(partial); } catch { /* ignore */ }
  }
  process.exit(0);
}

// 60s timeout for the whole download
const TIMEOUT_MS = 60_000;
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

try {
  const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
  if (!res.ok) {
    bail(`HTTP ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    bail('response had no body');
  }
  const total = Number(res.headers.get('content-length') || 0);

  // Stream to a .partial file, then atomically rename on success.
  // This avoids leaving a half-written executable that subsequent runs would
  // mistake for a valid install.
  const reader = res.body.getReader();
  const out = fs.createWriteStream(partial);

  // Surface stream errors (e.g. ENOSPC)
  out.on('error', (e) => bail(`write failed: ${e.message}`));

  let received = 0;
  let lastPct = -1;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!out.write(value)) {
      // Backpressure — wait for drain
      await new Promise((r) => out.once('drain', r));
    }
    received += value.length;
    if (total) {
      const pct = Math.floor((received / total) * 100);
      if (pct !== lastPct && pct % 10 === 0) {
        process.stdout.write(`[yt-dlp] ${pct}%  (${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB)\n`);
        lastPct = pct;
      }
    }
  }
  await new Promise((resolve, reject) => {
    out.end((err) => (err ? reject(err) : resolve()));
  });

  // Sanity check: did we actually receive a sensible amount?
  const partialSize = fs.statSync(partial).size;
  if (partialSize < 1_000_000) {
    bail(`downloaded file looks too small (${partialSize} bytes) — aborting`);
  }
  if (total && partialSize !== total) {
    bail(`downloaded ${partialSize} bytes but content-length said ${total} — aborting`);
  }

  // Atomic move into place
  fs.renameSync(partial, target);

  if (!isWindows) fs.chmodSync(target, 0o755);

  console.log(`[yt-dlp] done. ${(partialSize / 1e6).toFixed(1)} MB written.`);
} catch (e) {
  if (e.name === 'AbortError') {
    bail(`timed out after ${TIMEOUT_MS / 1000}s`);
  }
  bail(`download failed: ${e.message}`);
} finally {
  clearTimeout(timer);
}
