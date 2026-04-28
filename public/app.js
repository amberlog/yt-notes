// ============================================================
// yt-notes frontend — vanilla JS, no build
// ============================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------- Context limits (match src/lib/llm.ts) ----------
const MAX_TOKENS = 60_000;   // DeepSeek V3 input budget (64K - output reserve)

// Language-aware token estimator — DeepSeek BPE tokenizer typical ratios:
//   ASCII (English): ~4 chars per token
//   CJK (Chinese):   ~1.3 tokens per char  (each character is denser)
function tokensFromText(text) {
  if (!text) return 0;
  const cjkMatches = text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g);
  const cjk = cjkMatches ? cjkMatches.length : 0;
  const ascii = text.length - cjk;
  return Math.round(cjk * 1.3 + ascii * 0.25);
}

// When we only know file size in bytes (no content): pragmatic estimate.
// yt-notes downloads English subs only (`--sub-lang en.*` in yt.ts), so
// content is effectively ASCII: 1 char = 1 byte, ~0.25 tokens/char.
// (For mixed CJK content the actual rate is ~0.45 tokens/byte. If you
// manually drop non-English transcripts into store/, this estimate
// will under-count.)
function tokensFromBytes(bytes) {
  return Math.round(bytes * 0.25);
}

function loadBadgeTokens(tokens) {
  const pct = Math.round((tokens / MAX_TOKENS) * 100);
  let cls = 'ok', icon = '*';
  if (pct >= 100) { cls = 'err'; icon = '!'; }
  else if (pct >= 80) { cls = 'warn'; icon = '!'; }
  return `<span class="${cls}">${icon} ~${tokens.toLocaleString()} tokens (${pct}% of ${(MAX_TOKENS / 1000)}K limit)</span>`;
}

// ---------- API helpers ----------
const api = {
  get: (url) => fetch(url).then((r) => r.json()),
  post: (url, body) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  patch: (url, body) =>
    fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  del: (url) => fetch(url, { method: 'DELETE' }).then((r) => r.json()),
};

// SSE-over-fetch (since we need POST body)
function sse(url, body, handlers) {
  const ctrl = new AbortController();
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  })
    .then(async (r) => {
      if (!r.ok || !r.body) {
        const text = r.body ? await r.text() : '';
        handlers.error?.({ message: `HTTP ${r.status}: ${text || r.statusText}` });
        return;
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = 'message';
          let data = '';
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (data) {
            try {
              handlers[event]?.(JSON.parse(data));
            } catch (e) {
              console.error('SSE parse', e, data);
            }
          }
        }
      }
    })
    .catch((e) => handlers.error?.({ message: e.message }));
  return ctrl;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

// ---------- Toast notifications ----------
function toast(type, title, msg) {
  const wrap = $('#toasts');
  if (!wrap) { console.log('[' + type + ']', title, msg); return; }
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  const icon = type === 'ok' ? '*' : type === 'err' ? '!' : type === 'warn' ? '!' : 'i';
  el.innerHTML = `
    <div class="toast-icon">${icon}</div>
    <div class="toast-body">
      <div class="toast-title">${escapeHtml(title)}</div>
      ${msg ? `<div class="toast-msg">${escapeHtml(msg)}</div>` : ''}
    </div>
  `;
  el.addEventListener('click', () => removeToast(el));
  wrap.appendChild(el);
  // Auto-dismiss success/info after 4s; errors stay
  if (type !== 'err') setTimeout(() => removeToast(el), 4500);
}
function removeToast(el) {
  if (!el || !el.parentElement) return;
  el.classList.add('fadeout');
  setTimeout(() => el.remove(), 250);
}

// ---------- Step indicator ----------
function setStep(n) {
  // n = 1..4. Steps before n become 'done', step n is 'active', after are neutral.
  $$('.steps .step').forEach((el) => {
    const idx = Number(el.dataset.step);
    el.classList.remove('active', 'done');
    if (idx < n) el.classList.add('done');
    else if (idx === n) el.classList.add('active');
  });
  // Card focus state
  $$('.tab.active .card').forEach((c, i) => c.classList.toggle('focused', c.id === 'card-' + n));
}

