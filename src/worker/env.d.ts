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
declare module '*.md?raw' {
  const text: string;
  export default text;
}
