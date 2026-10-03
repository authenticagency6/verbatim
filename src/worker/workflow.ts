import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { processTranscript, type PipelineResult } from '../core/pipeline.ts';
import { ExtractionRefusedError } from '../core/extract.ts';
import { getCallInput, saveResults, markFailed } from './db.ts';
import { systemPrompt } from './prompt.ts';

export interface ProcessCallParams { callId: string }

export class ProcessCall extends WorkflowEntrypoint<Env, ProcessCallParams> {
  async run(event: WorkflowEvent<ProcessCallParams>, step: WorkflowStep) {
    const { callId } = event.payload;
    try {
      const input = await step.do('load', async () => {
        const c = await getCallInput(this.env.DB, callId);
        if (!c) throw new NonRetryableError(`call ${callId} not found`);
        return c;
      });
      const result: PipelineResult = await step.do(
        'extract',
        { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '5 minutes' },
        async () => {
          try {
            return await processTranscript({
              redactedTranscript: input.redactedTranscript,
              callDate: input.callDate,
              systemPrompt: systemPrompt(input.callDate),
              apiKey: this.env.ANTHROPIC_API_KEY,
            });
          } catch (e) {
            if (e instanceof ExtractionRefusedError) throw new NonRetryableError(e.message, 'refused');
            throw e;
          }
        },
      );
      await step.do('persist', async () => {
        await saveResults(this.env.DB, callId, result);
        return { proposals: result.proposals.length, dropped: result.dropped.length };
      });
    } catch (e) {
      await step.do('mark failed', async () => {
        await markFailed(this.env.DB, callId, e instanceof Error ? e.message.slice(0, 300) : 'failed');
      });
      throw e;
    }
  }
}
