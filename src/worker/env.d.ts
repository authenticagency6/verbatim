interface Env {
  DB: D1Database;
  PROCESS_CALL: Workflow;
  ANTHROPIC_API_KEY: string;
  TEST_MIGRATIONS?: D1Migration[];
}
declare module 'cloudflare:workers' {
  interface ProvidedEnv extends Env {}
}
declare module '*.md?raw' {
  const text: string;
  export default text;
}
