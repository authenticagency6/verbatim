// One call, end to end, as pure logic: extract → validate → proposals → run record.
// No storage, no Cloudflare. The Workflow wraps this in durable steps.
import { extract, runCost, DEFAULT_MODEL, DEFAULT_EFFORT } from './extract.ts';
import { validateForWriteback, summarizeFailures } from './validate.ts';
import { buildProposals, type DroppedDraft, type ProposalDraft } from './proposals.ts';
import { PRICING, CONFIDENCE_THRESHOLD } from './config.ts';

export interface CallContext { crmNote: string | null; urgency: string | null }
export interface RunRecord {
  model: string; effort: string; inputTokens: number; outputTokens: number;
  cacheWriteTokens: number; cacheReadTokens: number; costUsd: number | null; durationMs: number;
  failures: string; needsReviewReasons: string; extractionJson: string;
}
export interface PipelineResult {
  proposals: ProposalDraft[]; dropped: DroppedDraft[]; unlocated: string[];
  needsReview: boolean; context: CallContext; run: RunRecord;
}

export async function processTranscript(input: {
  redactedTranscript: string; callDate: string; systemPrompt: string; apiKey: string;
  fetchFn?: typeof fetch; now?: () => number;
}): Promise<PipelineResult> {
  const now = input.now ?? Date.now;
  const t0 = now();
  const res = await extract(
    { redactedTranscript: input.redactedTranscript, systemPrompt: input.systemPrompt, model: DEFAULT_MODEL, effort: DEFAULT_EFFORT },
    input.apiKey,
    input.fetchFn,
  );
  const durationMs = now() - t0;

  const v = validateForWriteback(res.extraction as never, input.redactedTranscript, new Date(input.callDate + 'T12:00:00Z'));
  const set = buildProposals(v, input.redactedTranscript);

  const reasons: string[] = [];
  if (v.needsReview) reasons.push('structural');
  if (v.groundingNeedsReview) reasons.push('grounding');
  const ex = res.extraction as unknown as { confidence?: unknown; crm_note?: string | null };
  if (typeof ex.confidence === 'number' && ex.confidence < CONFIDENCE_THRESHOLD) reasons.push(`confidence ${ex.confidence}`);
  if (set.unlocated.length) reasons.push(`span_unlocated: ${set.unlocated.join(', ')}`);

  const usage = res.usage; // parseExtractionResponse already ran readUsage
  return {
    proposals: set.proposals,
    dropped: set.dropped,
    unlocated: set.unlocated,
    needsReview: reasons.some((r) => !r.startsWith('span_unlocated')),
    context: {
      crmNote: ex.crm_note ?? null,
      urgency: (v.structural.urgency_flag as string | null | undefined) ?? null,
    },
    run: {
      model: res.model,
      effort: DEFAULT_EFFORT,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      cacheReadTokens: usage.cacheReadTokens,
      costUsd: runCost(PRICING, res.model, usage),
      durationMs,
      failures: summarizeFailures(v.failures),
      needsReviewReasons: reasons.join('; '),
      extractionJson: JSON.stringify(res.extraction),
    },
  };
}
