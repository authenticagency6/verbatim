/**
 * extract.ts — the extraction step: the Claude call, as pure functions.
 *
 * DELIBERATELY TRANSPORT-AGNOSTIC. This module builds the request and parses the response; it
 * does not own the HTTP call. Two reasons, both structural:
 *
 *   1. **The transport can live outside this module** — a host calls
 *      `buildExtractionRequest`, sends the result over its own HTTP client (whose credential
 *      store injects the API key), and hands the response to `parseExtractionResponse`. The
 *      API key lives in the host's secret store, never in code (ACCESS, not POSSESSION).
 *   2. **The eval harness needs the same functions** — the corpus-diff (run the prompt over
 *      the regression set, diff against each `expected`) must exercise the exact request the
 *      workflow sends, or it validates a different system than the one deployed. `extract()`
 *      below wraps the pair around global fetch for that path.
 *
 * MODEL — `claude-opus-5-5` at an EXPLICIT effort (DEFAULT_EFFORT), chosen after a side-by-side
 * replay (4.8 vs 5.5 medium vs 5.5 high). ⚠️ On Opus 5.5 thinking is ALWAYS on (a `disabled`
 * value is a 400) and the API default effort is `medium`, one level below 4.8's `high` — so the
 * builder always sends `output_config.effort` explicitly, never relying on the default.
 *
 * The response is constrained to schema.ts via `output_config.format` (structured outputs),
 * so parsing is JSON.parse on the first text block — no fence-stripping, no repair. Note the
 * spec's citations note still holds: citations + output_config.format returns a 400, which is
 * why evidence spans are model-emitted and substring-verified instead.
 */

import { OUTPUT_FORMAT } from './schema.ts';
import type { Extraction } from './types.ts';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The model declined (stop_reason "refusal"). Route the call to the error workflow. */
export class ExtractionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionRefusedError';
  }
}

/** The response was cut off or unparseable — retry with more tokens or fail into alerting. */
export class ExtractionIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionIncompleteError';
  }
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

/**
 * Render a prompt template: strip maintainer comments, fill {{placeholders}}, and refuse to
 * ship holes.
 *
 * - **HTML comments are removed first.** The prompt files carry maintainer notes in
 *   `<!-- ... -->` blocks that are for humans, not the model — and one of them literally
 *   contains the string "{{placeholders}}", which would otherwise read as an unresolved slot.
 * - **A leftover {{...}} after rendering throws.** A prompt sent with a hole in it produces
 *   plausible output against missing context — the quiet failure. Better to fail the run into
 *   the error workflow than extract against "{{contact_name}}".
 * - Values are inserted as-is; callers pass "(not provided)" for genuinely absent context
 *   rather than omitting the key.
 */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  let out = template.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in vars)) return `{{${key}}}`; // left for the leftover check to report
    return vars[key];
  });
  const leftover = [...out.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
  if (leftover.length > 0) {
    throw new Error(
      `Prompt template has unresolved placeholders: ${[...new Set(leftover)].join(', ')}. ` +
        'Pass every key in vars — use "(not provided)" for genuinely absent context.',
    );
  }
  return out.trim();
}

// ---------------------------------------------------------------------------
// Request builder
// ---------------------------------------------------------------------------

export interface BuildExtractionRequestInput {
  /** The REDACTED transcript — step 4b's output. Never the raw one. */
  redactedTranscript: string;
  /** The rendered system prompt — renderPrompt(callMd | applicationMd, vars). */
  systemPrompt: string;
  /** Default DEFAULT_MODEL — see the header note before changing. */
  model?: string;
  maxTokens?: number;
  /**
   * `output_config.effort`. Default DEFAULT_EFFORT. Thinking itself is always adaptive: Opus 5.5
   * rejects `disabled` with a 400, so effort is the only dial for thinking depth, latency and cost.
   */
  effort?: Effort;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ExtractionRequest {
  url: string;
  /**
   * ⚠️ Deliberately WITHOUT `x-api-key`. A host's own HTTP client adds it from its secret
   * store; in the eval harness `extract()` adds it from its argument. Keys never sit in built
   * request objects, where they end up in execution logs.
   */
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export const DEFAULT_MODEL = 'claude-opus-5-5';
/** Sent explicitly on every request (Opus 5.5's own default is `medium`). See the header note. */
export const DEFAULT_EFFORT: Effort = 'high';
export const API_URL = 'https://api.anthropic.com/v1/messages';

export function buildExtractionRequest(input: BuildExtractionRequestInput): ExtractionRequest {
  const {
    redactedTranscript,
    systemPrompt,
    model = DEFAULT_MODEL,
    // Shared cap for adaptive thinking + JSON output. 16k truncated a long call (fail-closed);
    // 32k is 2x the largest observed. A ceiling, not a spend.
    maxTokens = 32000,
    effort = DEFAULT_EFFORT,
  } = input;

  return {
    url: API_URL,
    headers: {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: {
      model,
      max_tokens: maxTokens,
      // Explicit, although Opus 5.5 runs adaptive when it is omitted: an implicit default is the
      // kind of thing a model swap silently changes (on Opus 4.8, omission meant OFF).
      thinking: { type: 'adaptive' },
      // The system prompt is stable per call-type, so it takes a cache breakpoint: a batch
      // sweep processes calls in bursts, and every call after the first reads the
      // prompt from cache. The transcript (volatile) goes in messages, after the breakpoint.
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `Transcript of the call:\n\n${redactedTranscript}`,
        },
      ],
      output_config: { format: OUTPUT_FORMAT, effort },
    },
  };
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

export interface ExtractionResult {
  extraction: Extraction;
  /** For the run record: Tokens and Cost are per-run observability, not decoration. */
  usage: RunUsage;
  model: string;
  stopReason: string;
}

/**
 * Token counts off a Messages API response. ⚠️ `input_tokens` is only the UNCACHED input: the
 * cached system prompt (~20k tokens on every call) arrives as cache writes/reads, which a cost
 * figure must count or it understates the run.
 */
export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** Included in outputTokens (thinking is billed as output). Diagnostic only. */
  thinkingTokens: number;
}

export type RawUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
};

