// The step-5 output shape. Span-carrying fields accept a bare value or {value, evidence}.
import type { SpannedExtraction, StructuralFields } from './validate.ts';

export interface Extraction extends SpannedExtraction, StructuralFields {
  crm_note?: string | null;
  /** The caller's name as spoken on the call; `""` when never said. See `resolveCallerName`. */
  caller_name?: string | null;
  urgency_reason?: string | null;
  client_email_draft?: { subject?: string; body?: string } | null;
  /** Replaced `realtor_email_draft`. Validated by validateRealtorUpdate before use. */
  realtor_update?: string | null;
  /** The referring agent's name as spoken; salutation fallback when no partner is linked. */
  realtor_name?: string | null;
  coaching?: { score?: number | string; notes?: string; carry_forward?: string } | null;
  /**
   * What the call was about: `client | partner | internal | personal |
   * other`. Anything but `client` (or absent — older callers) switches off the client-only outputs.
   */
  call_purpose?: string | null;
  /** `new | unchanged | resolved | none`. `resolved` clears Blocker. */
  blocker_status?: string | null;
  /** Self-reported, weakly calibrated. A routing tiebreaker, never the gate. */
  confidence?: number | null;
}
