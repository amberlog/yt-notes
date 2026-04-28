import { spawn, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

export const STORE_DIR = path.join(process.cwd(), 'store');
fs.mkdirSync(STORE_DIR, { recursive: true });

export type ProgressEvent = { type: 'log' | 'phase'; message: string };
export type ProgressFn = (e: ProgressEvent) => void;

let _ytDlpPath: string | null = null;

/**
 * Find yt-dlp executable. Resolution order:
 *   1. Bundled ./bin/yt-dlp(.exe)  -- preferred, populated by scripts/install-yt-dlp.mjs
 *   2. $YT_DLP_PATH env var
 *   3. where.exe / which (PATH lookup via shell)
 *   4. Manual PATH scan
 *   5. Well-known WinGet / scoop install dirs
 *   6. Bare 'yt-dlp' (will ENOENT if nothing else worked)
 */
function ytDlpExe(): string {
  if (_ytDlpPath) return _ytDlpPath;

  const isWin = process.platform === 'win32';
  const exeName = isWin ? 'yt-dlp.exe' : 'yt-dlp';

  // 1. Bundled in project
  const bundled = path.join(process.cwd(), 'bin', exeName);
  if (fs.existsSync(bundled)) {
    _ytDlpPath = bundled;
    return _ytDlpPath;
  }

  // 2. Env var override
  if (process.env.YT_DLP_PATH && fs.existsSync(process.env.YT_DLP_PATH)) {
    _ytDlpPath = process.env.YT_DLP_PATH;
    return _ytDlpPath;
  }

  if (!isWin) {
    _ytDlpPath = 'yt-dlp';
    return _ytDlpPath;
  }

  // 3. where.exe
  try {
    const r = spawnSync('where.exe', ['yt-dlp'], { encoding: 'utf-8', windowsHide: true });
    if (r.status === 0 && r.stdout) {
      const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const pickByExt = (re: RegExp) => lines.find((l) => re.test(l));
      const found = pickByExt(/\.exe$/i) || pickByExt(/\.cmd$/i) || pickByExt(/\.bat$/i) || lines[0];
      if (found && fs.existsSync(found)) {
        _ytDlpPath = found;
        return _ytDlpPath;
      }
    }
  } catch {
    // ignore
  }

  // 4. Manual PATH scan
  const pathEnv = process.env.PATH || process.env.Path || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const exts = ['.exe', '.cmd', '.bat', ''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, 'yt-dlp' + ext);
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
          _ytDlpPath = p;
          return _ytDlpPath;
        }
      } catch {
        // ignore
      }
    }
  }

  // 5. Well-known install locations
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const pkgRoot = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(pkgRoot)) {
    try {
      const candidates = fs.readdirSync(pkgRoot).filter((d) => /^yt-dlp\.yt-dlp/i.test(d));
      for (const dir of candidates) {
        const exe = path.join(pkgRoot, dir, 'yt-dlp.exe');
        if (fs.existsSync(exe)) {
          _ytDlpPath = exe;
          return _ytDlpPath;
        }
      }
    } catch {
      // ignore
    }
  }
  const scoopExe = path.join(os.homedir(), 'scoop', 'apps', 'yt-dlp', 'current', 'yt-dlp.exe');
  if (fs.existsSync(scoopExe)) {
    _ytDlpPath = scoopExe;
    return _ytDlpPath;
  }

  _ytDlpPath = 'yt-dlp';
  return _ytDlpPath;
}

export function normalizeChannel(input: string): { url: string; folder: string } {
  const trimmed = input.trim();
  let handle: string;

  const urlMatch = trimmed.match(/youtube\.com\/(@[A-Za-z0-9_.-]+)/);
  if (urlMatch) {
    handle = urlMatch[1];
  } else if (trimmed.startsWith('@')) {
    handle = trimmed;
  } else if (/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    handle = '@' + trimmed;
  } else {
    throw new Error('Cannot parse channel: ' + input);
  }

  const url = 'https://www.youtube.com/' + handle + '/videos';
  return { url, folder: handle };
}

