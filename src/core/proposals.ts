// Turns a validated extraction into what a person reviews: Proposals (each with its quote and
// where it sits in the transcript) and Dropped values (what the model said that could not be
// quoted). Quote it or drop it: nothing without a verified quote becomes a Proposal.
import type { ValidationFailure, WritebackValidationResult } from './validate.ts';
import { locateSpan } from './locate.ts';

export type ProposalKind = 'follow_up' | 'task' | 'figure';

export interface ProposalDraft {
  kind: ProposalKind;
  field: string;
  label: string;
  value: string;
  quote: string;
  start: number | null;
  end: number | null;
}

export interface DroppedDraft {
  field: string;
  value: string;
  reason: string;
}

export interface ProposalSet {
  proposals: ProposalDraft[];
  dropped: DroppedDraft[];
  /** Fields whose verified quote could not be mapped to a range (shown unhighlighted). */
  unlocated: string[];
}

const FIGURE_LABELS: Record<string, string> = {
  approved_price: 'Approved up to',
  max_payment: 'Max monthly payment',
  max_out_of_pocket: 'Max out of pocket',
  rate_range_quoted: 'Rate quoted',
  preapproval_date: 'Pre-approval date',
};

const TASK_LABELS: Record<string, string> = {
  deliverable: 'Task',
  contact_client: 'Contact the client',
  client_action: 'Waiting on the client',
  third_party: 'Waiting on a third party',
};

const REVIEWED_FIELDS = new Set([...Object.keys(FIGURE_LABELS), 'follow_up_date', 'next_action']);

export function buildProposals(v: WritebackValidationResult, redactedTranscript: string): ProposalSet {
  const proposals: ProposalDraft[] = [];
  const dropped: DroppedDraft[] = [];
  const unlocated: string[] = [];

  const propose = (kind: ProposalKind, field: string, label: string, value: string, quote: string) => {
    const at = locateSpan(redactedTranscript, quote);
    if (!at) unlocated.push(field);
    proposals.push({ kind, field, label, value, quote, start: at?.start ?? null, end: at?.end ?? null });
  };

  const guardrails = v.guardrails as unknown as Record<string, unknown>;
  for (const field of Object.keys(FIGURE_LABELS)) {
    const value = guardrails[field];
    if (value === null || value === undefined) continue;
    const quote = v.evidence[field];
    if (!quote) dropped.push({ field, value: String(value), reason: 'evidence_missing' });
    else propose('figure', field, FIGURE_LABELS[field], String(value), quote);
  }

  if (v.follow_up_date) {
    const quote = v.evidence.follow_up_date;
    if (!quote) dropped.push({ field: 'follow_up_date', value: v.follow_up_date, reason: 'evidence_missing' });
    else propose('follow_up', 'follow_up_date', 'Follow up', v.follow_up_date, quote);
  }

  const na = v.next_action;
  if (na) {
    if (!na.evidenceVerified) {
      dropped.push({ field: 'next_action', value: na.action, reason: 'evidence_not_in_transcript' });
    } else {
      const base = TASK_LABELS[na.kind] ?? 'Task';
      propose('task', 'next_action', na.due ? `${base} · due ${na.due}` : base, na.action, na.evidence);
    }
  }

  for (const f of v.failures as ValidationFailure[]) {
    if (!REVIEWED_FIELDS.has(f.field)) continue;
    const value = String(f.bound ?? f.value);
    if (dropped.some((d) => d.field === f.field && d.value === value)) continue;
    dropped.push({ field: f.field, value, reason: f.reason });
  }

  return { proposals, dropped, unlocated };
}