export function readUsage(u: RawUsage | undefined): RunUsage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    thinkingTokens: u?.output_tokens_details?.thinking_tokens ?? 0,
  };
}

/** $ per million tokens. `cacheWrite` = the 5-minute cache write (the only TTL the Engine uses). */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * Run cost in USD from a price map keyed by the RESPONSE's model id, or null when the model is not
 * in the map (no invented numbers: an unknown model logs a blank Cost, not a guess).
 */
export function runCost(pricing: Record<string, ModelPrice> | null | undefined, model: string, u: RunUsage): number | null {
  const p = pricing && pricing[model];
  if (!p || typeof p.input !== 'number' || typeof p.output !== 'number') return null;
  const cw = typeof p.cacheWrite === 'number' ? p.cacheWrite : p.input * 1.25;
  const cr = typeof p.cacheRead === 'number' ? p.cacheRead : p.input * 0.1;
  return (u.inputTokens * p.input + u.cacheWriteTokens * cw + u.cacheReadTokens * cr + u.outputTokens * p.output) / 1e6;
}

/** Every token the run processed (uncached + cache writes + cache reads + output). The run record's `Tokens`. */
export function totalTokens(u: RunUsage): number {
  return u.inputTokens + u.cacheWriteTokens + u.cacheReadTokens + u.outputTokens;
}

/**
 * Parse a Messages API response body into the extraction.
 *
 * Structured outputs guarantee the text block is schema-valid JSON on a clean stop — so a
 * parse failure here means a non-clean stop, and the two known ones get named errors the
 * error workflow can route on.
 */
export function parseExtractionResponse(response: unknown): ExtractionResult {
  const r = response as {
    stop_reason?: string;
    model?: string;
    content?: { type: string; text?: string }[];
    usage?: RawUsage;
    error?: { type?: string; message?: string };
  };

  if (r?.error) {
    throw new Error(`API error ${r.error.type || 'unknown'}: ${r.error.message || ''}`);
  }
  if (r?.stop_reason === 'refusal') {
    throw new ExtractionRefusedError(
      'The model declined this transcript (stop_reason "refusal"). The output does not match ' +
        'the schema — do not parse it. Route to the error workflow.',
    );
  }
  if (r?.stop_reason === 'max_tokens') {
    throw new ExtractionIncompleteError(
      'Extraction hit max_tokens and is truncated. Re-run with a higher limit — a partial ' +
        'JSON write-back is worse than a late one.',
    );
  }

  const textBlock = (r?.content || []).find((b) => b.type === 'text' && typeof b.text === 'string');
  if (!textBlock?.text) {
    throw new ExtractionIncompleteError(
      `No text block in response (stop_reason: ${r?.stop_reason ?? 'unknown'}).`,
    );
  }

  let extraction: Extraction;
  try {
    extraction = JSON.parse(textBlock.text) as Extraction;
  } catch {
    throw new ExtractionIncompleteError(
      'Response text is not valid JSON despite structured outputs — treat as a failed run.',
    );
  }

  return {
    extraction,
    usage: readUsage(r?.usage),
    model: r?.model ?? 'unknown',
    stopReason: r?.stop_reason ?? 'unknown',
  };
}

// ---------------------------------------------------------------------------
// Convenience wrapper — one-shot use; fetch is injectable for tests
// ---------------------------------------------------------------------------

/**
 * One-shot extraction over `fetchFn` (global fetch by default). A host that wants its own
 * transport can split builder and parser around its HTTP client so its secret store owns the key.
 */
export async function extract(
  input: BuildExtractionRequestInput,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<ExtractionResult> {
  const req = buildExtractionRequest(input);
  const res = await fetchFn(req.url, {
    method: 'POST',
    headers: { ...req.headers, 'x-api-key': apiKey },
    body: JSON.stringify(req.body),
  });
  const json = await res.json();
  if (!res.ok) {
    const e = (json as { error?: { type?: string; message?: string } }).error;
    throw new Error(`API ${res.status} ${e?.type || ''}: ${e?.message || 'request failed'}`);
  }
  return parseExtractionResponse(json);
}
