// '@prompt-call' / '@prompt-criteria' resolve to private/prompts when present, else the public
// examples in prompts/ (see vite.config.ts), so a fresh public clone still builds.
import callMd from '@prompt-call?raw';
import scriptCriteria from '@prompt-criteria?raw';
import { renderPrompt } from '../core/extract.ts';
import { promptVars } from '../core/config.ts';

export function systemPrompt(callDate: string): string {
  return renderPrompt(callMd, promptVars(callDate, scriptCriteria));
}