// ---------- Status banner inside a progress container ----------
function setStatus(container, type, message) {
  if (!container) return;
  const icon = type === 'ok' ? '*' : type === 'err' ? '!' : type === 'warn' ? '!' : '...';
  let banner = container.querySelector('.status-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'status-banner';
    container.prepend(banner);
  }
  banner.className = 'status-banner ' + (type || 'info');
  banner.innerHTML = `<span class="icon">${icon}</span><span>${escapeHtml(message)}</span>`;
}
function ensureLog(container) {
  let log = container.querySelector('.log');
  if (!log) {
    log = document.createElement('pre');
    log.className = 'log';
    container.appendChild(log);
  }
  return log;
}
function clearProgress(container) {
  if (container) container.innerHTML = '';
}

// ---------- Mode tabs (channel / video) ----------
$$('.mode-tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    $$('.mode-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.mode-pane').forEach((p) => p.classList.toggle('active', p.id === 'mode-' + mode));
  });
});

// ---------- Tabs ----------
$$('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    $$('nav button').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${tab}`));
    if (tab === 'groups') loadGroups();
    if (tab === 'settings') loadSettings();
  });
});

// ---------- State ----------
const state = {
  currentAccount: null,
  selectedFiles: new Set(),
  lastResult: null,
  currentDownload: null,
};

// ---------- Health ----------
async function checkHealth() {
  try {
    const h = await api.get('/api/health');
    if (h.ytdlpError) {
      $('#health-banner').innerHTML = `<span class="banner err">! yt-dlp not found: ${escapeHtml(h.ytdlpError.split('\n')[0])}</span>`;
    } else if (h.ytdlp) {
      $('#health-banner').innerHTML = `<span class="banner ok">yt-dlp ${escapeHtml(h.ytdlp)}</span>`;
    }
    return h;
  } catch (e) {
    $('#health-banner').innerHTML = `<span class="banner err">Backend unreachable</span>`;
  }
}

// ============================================================
// Process tab
// ============================================================

// ----- Download form -----
$('#download-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const account = $('#account').value.trim();
  const sinceDate = $('#sinceDate').value.trim();
  if (!account || !sinceDate) {
    alert('Channel mode needs both YT handle and start date');
    return;
  }
  if (!/^\d{8}$/.test(sinceDate)) {
    alert('Start date must be 8 digits in YYYYMMDD format');
    return;
  }
  const prog = $('#download-progress');
  clearProgress(prog);
  setStatus(prog, 'info', 'Preparing...');
  const log = ensureLog(prog);
  $('#dl-btn').disabled = true;
  $('#dl-video-btn').disabled = true;
  $('#cancel-btn').style.display = '';
  setStep(1);

  state.currentDownload = sse(
    '/api/download',
    { account, sinceDate },
    {
      phase: (d) => setStatus(prog, 'info', d.message),
      log: (d) => {
        log.textContent += d.line + '\n';
        log.scrollTop = log.scrollHeight;
      },
      parse: (d) => setStatus(prog, 'info', `Converting to text ${d.idx}/${d.total} - ${d.file}`),
      done: async (d) => {
        const summary = `${d.videos.length} videos, ${d.txtFiles.length} transcript files generated`;
        setStatus(prog, 'ok', 'Download complete. ' + summary);
        toast('ok', 'Download complete', summary + ' (' + d.account + ')');
        state.currentAccount = d.account;
        $('#account').value = d.account;
        await loadStoreAccountPicker(d.account);
        loadStoreFiles(d.account);
        $('#dl-btn').disabled = false;
        $('#dl-video-btn').disabled = false;
        $('#cancel-btn').style.display = 'none';
        state.currentDownload = null;
        setStep(2);
      },
      error: (d) => {
        setStatus(prog, 'err', 'Error: ' + d.message);
        toast('err', 'Download failed', d.message);
        $('#dl-btn').disabled = false;
        $('#dl-video-btn').disabled = false;
        $('#cancel-btn').style.display = 'none';
        state.currentDownload = null;
      },
    },
  );
});

