/**
 * extract.test.ts — schema.ts + extract.ts.
 *
 * Run: npm test   (node --experimental-strip-types --test)
 *
 * Three failure classes these guard:
 *   1. Schema drift against the API's structured-output rules (an unsupported keyword or a
 *      missing additionalProperties:false fails at request time, on the first real call).
 *   2. Prompt ↔ code drift — a placeholder left unfilled ships a prompt with a hole in it.
 *      (The tests that render the real prompt files live with the private prompts.)
 *   3. Response-path surprises — refusal and truncation must throw named errors the error
 *      workflow can route, never flow into write-back as a half-parsed extraction.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EXTRACTION_SCHEMA, OUTPUT_FORMAT } from '../../src/core/schema.ts';
import { ENUM_VALUES } from '../../src/core/validate.ts';
import {
  renderPrompt,
  buildExtractionRequest,
  parseExtractionResponse,
  ExtractionRefusedError,
  ExtractionIncompleteError,
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  runCost,
  totalTokens,
  extract,
} from '../../src/core/extract.ts';

// ---------------------------------------------------------------------------
// Schema invariants
// ---------------------------------------------------------------------------

/** Walk every object node in the schema, applying fn. */
function walkObjects(node: unknown, fn: (obj: Record<string, unknown>, path: string) => void, path = '$'): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => walkObjects(n, fn, `${path}[${i}]`));
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (obj.type === 'object' || 'properties' in obj) fn(obj, path);
    for (const [k, v] of Object.entries(obj)) walkObjects(v, fn, `${path}.${k}`);
  }
}

describe('EXTRACTION_SCHEMA — structured-output rule compliance', () => {
  test('every object node closes additionalProperties and requires every property', () => {
    walkObjects(EXTRACTION_SCHEMA, (obj, path) => {
      assert.equal(obj.additionalProperties, false, `${path} is missing additionalProperties:false`);
      const props = Object.keys((obj.properties as object) || {});
      assert.deepEqual(
        [...((obj.required as string[]) || [])].sort(),
        props.sort(),
        `${path} required list does not cover every property`,
      );
    });
  });

  test('no unsupported keywords anywhere — the API rejects them at request time', () => {
    const banned = ['minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'pattern'];
    const flat = JSON.stringify(EXTRACTION_SCHEMA);
    for (const kw of banned) {
      assert.ok(!flat.includes(`"${kw}"`), `schema contains unsupported keyword: ${kw}`);
    }
  });

  test('enums are sourced from ENUM_VALUES — content-identical, no drift', () => {
    const props = EXTRACTION_SCHEMA.properties as Record<string, any>;
    assert.deepEqual(props.urgency_flag.enum, [...ENUM_VALUES.urgency_flag]);
    assert.deepEqual(props.waiting_on.enum, [...ENUM_VALUES.waiting_on]);
    assert.deepEqual(props.language.enum, [...ENUM_VALUES.language]);
    assert.deepEqual(
      props.preferred_contact_method.anyOf[0].enum,
      [...ENUM_VALUES.preferred_contact_method],
    );
  });

  test('the schema stays within the compiled-grammar budget (3,690 bytes proven; ~4,300 was rejected live)', () => {
    // Two extra required objects (7 strings, zero unions) took the schema from 3,660 to ~4,300
    // bytes and the API answered 400 "The compiled grammar is too large" on every call. A live
    // probe showed the budget is CUMULATIVE (each object alone passed; both
    // together failed) and that the same signals as two `qualification.field` enum members (3,690
    // bytes) pass. Byte size is the proxy this test pins. Raising the number requires a live probe
    // through the API first — never just bump it.
    const bytes = JSON.stringify(EXTRACTION_SCHEMA).length;
    assert.ok(bytes <= 3700, `schema is ${bytes} bytes; 3,700 is the proven grammar budget`);
  });

  test('loan_stage is deliberately absent — the recorded resolution of the spec inconsistency', () => {
    assert.ok(!('loan_stage' in (EXTRACTION_SCHEMA.properties as object)));
  });

  test('OUTPUT_FORMAT wraps the schema in the json_schema envelope', () => {
    assert.equal(OUTPUT_FORMAT.type, 'json_schema');
    assert.equal(OUTPUT_FORMAT.schema, EXTRACTION_SCHEMA);
  });

  test('at most 16 union-typed parameters — the structured-outputs hard limit', () => {
    // The API 400s past 16 unions ("exponential compilation cost"). A union is a type-array
    // (`['string','null']`) or an `anyOf`. This escaped once at 19 and 400'd every call —
    // count them here so it cannot regress silently.
    let unions = 0;
    const countUnions = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(countUnions);
        return;
      }
      if (node && typeof node === 'object') {
        const obj = node as Record<string, unknown>;
        if (Array.isArray(obj.type) || Array.isArray(obj.anyOf)) unions++;
        for (const v of Object.values(obj)) countUnions(v);
      }
    };
    countUnions(EXTRACTION_SCHEMA);
    assert.ok(unions <= 16, `schema has ${unions} union-typed parameters; the API limit is 16`);
  });
});

