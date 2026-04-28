import fs from 'fs';
import path from 'path';
import { STORE_DIR } from './yt';

/**
 * Parse SRT or VTT subtitle text into clean plain text.
 * Handles:
 *   - Sequence numbers
 *   - Timestamps (00:00:00,000 --> 00:00:05,000  OR  00:00:00.000 --> ...)
 *   - VTT-specific blocks (WEBVTT header, NOTE, STYLE) — skipped entirely
 *   - HTML/styling tags (<i>, <font>, <c.colorXXXXXX>, <v Speaker>)
 *   - Position/cue settings tags ({\an8}, "align:start position:19%")
 *   - Auto-subtitle line overlap (each cue extends previous by adding new words)
 */
export function parseSrt(input: string): string {
  // Split into cue blocks (separated by blank lines)
  const blocks = input.replace(/\r/g, '').split(/\n\n+/);
  const segments: string[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    let hasTimestamp = false;
    const textLines: string[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (/-->/.test(line)) {
        hasTimestamp = true;
        continue; // also strips VTT cue settings on the timestamp line
      }
      if (/^\d+$/.test(line)) continue; // sequence number
      textLines.push(line);
    }
    // Skip VTT WEBVTT header, NOTE blocks, STYLE blocks — anything without a timestamp
    if (!hasTimestamp || textLines.length === 0) continue;

    // Strip tags
    let text = textLines.join(' ');
    text = text.replace(/<[^>]+>/g, ''); // <i>, <font ...>, <c.color>, <v Speaker>
    text = text.replace(/\{\\[^}]+\}/g, ''); // ASS-style {\an8}
    text = text.replace(/\[(?:Music|Applause|Laughter|Background\s+\w+)\]/gi, '');
    text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    text = text.replace(/\s+/g, ' ').trim();
    if (text) segments.push(text);
  }

  // Smart dedupe — YouTube auto-subs emit overlapping cues like:
  //   "I think the"
  //   "I think the most important"
  //   "the most important thing is"
  let out = '';
  for (const seg of segments) {
    if (!seg) continue;

    const tailLen = Math.min(out.length, Math.max(seg.length * 2, 200));
    const tail = out.slice(-tailLen);
    if (tail.endsWith(seg)) continue;

    const maxOverlap = Math.min(seg.length, out.length, 200);
    let overlap = 0;
    for (let k = maxOverlap; k > 0; k--) {
      if (out.slice(-k) === seg.slice(0, k)) {
        overlap = k;
        break;
      }
    }
    if (overlap > 0) {
      out += seg.slice(overlap);
    } else {
      out += (out ? ' ' : '') + seg;
    }
    out = out.replace(/\s+/g, ' ');
  }

  return out.trim();
}

/**
 * Convert all subtitle files (.vtt or .srt) in store/@account/srt/
 * to .txt in store/@account/txt/. Prefer Chinese > English when multiple langs.
 */
export function srtDirToTxtDir(
  account: string,
  onProgress?: (idx: number, total: number, file: string) => void,
): string[] {
  const folder = account.startsWith('@') ? account : '@' + account;
  const subDir = path.join(STORE_DIR, folder, 'srt'); // (kept name for back-compat — holds .vtt/.srt)
  const txtDir = path.join(STORE_DIR, folder, 'txt');
  fs.mkdirSync(txtDir, { recursive: true });

  if (!fs.existsSync(subDir)) return [];

  const allSubs = fs.readdirSync(subDir).filter((f) => /\.(srt|vtt)$/i.test(f));

  // Group by video id (filename pattern: <date>_<id>_<title>.<lang>.{srt|vtt})
  type Group = { id: string; baseName: string; files: { lang: string; file: string }[] };
  const groups = new Map<string, Group>();
  for (const f of allSubs) {
    const m = f.match(/^(\d{8})_([A-Za-z0-9_-]{6,})_(.+?)\.([a-zA-Z-]+)\.(srt|vtt)$/i);
    if (!m) {
      const id = f;
      groups.set(id, { id, baseName: f.replace(/\.(srt|vtt)$/i, ''), files: [{ lang: '', file: f }] });
      continue;
    }
    const id = m[2];
    const lang = m[4];
    const baseName = f.replace(/\.[a-zA-Z-]+\.(srt|vtt)$/i, '');
    if (!groups.has(id)) groups.set(id, { id, baseName, files: [] });
    groups.get(id)!.files.push({ lang, file: f });
  }

  const langPriority = (lang: string): number => {
    const l = lang.toLowerCase();
    if (l.endsWith('-orig')) return 99; // auto-original = lowest priority
    if (l === 'en') return 0;
    if (l.startsWith('zh-hant') || l === 'zh-tw') return 1;
    if (l.startsWith('zh')) return 2;
    if (l.startsWith('en')) return 3;
    if (l) return 4;
    return 5;
  };

  const createdTxts: string[] = [];
  const groupArr = Array.from(groups.values());
  for (let i = 0; i < groupArr.length; i++) {
    const g = groupArr[i];
    g.files.sort((a, b) => langPriority(a.lang) - langPriority(b.lang));
    const chosen = g.files[0];
    const subPath = path.join(subDir, chosen.file);
    const sub = fs.readFileSync(subPath, 'utf-8');
    const text = parseSrt(sub);

    const txtName = `${g.baseName}.txt`;
    const txtPath = path.join(txtDir, txtName);
    fs.writeFileSync(txtPath, text, 'utf-8');
    createdTxts.push(txtName);
    onProgress?.(i + 1, groupArr.length, txtName);
  }

  return createdTxts;
}
