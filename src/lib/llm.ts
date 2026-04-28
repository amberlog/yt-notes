/**
 * DeepSeek chat completions wrapper.
 * Uses native fetch (Node 18+).
 *
 * DeepSeek API is OpenAI-compatible. Endpoint:
 *   POST https://api.deepseek.com/chat/completions
 * Models: deepseek-chat (V3), deepseek-reasoner (R1)
 * Context window: ~64K tokens for V3.
 */

export type DeepSeekMsg = { role: 'system' | 'user' | 'assistant'; content: string };

export type DeepSeekOptions = {
  apiKey: string;
  model?: string; // default 'deepseek-chat'
  prompt: string; // system prompt
  context: string; // user content
  baseUrl?: string; // override for self-hosted compatible endpoints
  maxTokens?: number;
};

const SAFETY_LIMIT = 60_000; // tokens, leave room for output

// Language-aware token estimate (matches frontend tokensFromText):
//   CJK ~ 1.3 tokens/char, ASCII ~ 0.25 tokens/char
function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
  const ascii = text.length - cjk;
  return Math.round(cjk * 1.3 + ascii * 0.25);
}

export function truncateContext(context: string): { context: string; truncated: boolean } {
  const tokens = estimateTokens(context);
  if (tokens <= SAFETY_LIMIT) return { context, truncated: false };

  // Binary search for the longest prefix that stays under the limit
  let lo = 0, hi = context.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (estimateTokens(context.slice(0, mid)) <= SAFETY_LIMIT - 50) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return {
    context:
      context.slice(0, lo) +
      '\n\n[note: original content was too long; truncated to approximately ' + SAFETY_LIMIT + ' tokens]',
    truncated: true,
  };
}

// Hard upper bound for a single LLM call. Long-context summarization on
// deepseek-chat usually finishes well under 60s; deepseek-reasoner can take
// 1-2 minutes. 180s gives headroom without leaving a hung request forever.
const REQUEST_TIMEOUT_MS = 180_000;

export async function callDeepSeek(opts: DeepSeekOptions): Promise<{ text: string; truncated: boolean }> {
  if (!opts.apiKey) throw new Error('DeepSeek API key not set');

  const { context, truncated } = truncateContext(opts.context);

  const messages: DeepSeekMsg[] = [
    { role: 'system', content: opts.prompt },
    { role: 'user', content: context },
  ];

  const baseUrl = opts.baseUrl || 'https://api.deepseek.com';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model || 'deepseek-chat',
        messages,
        stream: false,
        max_tokens: opts.maxTokens ?? 4096,
      }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`DeepSeek ${res.status}: ${errBody.slice(0, 500)}`);
    }

    const data: any = await res.json();
    const text: string = data?.choices?.[0]?.message?.content ?? '';
    if (!text) throw new Error('DeepSeek returned empty response');
    return { text, truncated };
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new Error(`DeepSeek request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
