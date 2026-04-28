# yt-notes

Turn YouTube transcripts into structured notes with an LLM, all on your machine.

`yt-notes` is a small local-first web app that lets you pull subtitles from a YouTube channel (or a single video), feed selected transcripts to an LLM (DeepSeek by default), and save the resulting markdown notes into groups. You can later re-curate a group of notes into higher-level synthesis.

> This is a 7-day shipping exercise, not a polished product. The UI is plain HTML/JS, there are no tests, and rough edges remain. It works for the author's daily workflow; your mileage may vary.

---

## What it does

1. **Download subtitles** from either a YouTube channel handle (e.g. `@mkbhd`) with a since-date filter, or from a single video URL.
2. **Convert** subtitle files (VTT/SRT) into clean plain-text transcripts.
3. **Summarize** any subset of transcripts via the DeepSeek API (BYOK), using a customizable prompt.
4. **Organize** results into groups, then optionally re-curate multiple notes within a group into a synthesis note.

Everything is stored locally: a single SQLite file plus a per-account folder of subtitles and transcripts.

---

## Requirements

- **Node.js 22.5 or newer.** This project uses the built-in `node:sqlite` module, so no native compilation is needed.
- **A DeepSeek API key.** Get one at https://platform.deepseek.com/. The endpoint is OpenAI-compatible, so you can swap in OpenAI / Groq / any compatible provider by editing `src/lib/llm.ts`.
- **`yt-dlp`** is downloaded automatically into `./bin/` on first install (see below). No system-wide install needed.

---

## Install & run

```bash
git clone https://github.com/<your-handle>/yt-notes.git
cd yt-notes
npm install        # this also downloads the yt-dlp binary into ./bin/
npm run dev
```

Open http://localhost:3000, go to the **Settings** tab, paste your DeepSeek API key, then start using the **Process** tab.

If for any reason the auto-download fails, see "About yt-dlp" below.

---

## About `yt-dlp` (what it is, why it's here)

[`yt-dlp`](https://github.com/yt-dlp/yt-dlp) is an open-source command-line program (a fork of youtube-dl) for downloading video and subtitle data from YouTube and many other sites. `yt-notes` only invokes it to fetch **subtitle files** — it does not download video or audio.

**How `yt-notes` obtains the binary:**

- The `postinstall` script (`scripts/install-yt-dlp.mjs`) runs automatically on `npm install` and downloads the platform-appropriate binary directly from the official GitHub release at `https://github.com/yt-dlp/yt-dlp/releases/latest`:
  - Windows -> `yt-dlp.exe`
  - macOS (Intel + Apple Silicon) -> `yt-dlp_macos` (universal2 binary)
  - Linux x64 -> `yt-dlp_linux`
  - Linux arm64 -> `yt-dlp_linux_aarch64`
- The binary is placed at `./bin/yt-dlp` (or `bin/yt-dlp.exe` on Windows). It is **not** committed to this repo (see `.gitignore`).

**If the auto-download is blocked** (strict firewall, antivirus quarantine, unsupported architecture):

1. Download manually from https://github.com/yt-dlp/yt-dlp/releases/latest
2. Place the binary at `./bin/yt-dlp` (`./bin/yt-dlp.exe` on Windows)
3. On macOS/Linux: `chmod +x ./bin/yt-dlp`
4. Or set `YT_DLP_PATH=/full/path/to/yt-dlp` as an environment variable.

To re-download (e.g. to upgrade): `npm run setup-bin -- --force`.

---

## Usage

The Process tab walks you through four steps:

1. **Download subtitles.** Pick **Whole channel** mode (handle + since-date) or **Single video** mode (paste a URL). Subtitles land at `store/@<account>/srt/`.
2. **Pick transcripts.** After download, transcripts (`.txt`) appear under the account folder. Multi-select the ones you want to summarize. A token estimate is shown so you know if you're approaching the model's context limit.
3. **Summarize.** Optionally tweak the prompt, then run. The LLM result appears below.
4. **Save.** Download as `.md`, or save into a named group.

The **Groups** tab lets you organize, view, delete, and **re-curate** items: pick multiple notes within a group, supply a custom prompt, and produce a synthesis note that's grounded only in the selected source notes.

---

## Storage layout

Everything is local:

```
yt-notes/
  yt-notes.db                    # SQLite: settings, groups, items
  store/
    @<account>/
      srt/   <date>_<id>_<title>.<lang>.vtt    # raw subtitle files from yt-dlp
      txt/   <date>_<id>_<title>.txt           # cleaned plain text
```

The DB file is created automatically on first launch with sensible defaults seeded.

---

## Configuration

All settings live in the SQLite DB (table `settings`) and can be edited from the **Settings** tab:

| Setting | Purpose |
| --- | --- |
| `deepseek_api_key` | Your DeepSeek API key. Stays on your machine. |
| `deepseek_model`   | Model name. Defaults to `deepseek-chat` (DeepSeek V3). |
| `default_prompt`   | The system prompt used when you don't override it. |

Optional environment variables:

| Variable        | Purpose |
| ---             | --- |
| `PORT`          | HTTP port (default `3000`). |
| `YT_DLP_PATH`   | Override the yt-dlp binary path. |
| `YT_NOTES_DB`   | Override the SQLite DB path. |

---

## Limitations & caveats

- **No tests.** Not a single one.
- **No build step.** Frontend is plain HTML + a single `app.js` file.
- **Context truncation:** the safety limit is hard-coded to 60K tokens. Larger selections are truncated with a warning shown in the UI.
- **CJK token estimation is rough** (`~1.3 tokens/char`). Estimates are upper bounds.
- **No multi-user, no auth.** This is a localhost tool.
- **YouTube terms of service:** `yt-dlp` operates in a legal grey area. Personal small-scale use is generally fine, but **do not host this app on a public server** — YouTube will rate-limit or block the IP.
- **DeepSeek is a Chinese company.** Transcripts you summarize are sent to DeepSeek's servers in China. If that's a concern, swap `baseUrl` in `src/lib/llm.ts` to OpenAI / Groq / a self-hosted Llama / etc.

---

## Tech stack

- **Backend:** Node.js 22 + Express + native `node:sqlite`
- **Frontend:** vanilla HTML/JS, no framework, no build step
- **Subtitles:** `yt-dlp` for download, custom VTT/SRT parser (no `ffmpeg` dependency)
- **LLM:** DeepSeek chat completions (OpenAI-compatible)
- **TS hot reload:** `tsx watch`

---

## License

[MIT](./LICENSE) — use it however you like, no warranty. `yt-dlp` itself is licensed under the [Unlicense](https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE).