// ---------------------------------------------------------------------------
// Prompt rendering — against the REAL files
// ---------------------------------------------------------------------------

describe('renderPrompt', () => {
  test('JSON braces in the prompt body are not placeholders', () => {
    const out = renderPrompt('Return {"value": null} for {{name}}.', { name: 'x' });
    assert.equal(out, 'Return {"value": null} for x.');
  });
});

// ---------------------------------------------------------------------------
// Request builder
// ---------------------------------------------------------------------------

describe('buildExtractionRequest', () => {
  const req = buildExtractionRequest({
    redactedTranscript: 'Renata: quick update, docs are in.',
    systemPrompt: 'You are the post-call assistant.',
  });

  test('defaults: the project model, adaptive thinking sent EXPLICITLY, structured output wired', () => {
    assert.equal(req.body.model, DEFAULT_MODEL);
    assert.equal(DEFAULT_MODEL, 'claude-opus-5-5');
    assert.deepEqual(req.body.thinking, { type: 'adaptive' });
    assert.deepEqual((req.body.output_config as any).format, OUTPUT_FORMAT);
  });

  test('effort is ALWAYS sent explicitly (Opus 5.5 defaults to medium, one level below 4.8)', () => {
    assert.equal((req.body.output_config as any).effort, DEFAULT_EFFORT);
    const r = buildExtractionRequest({ redactedTranscript: 't', systemPrompt: 's', effort: 'medium' });
    assert.equal((r.body.output_config as any).effort, 'medium');
  });

  test('thinking is never sent as disabled — a 400 on Opus 5.5', () => {
    assert.ok(!JSON.stringify(req.body).includes('"disabled"'));
  });

  test('🚩 no API key anywhere in the built request — the credential store owns it', () => {
    assert.ok(!JSON.stringify(req).toLowerCase().includes('api-key'));
  });

  test('system prompt carries the cache breakpoint; transcript rides in messages after it', () => {
    const sys = (req.body.system as any[])[0];
    assert.deepEqual(sys.cache_control, { type: 'ephemeral' });
    const user = (req.body.messages as any[])[0];
    assert.ok(user.content.includes('docs are in'));
  });
});

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

function apiResponse(overrides: Record<string, unknown> = {}) {
  return {
    stop_reason: 'end_turn',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: '{"crm_note": "ok"}' }],
    usage: { input_tokens: 1200, output_tokens: 300 },
    ...overrides,
  };
}

