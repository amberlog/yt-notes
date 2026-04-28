import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { db, getSetting, setSetting, tx, rowidToNum } from './db';
import {
  STORE_DIR,
  checkYtDlp,
  cleanupRedundantSubs,
  downloadChannelSubs,
  downloadSingleVideo,
  isValidYmd,
  listAccountTxts,
  listAccounts,
  normalizeChannel,
  safeStorePath,
} from './lib/yt';
import { srtDirToTxtDir } from './lib/srt';
import { callDeepSeek } from './lib/llm';

const app = express();
app.use(express.json({ limit: '20mb' }));

// ---------- Frontend ----------
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- Health / yt-dlp check ----------
app.get('/api/health', async (_req, res) => {
  let ytdlp: string | null = null;
  let ytdlpError: string | null = null;
  try {
    ytdlp = await checkYtDlp();
  } catch (e: any) {
    ytdlpError = e.message;
  }
  res.json({ ok: true, ytdlp, ytdlpError });
});

// ---------- Settings ----------
app.get('/api/settings', (_req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  res.json(out);
});

app.post('/api/settings', (req, res) => {
  const data = req.body || {};
  tx(() => {
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string') setSetting(k, v);
    }
  });
  res.json({ ok: true });
});

// ---------- Groups ----------
app.get('/api/groups', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT g.id, g.name, g.created_at,
              (SELECT COUNT(*) FROM items WHERE group_id = g.id) AS item_count
         FROM groups g
        ORDER BY g.created_at DESC`,
    )
    .all();
  res.json(rows);
});

app.post('/api/groups', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const info = db.prepare('INSERT INTO groups (name) VALUES (?)').run(name);
    res.json({ id: rowidToNum(info.lastInsertRowid), name });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/groups/:id', (req, res) => {
  db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Items ----------
app.get('/api/items', (req, res) => {
  const groupId = req.query.group_id;
  let rows;
  if (groupId === 'null' || groupId === '0') {
    rows = db.prepare('SELECT * FROM items WHERE group_id IS NULL ORDER BY created_at DESC').all();
  } else if (groupId) {
    rows = db
      .prepare('SELECT * FROM items WHERE group_id = ? ORDER BY created_at DESC')
      .all(Number(groupId));
  } else {
    rows = db.prepare('SELECT * FROM items ORDER BY created_at DESC').all();
  }
  res.json(rows);
});

app.post('/api/items', (req, res) => {
  const { group_id, title, yt_account, source_videos, prompt_used, result_text } = req.body || {};
  if (!title || !result_text) return res.status(400).json({ error: 'title and result_text required' });
  const info = db
    .prepare(
      `INSERT INTO items (group_id, title, yt_account, source_videos, prompt_used, result_text)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      group_id || null,
      title,
      yt_account || null,
      JSON.stringify(source_videos || []),
      prompt_used || null,
      result_text,
    );
  res.json({ id: rowidToNum(info.lastInsertRowid) });
});

app.patch('/api/items/:id', (req, res) => {
  const { group_id, title } = req.body || {};
  if (group_id !== undefined) {
    db.prepare('UPDATE items SET group_id = ? WHERE id = ?').run(group_id || null, req.params.id);
  }
  if (title !== undefined) {
    db.prepare('UPDATE items SET title = ? WHERE id = ?').run(title, req.params.id);
  }
  res.json({ ok: true });
});