function quoteArg(a: string): string {
  if (/^[A-Za-z0-9._:/=@,*~+-]+$/.test(a)) return a;
  return '"' + a.replace(/"/g, '\\"') + '"';
}

function runYtDlp(
  args: string[],
  onProgress?: ProgressFn,
  signal?: AbortSignal,
  idleTimeoutMs: number = 60_000,
): Promise<{ stdout: string; stderr: string; code: number; aborted: boolean }> {
  return new Promise((resolve) => {
    const exe = ytDlpExe();
    if (onProgress) {
      const cmd = [quoteArg(exe), ...args.map(quoteArg)].join(' ');
      onProgress({ type: 'log', message: '$ ' + cmd });
    }
    const child = spawn(exe, args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let idleTimer: NodeJS.Timeout | null = null;

    const killChild = (reason: string) => {
      if (aborted) return;
      aborted = true;
      onProgress?.({ type: 'log', message: '[yt-notes] ' + reason + ' -- killing yt-dlp' });
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    };

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => killChild('idle timeout (' + (idleTimeoutMs / 1000) + 's no output)'), idleTimeoutMs);
    };
    resetIdle();

    if (signal) {
      if (signal.aborted) {
        killChild('client disconnected');
      } else {
        signal.addEventListener('abort', () => killChild('client disconnected'), { once: true });
      }
    }

    child.stdout.on('data', (d) => {
      resetIdle();
      const s = d.toString();
      stdout += s;
      if (onProgress) {
        for (const line of s.split('\n')) {
          if (line.trim()) onProgress({ type: 'log', message: line });
        }
      }
    });
    child.stderr.on('data', (d) => {
      resetIdle();
      const s = d.toString();
      stderr += s;
      if (onProgress) {
        for (const line of s.split('\n')) {
          if (line.trim()) onProgress({ type: 'log', message: line });
        }
      }
    });
    child.on('error', (e) => {
      if (idleTimer) clearTimeout(idleTimer);
      resolve({ stdout, stderr: stderr + '\n' + e.message, code: 1, aborted });
    });
    child.on('close', (code) => {
      if (idleTimer) clearTimeout(idleTimer);
      resolve({ stdout, stderr, code: code ?? 1, aborted });
    });
  });
}

export async function checkYtDlp(): Promise<string> {
  try {
    const { stdout, code } = await runYtDlp(['--version']);
    if (code !== 0) throw new Error('yt-dlp returned non-zero');
    return stdout.trim() + '  (' + ytDlpExe() + ')';
  } catch (e: any) {
    throw new Error(
      'yt-dlp not found.\n' +
        'Run: npm run setup-bin   (downloads to ./bin/)\n' +
        'Or set YT_DLP_PATH=<full path>\n' +
        'Original error: ' + e.message,
    );
  }
}

export function isValidYmd(s: string): boolean {
  return /^\d{8}$/.test(s);
}

export type DownloadOptions = {
  account: string;
  sinceDate: string;
  minDurationSec?: number;
  playlistEnd?: number;
  onProgress?: ProgressFn;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
};

export type DownloadResult = {
  account: string;
  srtDir: string;
  videos: Array<{ id: string; title: string; uploadDate: string; srtPath: string | null }>;
};

