// Slice-1 org configuration. One synthetic org; becomes per-org data when Clerk lands.
import type { ModelPrice } from './extract.ts';

export const ORG_NAME = 'Tallbrook Home Loans';
export const TEAM_ROSTER = [
  '- Renata Cole: owner and loan officer',
  '- Marcus Webb: loan officer assistant (bilingual EN/ES)',
  '- Priya Shah: processor',
].join('\n');

/**
 * $ per million tokens, keyed by the RESPONSE model id. Values must be checked against
 * Anthropic's published pricing before the first real run (Task 10 does this). An unknown
 * model logs cost null, never a guess.
 */
export const PRICING: Record<string, ModelPrice> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
};

export const CONFIDENCE_THRESHOLD = 0.6;
/** Below this many words, refuse before spending a model call. */
export const MIN_TRANSCRIPT_WORDS = 20;

export function promptVars(callDate: string, scriptCriteria: string): Record<string, string> {
  return {
    org_name: ORG_NAME,
    team_roster: TEAM_ROSTER,
    call_date: callDate,
    call_type: 'consult',
    direction: 'inbound',
    participants: '(not provided)',
    contact_name: '(not provided)',
    stage: '(not provided)',
    referral_partner: '(none)',
    preferred_language: '(not provided)',
    last_note: '(none)',
    current_key_facts: '(none)',
    script_criteria: scriptCriteria || '(not provided)',
  };
}