describe('parseExtractionResponse', () => {
  test('clean stop parses and surfaces usage for the run record', () => {
    const r = parseExtractionResponse(apiResponse());
    assert.equal((r.extraction as any).crm_note, 'ok');
    assert.equal(r.usage.inputTokens, 1200);
    assert.equal(r.usage.outputTokens, 300);
    assert.equal(r.usage.cacheWriteTokens, 0);
  });

  test('cache writes/reads and thinking tokens are read off the response (the cached prompt must be counted)', () => {
    const r = parseExtractionResponse(apiResponse({
      usage: { input_tokens: 81, cache_creation_input_tokens: 19777, cache_read_input_tokens: 0, output_tokens: 768, output_tokens_details: { thinking_tokens: 200 } },
    }));
    assert.deepEqual(r.usage, { inputTokens: 81, outputTokens: 768, cacheWriteTokens: 19777, cacheReadTokens: 0, thinkingTokens: 200 });
    assert.equal(totalTokens(r.usage), 81 + 19777 + 768);
  });

  test('runCost prices every token class by the RESPONSE model; unknown model = null, never a guess', () => {
    const pricing = { 'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 } };
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheWriteTokens: 1_000_000, cacheReadTokens: 1_000_000, thinkingTokens: 0 };
    assert.equal(runCost(pricing, 'claude-opus-5-5', u), 4 + 20 + 5 + 0.2);
    assert.equal(runCost(pricing, 'claude-opus-4-8', u), null);
    assert.equal(runCost(null, 'claude-opus-5-5', u), null);
  });

  test('refusal throws its named error — never parsed, never written', () => {
    assert.throws(
      () => parseExtractionResponse(apiResponse({ stop_reason: 'refusal' })),
      ExtractionRefusedError,
    );
  });

  test('max_tokens throws — a partial JSON write-back is worse than a late one', () => {
    assert.throws(
      () => parseExtractionResponse(apiResponse({ stop_reason: 'max_tokens' })),
      ExtractionIncompleteError,
    );
  });

  test('a thinking block before the text block is skipped, not parsed', () => {
    const r = parseExtractionResponse(
      apiResponse({
        content: [
          { type: 'thinking', text: '' },
          { type: 'text', text: '{"crm_note": "after thinking"}' },
        ],
      }),
    );
    assert.equal((r.extraction as any).crm_note, 'after thinking');
  });

  test('no text block and non-JSON text both throw the incomplete error', () => {
    assert.throws(
      () => parseExtractionResponse(apiResponse({ content: [] })),
      ExtractionIncompleteError,
    );
    assert.throws(
      () => parseExtractionResponse(apiResponse({ content: [{ type: 'text', text: 'not json' }] })),
      ExtractionIncompleteError,
    );
  });
});

test('extract() uses the injected fetch and never puts the key in the body', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({
      stop_reason: 'end_turn', model: 'claude-opus-5-5',
      content: [{ type: 'text', text: '{"crm_note":"x"}' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await extract({ redactedTranscript: 'hello', systemPrompt: 'sys' }, 'k-123', fakeFetch);
  assert.equal(r.extraction.crm_note, 'x');
  assert.equal((seen!.init.headers as Record<string, string>)['x-api-key'], 'k-123');
  assert.ok(!String(seen!.init.body).includes('k-123'));
});

test('renderPrompt throws and names a placeholder missing from vars', async () => {
  const { renderPrompt } = await import('../../src/core/extract.ts');
  assert.throws(() => renderPrompt('Hi {{contact_name}}', {}), /contact_name/);
});

test('the prompt the Worker will use renders with promptVars (no missing placeholder)', async () => {
  const { renderPrompt } = await import('../../src/core/extract.ts');
  const { promptVars } = await import('../../src/core/config.ts');
  const { readFileSync, existsSync } = await import('node:fs');
  const dir = existsSync('private/prompts/call.md') ? 'private/prompts' : 'prompts';
  const file = existsSync(`${dir}/call.md`) ? `${dir}/call.md` : `${dir}/call.example.md`;
  const crit = existsSync(`${dir}/script-criteria.md`) ? readFileSync(`${dir}/script-criteria.md`, 'utf8') : '';
  assert.doesNotThrow(() => renderPrompt(readFileSync(file, 'utf8'), promptVars('2026-10-01', crit)));
});
