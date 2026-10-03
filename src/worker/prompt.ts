// '@prompts' resolves to private/prompts when present, else the public example (vite.config.ts).
import callMd from '@prompts/call.md?raw';
import { renderPrompt } from '../core/extract.ts';
import { promptVars } from '../core/config.ts';

const criteria = import.meta.glob('@prompts/script-criteria.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const scriptCriteria = Object.values(criteria)[0] ?? '';

export function systemPrompt(callDate: string): string {
  return renderPrompt(callMd, promptVars(callDate, scriptCriteria));
}
