/// <reference types="vite/client" />
interface Env {
  DB: D1Database;
  PROCESS_CALL: Workflow;
  ANTHROPIC_API_KEY: string;
  TEST_MIGRATIONS?: D1Migration[];
}
declare namespace Cloudflare {
  interface Env extends globalThis.Env {}
  interface GlobalProps {
    mainModule: typeof import('./index.ts');
  }
}
declare module '@prompt-call?raw' {
  const text: string;
  export default text;
}
declare module '@prompt-criteria?raw' {
  const text: string;
  export default text;
}