// Single video download form
$('#download-video-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const videoUrl = $('#videoUrl').value.trim();
  if (!videoUrl) return;

  const prog = $('#download-progress');
  clearProgress(prog);
  setStatus(prog, 'info', 'Preparing...');
  const log = ensureLog(prog);
  $('#dl-video-btn').disabled = true;
  $('#dl-btn').disabled = true;
  $('#cancel-btn').style.display = '';
  setStep(1);

  state.currentDownload = sse(
    '/api/download-video',
    { videoUrl },
    {
      phase: (d) => setStatus(prog, 'info', d.message),
      log: (d) => {
        log.textContent += d.line + '\n';
        log.scrollTop = log.scrollHeight;
      },
      parse: (d) => setStatus(prog, 'info', `Converting to text ${d.idx}/${d.total} - ${d.file}`),
      done: async (d) => {
        const summary = '1 video fetched (' + d.account + ')';
        setStatus(prog, 'ok', 'Download complete. ' + summary);
        toast('ok', 'Download complete', summary);
        state.currentAccount = d.account;
        $('#account').value = d.account;
        await loadStoreAccountPicker(d.account);
        loadStoreFiles(d.account);
        $('#dl-video-btn').disabled = false;
        $('#dl-btn').disabled = false;
        $('#cancel-btn').style.display = 'none';
        state.currentDownload = null;
        setStep(2);
      },
      error: (d) => {
        setStatus(prog, 'err', 'Error: ' + d.message);
        toast('err', 'Download failed', d.message);
        $('#dl-video-btn').disabled = false;
        $('#dl-btn').disabled = false;
        $('#cancel-btn').style.display = 'none';
        state.currentDownload = null;
      },
    },
  );
});

// Cancel in-flight download
$('#cancel-btn').addEventListener('click', async () => {
  // Tell the server to kill yt-dlp explicitly
  try { await fetch('/api/download/cancel', { method: 'POST' }); } catch {}
  // Then abort the SSE stream locally
  if (state.currentDownload) {
    state.currentDownload.abort();
    state.currentDownload = null;
  }
  $('#cancel-btn').style.display = 'none';
  $('#dl-btn').disabled = false;
  $('#dl-video-btn').disabled = false;
  const prog = $('#download-progress');
  setStatus(prog, 'warn', 'Cancelled');
  toast('warn', 'Download cancelled', '');
});

// ----- Store file picker -----
async function loadStoreAccountPicker(selectedAccount) {
  const accounts = await api.get('/api/store');
  const wrap = $('#store-account-picker');
  if (!accounts.length) {
    wrap.innerHTML = '';
    return;
  }
  const current = selectedAccount || state.currentAccount || '';
  wrap.innerHTML = `
    <div style="display:flex;align-items:center;flex-wrap:wrap;gap:.5rem;margin-bottom:.7rem">
      ${current ? `<span class="current-account">Viewing: ${escapeHtml(current)}</span>` : ''}
      <label class="inline" style="margin:0">
        Switch to:
        <select id="account-picker" style="min-width:180px">
          <option value="">- pick another account -</option>
          ${accounts.filter((a) => a !== current).map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('')}
        </select>
      </label>
    </div>
  `;
  $('#account-picker').addEventListener('change', async (e) => {
    if (e.target.value) {
      state.currentAccount = e.target.value;
      $('#account').value = e.target.value;
      await loadStoreAccountPicker(e.target.value);
      loadStoreFiles(e.target.value);
    }
  });
}

async function loadStoreFiles(account) {
  const folder = account.startsWith('@') ? account : '@' + account;
  const files = await api.get(`/api/store/${encodeURIComponent(folder)}/txt`);
  const wrap = $('#store-files');
  state.selectedFiles = new Set();
  $('#process-btn').disabled = true;

  if (!files.length) {
    wrap.innerHTML = '<em class="muted">(no transcripts for this account yet — download subtitles first)</em>';
    return;
  }
  wrap.innerHTML = `
    <div class="row">
      <button type="button" id="select-all" class="secondary small">Select all</button>
      <button type="button" id="select-none" class="secondary small">Clear</button>
      <span class="muted">${files.length} files</span>
    </div>
    <div class="file-list">
      ${files
        .map(
          (f) => `
        <label class="file-row">
          <input type="checkbox" data-file="${escapeHtml(f.name)}" data-size="${f.size}">
          <span class="filename">${escapeHtml(f.name)}</span>
          <span class="muted">${(f.size / 1024).toFixed(1)} KB</span>
          <a href="/api/store/${encodeURIComponent(folder)}/txt/${encodeURIComponent(f.name)}" target="_blank">view</a>
        </label>
      `,
        )
        .join('')}
    </div>
    <div id="selection-summary" class="muted" style="margin-top:.5rem;font-size:.85rem"></div>
  `;

  const onChange = () => {
    const checked = $$('#store-files input[type=checkbox]:checked');
    state.selectedFiles = new Set(checked.map((c) => c.dataset.file));
    $('#process-btn').disabled = state.selectedFiles.size === 0;
    // Compute load
    const totalBytes = checked.reduce((sum, c) => sum + Number(c.dataset.size || 0), 0);
    const summary = $('#selection-summary');
    if (summary) {
      if (state.selectedFiles.size === 0) {
        summary.innerHTML = '';
      } else {
        const tokens = tokensFromBytes(totalBytes);
        summary.innerHTML =
          `Selected ${state.selectedFiles.size} files (${(totalBytes / 1024).toFixed(0)} KB) - ` +
          loadBadgeTokens(tokens);
      }
    }
  };
  $$('#store-files input[type=checkbox]').forEach((c) => c.addEventListener('change', onChange));
  $('#select-all').addEventListener('click', () => {
    $$('#store-files input[type=checkbox]').forEach((c) => (c.checked = true));
    onChange();
  });
  $('#select-none').addEventListener('click', () => {
    $$('#store-files input[type=checkbox]').forEach((c) => (c.checked = false));
    onChange();
  });
}