app.delete('/api/items/:id', (req, res) => {
  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Store browsing ----------
app.get('/api/store', (_req, res) => {
  res.json(listAccounts());
});

app.get('/api/store/:account/txt', (req, res) => {
  res.json(listAccountTxts(req.params.account));
});

app.get('/api/store/:account/txt/:file', (req, res) => {
  const folder = req.params.account.startsWith('@') ? req.params.account : '@' + req.params.account;
  const p = safeStorePath(folder, 'txt', req.params.file);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
  res.type('text/plain; charset=utf-8').send(fs.readFileSync(p, 'utf-8'));
});

// ---------- Cancel in-flight download ----------
let activeDownload: AbortController | null = null;

app.post('/api/download/cancel', (_req, res) => {
  if (activeDownload) {
    activeDownload.abort();
    activeDownload = null;
    return res.json({ ok: true, cancelled: true });
  }
  res.json({ ok: true, cancelled: false });
});

// ---------- Download + parse pipeline (SSE) ----------
app.post('/api/download', async (req, res) => {
  const account = String(req.body?.account || '').trim();
  const sinceDate = String(req.body?.sinceDate || '').trim();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Track this download globally so /api/download/cancel can abort it
  if (activeDownload) {
    try { activeDownload.abort(); } catch { /* ignore */ }
  }
  const ctrl = new AbortController();
  activeDownload = ctrl;

  try {
    if (!account) throw new Error('account is required');
    if (!isValidYmd(sinceDate)) throw new Error('sinceDate must be YYYYMMDD (8 digits)');

    await checkYtDlp();
    const { folder } = normalizeChannel(account);

    send('phase', { stage: 'download', message: `Downloading subs for ${folder} (since ${sinceDate})...` });

    const result = await downloadChannelSubs({
      account,
      sinceDate,
      signal: ctrl.signal,
      onProgress: (e) => {
        if (e.type === 'phase') send('phase', { stage: 'download', message: e.message });
        else send('log', { line: e.message });
      },
    });

    const cleaned = cleanupRedundantSubs(result.account);
    if (cleaned.deleted.length > 0) {
      send('log', { line: `[yt-notes] cleaned up ${cleaned.deleted.length} redundant -orig files` });
    }

    send('phase', {
      stage: 'parse',
      message: `Subtitles downloaded (${result.videos.length} videos). Converting to plain text...`,
      total: result.videos.length,
    });

    const txtFiles = srtDirToTxtDir(result.account, (idx, total, file) => {
      send('parse', { idx, total, file });
    });

    send('done', {
      account: result.account,
      videos: result.videos,
      txtFiles,
    });
    if (activeDownload === ctrl) activeDownload = null;
    res.end();
  } catch (e: any) {
    send('error', { message: e.message });
    if (activeDownload === ctrl) activeDownload = null;
    res.end();
  }
});

// ---------- Single video download (SSE) ----------
app.post('/api/download-video', async (req, res) => {
  const videoUrl = String(req.body?.videoUrl || '').trim();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  if (activeDownload) {
    try { activeDownload.abort(); } catch { /* ignore */ }
  }
  const ctrl = new AbortController();
  activeDownload = ctrl;

  try {
    if (!videoUrl) throw new Error('videoUrl is required');

    await checkYtDlp();

    send('phase', { stage: 'download', message: 'Fetching video subtitles...' });

    const result = await downloadSingleVideo({
      videoUrl,
      signal: ctrl.signal,
      onProgress: (e) => {
        if (e.type === 'phase') send('phase', { stage: 'download', message: e.message });
        else send('log', { line: e.message });
      },
    });

    const cleaned = cleanupRedundantSubs(result.account);
    if (cleaned.deleted.length > 0) {
      send('log', { line: `[yt-notes] cleaned up ${cleaned.deleted.length} redundant -orig files` });
    }

    send('phase', {
      stage: 'parse',
      message: `Download complete (${result.account}). Converting to plain text...`,
      total: result.videos.length,
    });

    const txtFiles = srtDirToTxtDir(result.account, (idx, total, file) => {
      send('parse', { idx, total, file });
    });

    send('done', {
      account: result.account,
      videos: result.videos,
      txtFiles,
    });
    if (activeDownload === ctrl) activeDownload = null;
    res.end();
  } catch (e: any) {
    send('error', { message: e.message });
    if (activeDownload === ctrl) activeDownload = null;
    res.end();
  }
});

// ---------- LLM process (SSE) ----------
app.post('/api/process', async (req, res) => {
  const { account, files, prompt } = req.body || {};

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    if (!account || !Array.isArray(files) || files.length === 0) {
      throw new Error('account and files required');
    }
    const apiKey = getSetting('deepseek_api_key');
    if (!apiKey) throw new Error('DeepSeek API key is not set (configure it in the Settings tab)');

    const folder = String(account).startsWith('@') ? String(account) : '@' + account;
    const txtDir = path.join(STORE_DIR, folder, 'txt');

    send('phase', { stage: 'context', message: `Reading ${files.length} .txt transcript file(s) (not the raw vtt)...` });
    send('log', { line: `[server] reading from: ${txtDir}` });

    let context = '';
    let totalChars = 0;
    for (const f of files) {
      const p = safeStorePath(folder, 'txt', String(f));
      if (!p) {
        send('log', { line: `[server] rejected (path traversal): ${f}` });
        continue;
      }
      if (!fs.existsSync(p)) {
        send('log', { line: `[server] missing: ${f}` });
        continue;
      }
      const body = fs.readFileSync(p, 'utf-8');
      totalChars += body.length;
      send('log', { line: `[server] read ${f} (${body.length.toLocaleString()} chars)` });
      context += `\n\n===== ${f} =====\n${body}`;
    }
    context = context.trim();
    if (!context) throw new Error('No content found in selected files');
    send('log', { line: `[server] total ${totalChars.toLocaleString()} chars — sending to DeepSeek` });

    const usedPrompt = (typeof prompt === 'string' && prompt.trim()) || getSetting('default_prompt') || '';
    const model = getSetting('deepseek_model') || 'deepseek-chat';

    send('phase', { stage: 'llm', message: `Calling DeepSeek (${model})... (context ${context.length} chars)` });

    const { text, truncated } = await callDeepSeek({
      apiKey,
      model,
      prompt: usedPrompt,
      context,
    });

    send('phase', { stage: 'done', message: 'Done' });
    send('result', {
      text,
      prompt: usedPrompt,
      truncated,
      account: folder,
      sourceFiles: files,
    });
    res.end();
  } catch (e: any) {
    send('error', { message: e.message });
    res.end();
  }
});

// ---------- Re-curate — JSON, no SSE ----------
app.post('/api/curate', async (req, res) => {
  const { itemIds, prompt } = req.body || {};
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return res.status(400).json({ error: 'itemIds required' });
  }
  const apiKey = getSetting('deepseek_api_key');
  if (!apiKey) return res.status(400).json({ error: 'DeepSeek API key is not set' });

  // Normalize ids — make sure they're numbers (frontend sometimes sends strings)
  const cleanIds = itemIds
    .map((x: unknown) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (cleanIds.length === 0) return res.status(400).json({ error: 'no valid itemIds after coercion' });

  const placeholders = cleanIds.map(() => '?').join(',');
  const items = db
    .prepare(`SELECT id, title, result_text FROM items WHERE id IN (${placeholders})`)
    .all(...cleanIds) as { id: number; title: string; result_text: string }[];

  if (items.length === 0) return res.status(404).json({ error: 'no items found for ids: ' + cleanIds.join(',') });

  // Build context — explicit about which item is which
  const context = items
    .map((i, idx) => `===== Note ${idx + 1} (DB id=${i.id}): ${i.title} =====\n${i.result_text || '(empty)'}`)
    .join('\n\n');

  // Diagnostic dump
  const itemSummary = items.map((i) => ({
    id: i.id,
    title: i.title,
    resultLength: (i.result_text || '').length,
  }));
  console.log('[curate] requested ids:', cleanIds, 'fetched:', itemSummary, 'context length:', context.length);

  const usedPrompt =
    (typeof prompt === 'string' && prompt.trim()) ||
    `Below are multiple curated notes. Synthesize them: identify shared themes across notes, points of disagreement, and combined takeaways.\n` +
    `Important: your output must be grounded entirely in the notes below. Do not introduce facts or claims that are not present in the source notes.\n` +
    `Output in markdown.`;

  try {
    const { text, truncated } = await callDeepSeek({
      apiKey,
      model: getSetting('deepseek_model') || 'deepseek-chat',
      prompt: usedPrompt,
      context,
    });
    res.json({
      text,
      prompt: usedPrompt,
      truncated,
      sourceItemIds: cleanIds,
      debug: {
        fetchedItems: itemSummary,
        contextLength: context.length,
        contextPreview: context.slice(0, 500) + (context.length > 500 ? '...[truncated preview]' : ''),
      },
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 404 ----------
app.use((req, res, next) => {
  // Don't 404 the SPA index — already handled by static. Only API routes hit this.
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'not found' });
  }
  next();
});

// ---------- Error handler ----------
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log('\n  yt-notes -> http://localhost:' + PORT + '\n');
});
  console.log('\n  yt-notes -> http://localhost:' + PORT + '\n');
});