export async function downloadChannelSubs(opts: DownloadOptions): Promise<DownloadResult> {
  const { url, folder } = normalizeChannel(opts.account);
  const srtDir = path.join(STORE_DIR, folder, 'srt');
  fs.mkdirSync(srtDir, { recursive: true });

  const minDuration = opts.minDurationSec ?? 300;
  const playlistEnd = opts.playlistEnd ?? 50;

  const outTemplate = path.join(srtDir, '%(upload_date)s_%(id)s_%(title).80s.%(ext)s');

  // Step 1: probe channel for metadata, let yt-dlp filter, print ONLY matches.
  // We don't use --flat-playlist because YouTube's channel listing doesn't include
  // upload_date there. We pay the cost of per-video metadata fetch but get accurate
  // filtering. --lazy-playlist + --break-match-filters lets yt-dlp short-circuit
  // once we hit an old video.
  opts.onProgress?.({
    type: 'phase',
    message:
      'Step 1: scanning channel for videos (>' + Math.round(minDuration / 60) +
      ' min & uploaded >= ' + opts.sinceDate + ', up to ' + playlistEnd + ' videos)...',
  });

  const probeArgs = [
    '--lazy-playlist',
    '--skip-download',
    '--no-write-subs',
    '--no-write-auto-subs',
    '--match-filter', 'duration > ' + minDuration + ' & upload_date >= ' + opts.sinceDate,
    '--break-match-filters', 'upload_date >= ' + opts.sinceDate,
    '--playlist-end', String(playlistEnd),
    '--no-warnings',
    '--print', '[match] %(id)s|%(upload_date)s|%(duration)s|%(title)s',
    url,
  ];
  const probeRes = await runYtDlp(probeArgs, opts.onProgress, opts.signal, opts.idleTimeoutMs);
  if (probeRes.aborted) throw new Error('yt-dlp aborted at probe step');

  type Meta = { id: string; uploadDate: string; duration: number; title: string };
  const matched: Meta[] = [];
  for (const line of probeRes.stdout.split('\n')) {
    const m = line.match(/^\[match\]\s+(.+)$/);
    if (!m) continue;
    const parts = m[1].split('|');
    if (!parts[0]) continue;
    matched.push({
      id: parts[0],
      uploadDate: parts[1] || '',
      duration: Number(parts[2]) || 0,
      title: parts.slice(3).join('|') || '',
    });
  }

  // If yt-dlp errored AND we got no matches, that's a real failure
  // (channel not found, network down, etc.) -- surface it instead of
  // silently returning "0 videos matched".
  if (matched.length === 0 && probeRes.code !== 0) {
    const tail = probeRes.stderr.trim().split('\n').slice(-3).join('\n').slice(0, 500);
    throw new Error(
      'yt-dlp probe failed (exit ' + probeRes.code + '). Last stderr:\n' + (tail || '(empty)'),
    );
  }

  opts.onProgress?.({
    type: 'phase',
    message: matched.length + ' videos matched the filter',
  });

  if (matched.length === 0) {
    return { account: folder, srtDir, videos: [] };
  }

  // Step 2: download subs for the exact list (no playlist iteration)
  opts.onProgress?.({
    type: 'phase',
    message: 'Step 2: downloading subtitles for ' + matched.length + ' videos...',
  });

  const videoUrls = matched.map((m) => 'https://www.youtube.com/watch?v=' + m.id);
  const downloadArgs = [
    '--write-subs', '--write-auto-subs',
    '--sub-lang', 'en.*',
    '--skip-download',
    '--ignore-errors',
    '--no-overwrites',
    '--output', outTemplate,
    '--print', 'after_video:[done] %(id)s|%(upload_date)s|%(title)s',
    ...videoUrls,
  ];
  const dlRes = await runYtDlp(downloadArgs, opts.onProgress, opts.signal, opts.idleTimeoutMs);
  if (dlRes.aborted) throw new Error('yt-dlp aborted at download step');

  const videos: DownloadResult['videos'] = [];
  const seen = new Set<string>();
  for (const line of dlRes.stdout.split('\n')) {
    const m = line.match(/^\[done\]\s+(.+)$/);
    if (!m) continue;
    const parts = m[1].split('|');
    const id = parts[0];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    let srtPath: string | null = null;
    if (fs.existsSync(srtDir)) {
      const found = fs.readdirSync(srtDir).find((f) => f.includes(id) && /\.(srt|vtt)$/i.test(f));
      if (found) srtPath = path.join(srtDir, found);
    }
    videos.push({ id, uploadDate: parts[1] || '', title: parts.slice(2).join('|'), srtPath });
  }

  // Fallback: if [done] didn't fire, scan dir
  if (videos.length === 0 && fs.existsSync(srtDir)) {
    for (const m of matched) {
      const found = fs.readdirSync(srtDir).find((f) => f.includes(m.id) && /\.(srt|vtt)$/i.test(f));
      if (!found) continue;
      videos.push({ id: m.id, uploadDate: m.uploadDate, title: m.title, srtPath: path.join(srtDir, found) });
    }
  }

  return { account: folder, srtDir, videos };
}