// ----- Process (LLM) -----
$('#process-btn').addEventListener('click', () => {
  if (!state.currentAccount || state.selectedFiles.size === 0) return;

  // Pre-flight check — bytes-based estimate
  const totalBytes = $$('#store-files input[type=checkbox]:checked')
    .reduce((sum, c) => sum + Number(c.dataset.size || 0), 0);
  const estTokens = tokensFromBytes(totalBytes);
  const pct = Math.round((estTokens / MAX_TOKENS) * 100);
  if (pct >= 100) {
    if (!confirm(
      'Warning: selection is approximately ' + estTokens.toLocaleString() + ' tokens, ' +
      'over the ' + (MAX_TOKENS / 1000) + 'K token limit (' + pct + '%).\n\n' +
      'Excess content will be truncated (may be incomplete).\nSuggestion: pick fewer files, or summarize in batches.\n\nContinue anyway?'
    )) return;
  } else if (pct >= 80) {
    if (!confirm(
      'Near limit: selection is approximately ' + estTokens.toLocaleString() + ' tokens (' + pct + '% of 60K).\nContinue?'
    )) return;
  }

  const promptVal = $('#prompt').value.trim();
  const prog = $('#process-progress');
  clearProgress(prog);
  setStatus(prog, 'info', `Sending ${state.selectedFiles.size} .txt file(s) to DeepSeek...`);
  const log = ensureLog(prog);
  log.textContent = `[client] Will read these .txt files (store/${state.currentAccount}/txt/):\n` +
    Array.from(state.selectedFiles).map((f) => '  - ' + f).join('\n') + '\n';
  $('#result').textContent = '';
  $('#card-4').style.display = 'none';
  $('#process-btn').disabled = true;
  setStep(3);

  // Save prompt as default if user typed something
  if (promptVal) {
    api.post('/api/settings', { default_prompt: promptVal }).catch(() => {});
  }

  sse(
    '/api/process',
    {
      account: state.currentAccount,
      files: Array.from(state.selectedFiles),
      prompt: promptVal || undefined,
    },
    {
      phase: (d) => setStatus(prog, 'info', d.message),
      log: (d) => {
        log.textContent += d.line + '\n';
        log.scrollTop = log.scrollHeight;
      },
      result: async (d) => {
        state.lastResult = d;
        $('#result').textContent = d.text;
        $('#card-4').style.display = '';
        // Default title: @account + first video title (extracted from filename)
        const titleFromFile = (name) => {
          const m = String(name).match(/^\d{8}_[A-Za-z0-9_-]{6,}_(.+?)\.txt$/);
          return m ? m[1].trim() : String(name).replace(/\.txt$/, '');
        };
        const sel = Array.from(state.selectedFiles);
        let suggested = d.account;
        if (sel.length === 1) {
          suggested = `${d.account} - ${titleFromFile(sel[0])}`;
        } else if (sel.length > 1) {
          suggested = `${d.account} - ${titleFromFile(sel[0])} (+${sel.length - 1})`;
        }
        $('#save-title').value = suggested;
        await populateSaveGroups();
        if (d.truncated) {
          setStatus(prog, 'warn', '! Context was truncated, but processing finished.');
          toast('warn', 'Done (context truncated)', 'Consider selecting fewer transcripts');
        } else {
          setStatus(prog, 'ok', 'LLM summary complete');
          toast('ok', 'Summary complete', 'Result is shown — download .md or save to a group');
        }
        $('#process-btn').disabled = false;
        setStep(4);
      },
      error: (d) => {
        setStatus(prog, 'err', 'Error: ' + d.message);
        toast('err', 'Processing failed', d.message);
        $('#process-btn').disabled = false;
      },
    },
  );
});

async function populateSaveGroups() {
  const groups = await api.get('/api/groups');
  $('#save-group').innerHTML =
    '<option value="">(no group)</option>' +
    groups.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
}