/** Extract video ID from any common YouTube URL form */
export function extractVideoId(url: string): string | null {
  const trimmed = url.trim();
  let m = trimmed.match(/youtu\.be\/([A-Za-z0-9_-]{6,20})/);
  if (m) return m[1];
  m = trimmed.match(/[?&]v=([A-Za-z0-9_-]{6,20})/);
  if (m) return m[1];
  m = trimmed.match(/\/shorts\/([A-Za-z0-9_-]{6,20})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  return null;
}

export type SingleVideoOptions = {
  videoUrl: string;
  onProgress?: ProgressFn;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
};

/**
 * Download subs for a single video URL. Auto-discovers the channel from yt-dlp
 * metadata so the file lands under store/@<uploader>/srt/ -- same folder shape
 * as channel-mode downloads.
 */
export async function downloadSingleVideo(opts: SingleVideoOptions): Promise<DownloadResult> {
  const id = extractVideoId(opts.videoUrl);
  if (!id) throw new Error('Cannot parse video ID from: ' + opts.videoUrl);

  const canonicalUrl = 'https://www.youtube.com/watch?v=' + id;

  const outTemplate = path.join(
    STORE_DIR,
    '%(uploader_id)s',
    'srt',
    '%(upload_date)s_%(id)s_%(title).80s.%(ext)s',
  );

  opts.onProgress?.({
    type: 'phase',
    message: 'Fetching subtitles for: ' + canonicalUrl,
  });

  const args = [
    '--write-subs',
    '--write-auto-subs',
    '--sub-lang', 'en.*',
    '--skip-download',
    '--ignore-errors',
    '--no-overwrites',
    '--no-warnings',
    '--output', outTemplate,
    '--print', 'after_video:[done] %(id)s|%(uploader_id)s|%(upload_date)s|%(title)s',
    canonicalUrl,
  ];

  const r = await runYtDlp(args, opts.onProgress, opts.signal, opts.idleTimeoutMs);
  if (r.aborted) throw new Error('yt-dlp was aborted');

  let resolvedAccount: string | null = null;
  let videoMeta: { id: string; uploadDate: string; title: string } | null = null;
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\[done\]\s+(.+)$/);
    if (!m) continue;
    const parts = m[1].split('|');
    videoMeta = {
      id: parts[0],
      uploadDate: parts[2] || '',
      title: parts.slice(3).join('|'),
    };
    resolvedAccount = parts[1] || null;
    break;
  }

  if (!resolvedAccount) {
    if (fs.existsSync(STORE_DIR)) {
      for (const accDir of fs.readdirSync(STORE_DIR)) {
        const srtDir = path.join(STORE_DIR, accDir, 'srt');
        if (!fs.existsSync(srtDir)) continue;
        const found = fs.readdirSync(srtDir).find((f) => f.includes(id) && /\.(srt|vtt)$/i.test(f));
        if (found) {
          resolvedAccount = accDir;
          break;
        }
      }
    }
  }

  if (!resolvedAccount) {
    throw new Error('Download produced no subtitle file (video has no English subs?)');
  }

  const srtDir = path.join(STORE_DIR, resolvedAccount, 'srt');
  const found = fs.existsSync(srtDir)
    ? fs.readdirSync(srtDir).find((f) => f.includes(id) && /\.(srt|vtt)$/i.test(f))
    : null;

  return {
    account: resolvedAccount,
    srtDir,
    videos: [
      {
        id,
        uploadDate: videoMeta?.uploadDate || '',
        title: videoMeta?.title || '',
        srtPath: found ? path.join(srtDir, found) : null,
      },
    ],
  };
}

/**
 * Remove redundant "<lang>-orig" subtitle files when a non-orig "<lang>" version
 * exists for the same video. Keeps disk clean.
 */
export function cleanupRedundantSubs(account: string): { deleted: string[] } {
  const folder = account.startsWith('@') ? account : '@' + account;
  const subDir = path.join(STORE_DIR, folder, 'srt');
  const deleted: string[] = [];
  if (!fs.existsSync(subDir)) return { deleted };

  const files = fs.readdirSync(subDir);
  for (const f of files) {
    const m = f.match(/^(.+?)\.([a-zA-Z-]+)-orig\.(vtt|srt)$/i);
    if (!m) continue;
    const [, baseName, lang, ext] = m;
    const primary = baseName + '.' + lang + '.' + ext;
    if (files.includes(primary)) {
      try {
        fs.unlinkSync(path.join(subDir, f));
        deleted.push(f);
      } catch {
        // ignore
      }
    }
  }
  return { deleted };
}

export function listAccountTxts(account: string): Array<{ name: string; size: number }> {
  const folder = account.startsWith('@') ? account : '@' + account;
  const txtDir = path.join(STORE_DIR, folder, 'txt');
  if (!fs.existsSync(txtDir)) return [];
  return fs.readdirSync(txtDir)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => ({ name: f, size: fs.statSync(path.join(txtDir, f)).size }));
}

export function listAccounts(): string[] {
  if (!fs.existsSync(STORE_DIR)) return [];
  return fs.readdirSync(STORE_DIR)
    .filter((d) => {
      try {
        return fs.statSync(path.join(STORE_DIR, d)).isDirectory();
      } catch {
        return false;
      }
    });
}

/**
 * Safety helper for path-traversal hardening. Resolves a child path inside
 * STORE_DIR and returns null if the resolved path escapes the store root.
 *
 * This is stricter than `startsWith(STORE_DIR)` because it resolves `..` and
 * symlinks, and ensures a directory boundary (so STORE_DIR + "-evil" doesn't
 * accidentally match).
 */
export function safeStorePath(...segments: string[]): string | null {
  const resolved = path.resolve(STORE_DIR, ...segments);
  const root = path.resolve(STORE_DIR);
  // Must be exactly the root or a child of it (with separator boundary)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }
  return resolved;
}