$('#download-result').addEventListener('click', () => {
  if (!state.lastResult) return;
  const blob = new Blob([state.lastResult.text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.currentAccount}_${new Date().toISOString().slice(0, 10)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

$('#save-result').addEventListener('click', async () => {
  if (!state.lastResult) return;
  const title = $('#save-title').value.trim();
  if (!title) {
    alert('Please enter a title');
    return;
  }
  const groupId = $('#save-group').value || null;
  const r = await api.post('/api/items', {
    group_id: groupId ? Number(groupId) : null,
    title,
    yt_account: state.currentAccount,
    source_videos: Array.from(state.selectedFiles),
    prompt_used: state.lastResult.prompt,
    result_text: state.lastResult.text,
  });
  if (r.error) {
    $('#save-status').innerHTML = `<span class="err">${escapeHtml(r.error)}</span>`;
    toast('err', 'Save failed', r.error);
  } else {
    $('#save-status').innerHTML = `<span class="ok">Saved (id #${r.id})</span>`;
    toast('ok', 'Saved to group', 'See it in the Groups tab');
  }
});

// ============================================================
// Groups tab
// ============================================================

$('#group-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#group-name').value.trim();
  if (!name) return;
  const r = await api.post('/api/groups', { name });
  if (r.error) { toast('err', 'Failed to create group', r.error); return; }
  $('#group-name').value = '';
  toast('ok', 'Group created', name);
  loadGroups();
});

async function loadGroups() {
  const groups = await api.get('/api/groups');
  const ungrouped = await api.get('/api/items?group_id=null');
  const wrap = $('#groups-list');

  const renderItem = (i) => `
    <div class="item" data-id="${i.id}">
      <label class="item-head">
        <input type="checkbox" class="item-cb" data-id="${i.id}">
        <strong>${escapeHtml(i.title)}</strong>
        <small>${new Date(i.created_at * 1000).toLocaleString()}</small>
        ${i.yt_account ? `<small class="muted">@ ${escapeHtml(i.yt_account)}</small>` : ''}
      </label>
      <details>
        <summary>View content</summary>
        <pre>${escapeHtml(i.result_text || '')}</pre>
        ${
          i.prompt_used
            ? `<details class="nested"><summary>Prompt used</summary><pre>${escapeHtml(i.prompt_used)}</pre></details>`
            : ''
        }
      </details>
      <div class="row">
        <button class="del-item" data-id="${i.id}">Delete</button>
        <select class="move-item" data-id="${i.id}">
          <option value="">Move to...</option>
          <option value="null">(ungroup)</option>
          ${groups.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('')}
        </select>
      </div>
    </div>
  `;

  const renderGroup = (g, items) => `
    <div class="group" data-group-id="${g.id ?? 'null'}">
      <div class="group-head">
        <h3>${escapeHtml(g.name)} <small class="muted">(${items.length})</small></h3>
        ${g.id ? `<button class="del-group" data-id="${g.id}">Delete group</button>` : ''}
      </div>
      <div class="items">
        ${items.length === 0 ? '<em class="muted">(empty)</em>' : items.map(renderItem).join('')}
      </div>
      ${
        items.length > 0
          ? `<div class="row group-actions">
               <button class="curate" data-group="${g.id ?? ''}">Re-curate selected items</button>
             </div>`
          : ''
      }
    </div>
  `;

  // For each group, fetch its items
  const groupsWithItems = await Promise.all(
    groups.map(async (g) => ({ g, items: await api.get(`/api/items?group_id=${g.id}`) })),
  );

  wrap.innerHTML =
    groupsWithItems.map(({ g, items }) => renderGroup(g, items)).join('') +
    renderGroup({ id: null, name: 'Ungrouped' }, ungrouped);

  // Bind handlers
  $$('#groups-list .del-group').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this group? Its items will move to Ungrouped.')) return;
      await api.del(`/api/groups/${btn.dataset.id}`);
      loadGroups();
    }),
  );
  $$('#groups-list .del-item').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this item?')) return;
      await api.del(`/api/items/${btn.dataset.id}`);
      loadGroups();
    }),
  );
  $$('#groups-list .move-item').forEach((sel) =>
    sel.addEventListener('change', async () => {
      const id = sel.dataset.id;
      const v = sel.value;
      if (v === '') return;
      await api.patch(`/api/items/${id}`, { group_id: v === 'null' ? null : Number(v) });
      loadGroups();
    }),
  );
  $$('#groups-list .curate').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const groupEl = btn.closest('.group');
      const ids = $$('input.item-cb:checked', groupEl).map((c) => Number(c.dataset.id));
      if (ids.length === 0) {
        alert('Please select items to re-curate');
        return;
      }
      // Pre-flight context size check — use real content for accurate token estimate
      const allItems = await api.get('/api/items');
      const selectedItems = allItems.filter((i) => ids.includes(i.id));
      const combined = selectedItems.map((i) => i.result_text || '').join('\n\n');
      const tokens = tokensFromText(combined);
      const pct = Math.round((tokens / MAX_TOKENS) * 100);
      if (pct >= 100) {
        if (!confirm(
          'Warning: selected content is approximately ' + tokens.toLocaleString() + ' tokens, ' +
          'over the ' + (MAX_TOKENS / 1000) + 'K token limit (' + pct + '%).\n\n' +
          'Excess will be truncated. Continue anyway?'
        )) return;
      } else if (pct >= 80) {
        if (!confirm(
          'Near limit: selected content is approximately ' + tokens.toLocaleString() + ' tokens (' + pct + '% of 60K).\nContinue?'
        )) return;
      }

      const customPrompt = window.prompt(
        'Re-curation prompt (leave empty for default):\n' +
        '[This will send ' + selectedItems.length + ' notes, ~' + tokens.toLocaleString() + ' tokens]',
        'Synthesize the following notes: extract shared themes, contradictions, and combined takeaways. Output in markdown.',
      );
      if (customPrompt === null) return;
      btn.disabled = true;
      btn.textContent = 'Processing...';
      try {
        const r = await api.post('/api/curate', {
          itemIds: ids,
          prompt: customPrompt || undefined,
        });
        if (r.error) {
          alert('Error: ' + r.error);
          return;
        }
        // Debug log: verify what was actually sent to LLM
        if (r.debug) {
          console.group('[re-curate debug]');
          console.log('Requested item IDs:', ids);
          console.log('Items fetched from DB:', r.debug.fetchedItems);
          console.log('Context length sent to LLM:', r.debug.contextLength, 'chars');
          console.log('First 500 chars of context:', r.debug.contextPreview);
          console.log('Prompt used:', r.prompt);
          console.groupEnd();
        }
        const title = window.prompt('Save title:', `[Re-curated] ${ids.length} notes`);
        if (title === null) return;
        const groupId = btn.dataset.group ? Number(btn.dataset.group) : null;
        await api.post('/api/items', {
          group_id: groupId,
          title,
          yt_account: '(re-curated)',
          source_videos: ids,
          prompt_used: r.prompt,
          result_text: r.text,
        });
        loadGroups();
      } finally {
        btn.disabled = false;
        btn.textContent = 'Re-curate selected items';
      }
    }),
  );
}

// ============================================================
// Settings tab
// ============================================================

async function loadSettings() {
  const s = await api.get('/api/settings');
  $('#api-key').value = s.deepseek_api_key || '';
  $('#deepseek-model').value = s.deepseek_model || 'deepseek-chat';
  $('#default-prompt').value = s.default_prompt || '';
  // Sync to process tab
  if (!$('#prompt').value) $('#prompt').value = s.default_prompt || '';

  // Env check
  const h = await api.get('/api/health');
  $('#env-check').innerHTML = `
    <ul>
      <li>yt-dlp: ${h.ytdlp ? `<span class="ok">${escapeHtml(h.ytdlp)}</span>` : `<span class="err">${escapeHtml((h.ytdlpError || '').split('\n')[0])}</span>`}</li>
      <li>DeepSeek API key: ${s.deepseek_api_key ? '<span class="ok">configured</span>' : '<span class="err">not set</span>'}</li>
    </ul>
  `;
}

$('#save-settings').addEventListener('click', async () => {
  await api.post('/api/settings', {
    deepseek_api_key: $('#api-key').value,
    deepseek_model: $('#deepseek-model').value || 'deepseek-chat',
    default_prompt: $('#default-prompt').value,
  });
  $('#settings-status').innerHTML = '<span class="ok">Saved</span>';
  toast('ok', 'Settings saved', '');
  // sync to process tab if not edited
  $('#prompt').value = $('#default-prompt').value;
  setTimeout(() => ($('#settings-status').textContent = ''), 2000);
});

// ============================================================
// Init
// ============================================================
(async () => {
  await checkHealth();
  await loadSettings();
  await loadStoreAccountPicker();
})();
