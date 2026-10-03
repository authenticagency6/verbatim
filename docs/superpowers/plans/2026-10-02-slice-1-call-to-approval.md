# Slice 1: Call to Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One synthetic call transcript in; follow-ups, tasks and figures out, each tied to its exact words; values the AI can't quote shown as dropped; a person approves or rejects each one.

**Architecture:** An import-free TypeScript core (`src/core/`), ported from an existing extraction engine plus two new modules (`locate`, `proposals`). A Cloudflare Worker (`src/worker/`) redacts on submit, stores the call in D1, and runs a `ProcessCall` Workflow (extract → validate+propose → persist). A React SPA (`src/web/`) is served from Workers static assets and polls the call until it's ready.

**Tech Stack:** TypeScript, Node ≥ 22.6 (`node --test` with type stripping for the core), Cloudflare Workers + Workflows + D1, Vite + `@cloudflare/vite-plugin` + React, Vitest ≥ 4.1 + `@cloudflare/vitest-plugin` for Worker tests, Anthropic Messages API (structured outputs).

**Spec:** `docs/superpowers/specs/2026-10-02-slice-1-call-to-approval-design.md` · **Stack:** `docs/adr/0001-stack.md`

## Global Constraints

- This repo is PUBLIC. No real people, teams, lenders, phone numbers, transcripts, IDs or secrets in any committed file. All data belongs to the synthetic branch **Tallbrook Home Loans**.
- **Public:** the core code, including validator and redaction (comments scrubbed of client names and incident history), and the ported unit tests (names scrubbed).
- **Private** (`private/`, gitignored): full prompts, the script-criteria file, the regression/trap corpus, the edge-case catalogue (the old engine README's bug list and the fixture `why` notes), and the scrub name list.
- Port source (read only, never edit): `C:\Users\danxc\OneDrive\Desktop\AI Resources\workspaces\aquarius-ops\rate-audit\rate-engine\` (below: `$SRC`). Never copy `fixtures/real-shape/`, `eval/results/`, `n8n/`, `build/`, or any README into this repo.
- `src/core/` stays import-free (only relative imports between core files). It must run under `node --experimental-strip-types --test`, so no `enum`, `namespace`, decorators or parameter properties.
- The raw transcript is never stored anywhere: not D1, not Workflow params. Redact first.
- Any value without a quote never becomes a Proposal (quote it or drop it).
- Nothing in slice 1 sends, emails, or writes outside D1.
- No invented numbers. Cost and duration come from the `runs` table of a real run.
- Before every commit: `node scripts/scan-staged.mjs` must pass. At the end of each task, show Dan `git diff --cached` (or the task's diff) before pushing.
- All work happens on branch `slice-1`. Push daily.

**Deviations from the spec (deliberate, flagged for Dan):**
1. Redaction runs in the `POST /api/calls` handler, not as a Workflow step. Workflow params are persisted by Cloudflare, so redacting inside the Workflow would store the raw transcript. A redaction-guard failure returns `422` immediately rather than a `failed` call.
2. `validate.ts` is ported as one file (with the NUL fix) and is not split into modules in this slice. Splitting 107 KB is a refactor with no slice-1 payoff; it's queued for slice 2.
3. A short public prompt (`prompts/call.example.md`) exists so the public repo builds and runs. The demo and real runs use `private/prompts/call.md` when it's present.

## Review Focus

1. **The same phrase said twice in a call** (e.g. "thirty two hundred a month" in rent talk, then in budget talk): a person expects the highlight to land on *a* real occurrence. `locateSpan` returns the first; a test pins that it never returns a range that doesn't match. (Task 3)
2. **Windows line endings in a pasted transcript** (`\r\n` from Word/Outlook): offsets must still point at the right characters. Test in Task 3.
3. **Double-click / double-submit on Approve or Reject**: the second decision must not flip an already-decided card. `decideProposal` only updates `status = 'proposed'` rows and returns 409 otherwise. Test in Task 5.
4. **An empty or tiny paste** (blank, or 3 words): returns a 400 with a readable message before any model spend. Test in Task 6.
5. **The model returns a figure with a bare value (no quote) that passes the number check**: it must land in Dropped as `evidence_missing`, never as a card. Test in Task 4.

---

## File structure

```
package.json                  scripts: test:core, test:worker, test, dev, build, deploy, scan
tsconfig.json
wrangler.jsonc                Worker + D1 + Workflow + assets
vite.config.ts                React + cloudflare plugin + @prompts alias
vitest.config.ts              cloudflareTest + D1 migrations
index.html                    SPA entry
migrations/0001_init.sql
scripts/scan-staged.mjs       name/secret scan over the staged diff
scripts/regress.ts            runs private/regression/*.json if present
prompts/call.example.md       public, short prompt (used when private/ is absent)
samples/tallbrook-*.json      3 public demo calls
src/core/                     import-free, node --test
  redact.ts                   (port)
  guard.ts                    assertRedacted + UnredactedTranscriptError (port, from writeback.ts)
  validate.ts                 (port, NUL fix, scrubbed comments)
  schema.ts                   (port)
  types.ts                    Extraction type (moved out of writeback.ts)
  extract.ts                  (port; fetch injectable)
  locate.ts                   NEW
  proposals.ts                NEW
  pipeline.ts                 NEW: extract → validate → proposals → run record
  config.ts                   NEW: org name, roster, pricing, prompt vars
test/core/*.test.ts           node --test
src/worker/
  index.ts                    fetch handler + exports ProcessCall
  routes.ts                   /api/* routing
  db.ts                       D1 access
  workflow.ts                 ProcessCall
  prompt.ts                   loads the prompt via the @prompts alias
  env.d.ts                    Env type
test/worker/*.test.ts         vitest
src/web/
  main.tsx  App.tsx  api.ts  segments.ts  styles.css
  components/{SubmitForm,CallView,ProposalCard,TranscriptPane,DroppedTray}.tsx
test/core/segments.test.ts    (segments.ts is pure, tested with node --test)
private/  (gitignored)        prompts/call.md, prompts/script-criteria.md, regression/*.json, scrub-names.txt, edge-cases.md
docs/CHANGELOG.md  docs/HANDOFF.md
```

---

### Task 1: Scaffold, scan guard, health route

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `src/worker/index.ts`, `src/worker/routes.ts`, `src/worker/env.d.ts`, `src/web/main.tsx`, `src/web/App.tsx`, `migrations/0001_init.sql` (empty placeholder table in this task; filled in Task 5), `test/worker/apply-migrations.ts`, `test/worker/health.test.ts`, `scripts/scan-staged.mjs`, `private/scrub-names.txt`, `prompts/call.example.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `GET /api/health` → `200 {"ok":true}`; `npm run test:core`, `npm run test:worker`, `npm test`, `npm run scan`; the `Env` type with `DB: D1Database`, `PROCESS_CALL: Workflow`, `ANTHROPIC_API_KEY: string`.

- [ ] **Step 1: Create the branch**

```bash
cd /c/dev/verbatim && git checkout -b slice-1
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "verbatim",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.6.0" },
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "deploy": "npm run build && wrangler deploy",
    "test:core": "node --experimental-strip-types --test test/core/*.test.ts",
    "test:worker": "vitest run",
    "test": "npm run test:core && npm run test:worker",
    "regress": "node --experimental-strip-types scripts/regress.ts",
    "scan": "node scripts/scan-staged.mjs",
    "db:migrate:local": "wrangler d1 migrations apply verbatim --local",
    "db:migrate:remote": "wrangler d1 migrations apply verbatim --remote"
  }
}
```

Then install:

```bash
npm i react react-dom
npm i -D typescript vite @vitejs/plugin-react @cloudflare/vite-plugin wrangler vitest@^4.1.0 @cloudflare/vitest-plugin @cloudflare/workers-types @types/react @types/react-dom @types/node
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "lib": ["ES2022", "DOM"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-plugin/types", "node"]
  },
  "include": ["src", "test", "scripts", "vite.config.ts", "vitest.config.ts"]
}
```

Core files import each other with `.ts` extensions (`import { x } from './validate.ts'`), which Node type-stripping requires and `allowImportingTsExtensions` permits.

- [ ] **Step 4: Write `wrangler.jsonc`**

```jsonc
{
  "name": "verbatim",
  "main": "./src/worker/index.ts",
  "compatibility_date": "2026-09-30",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "not_found_handling": "single-page-application", "run_worker_first": ["/api/*"] },
  "d1_databases": [
    { "binding": "DB", "database_name": "verbatim", "database_id": "REPLACE_AFTER_wrangler_d1_create", "migrations_dir": "migrations" }
  ],
  "workflows": [{ "name": "process-call", "binding": "PROCESS_CALL", "class_name": "ProcessCall" }],
  "observability": { "enabled": true }
}
```

`database_id` is filled in Task 10 by `wrangler d1 create verbatim`. Local dev and tests don't need it.

- [ ] **Step 5: Write `vite.config.ts` with the private-prompt alias**

```ts
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

const root = fileURLToPath(new URL('.', import.meta.url));
// The full prompt lives in private/ (gitignored). A fresh public clone falls back to the example.
export const promptsDir = existsSync(`${root}private/prompts/call.md`) ? `${root}private/prompts` : `${root}prompts`;

export default defineConfig({
  plugins: [react(), cloudflare()],
  resolve: { alias: { '@prompts': promptsDir } },
});
```

- [ ] **Step 6: Write `vitest.config.ts`**

```ts
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { promptsDir } from './vite.config.ts';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(__dirname, 'migrations')),
          ANTHROPIC_API_KEY: 'test-key-not-real',
        },
      },
    })),
  ],
  resolve: { alias: { '@prompts': promptsDir } },
  test: { include: ['test/worker/**/*.test.ts'], setupFiles: ['./test/worker/apply-migrations.ts'] },
});
```

If `readD1Migrations` doesn't resolve from the package root, import it from `@cloudflare/vitest-plugin/config` (the docs show both).

- [ ] **Step 7: Write `src/worker/env.d.ts` and `test/worker/apply-migrations.ts`**

```ts
// src/worker/env.d.ts
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
```

```ts
// test/worker/apply-migrations.ts
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
```

- [ ] **Step 8: Write the failing health test**

```ts
// test/worker/health.test.ts
import { describe, it, expect } from 'vitest';
import { exports } from 'cloudflare:workers';

describe('health', () => {
  it('GET /api/health returns ok', async () => {
    const res = await exports.default.fetch('https://verbatim.test/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 9: Run it and confirm it fails**

Run: `npm run test:worker`
Expected: FAIL (the entry module `src/worker/index.ts` doesn't exist).

- [ ] **Step 10: Minimal Worker + empty migration + SPA shell**

```ts
// src/worker/routes.ts
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === 'GET' && url.pathname === '/api/health') return json({ ok: true });
  return json({ error: 'not found' }, 404);
}
```

```ts
// src/worker/index.ts
import { handle } from './routes.ts';

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env);
  },
} satisfies ExportedHandler<Env>;
```

```sql
-- migrations/0001_init.sql  (filled in Task 5)
SELECT 1;
```

```html
<!-- index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Verbatim</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/web/main.tsx"></script>
  </body>
</html>
```

```tsx
// src/web/main.tsx
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
createRoot(document.getElementById('root')!).render(<App />);
```

```tsx
// src/web/App.tsx
export function App() {
  return <main><h1>Verbatim</h1></main>;
}
```

The `wrangler.jsonc` Workflow binding references `ProcessCall`, which doesn't exist until Task 6. If the test runner refuses to start without the class, temporarily remove the `workflows` block in this task and add it back in Task 6.

- [ ] **Step 11: Run and confirm it passes**

Run: `npm run test:worker`
Expected: PASS, 1 test.

- [ ] **Step 12: Write the scan script and the private name list**

`private/scrub-names.txt` holds one case-insensitive regex per line. Build it from the port source's roster and team lines. **Never commit it**; it lists the real names it guards against.

```bash
mkdir -p private && cat > private/scrub-names.txt <<'EOF'
# One regex per line, case-insensitive. Real names this repo must never contain.
# Seed: every value and key in $SRC/src/roster.ts, the lender and team names, base/record id shapes.
EOF
```

Then open `$SRC/src/roster.ts`, `$SRC/src/writeback.ts` (`TEAM_FIRST_NAMES`, `REALTOR_SIGN_OFF`) and `$SRC/prompts/call.md` (the roster section), and append each person, team and lender name as its own line (e.g. `\bfirstname\b`). Also append `\bRate\.com\b`, plus every Airtable base/record id found in the port source, each as its own exact line. Find them with `grep -rhoE '\b(app|rec)[A-Za-z0-9]{14}\b' "$SRC/src" "$SRC/test" "$SRC/prompts" "$SRC/fixtures/regression" | sort -u`, then drop false matches such as `applyD1Migrations`. Bare "rate" is too common to match, so check each ported file by eye for the lender name.

```js
// scripts/scan-staged.mjs
// Fails the commit if the staged diff contains a scrubbed name or a secret-shaped string.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const LIST = 'private/scrub-names.txt';
if (!existsSync(LIST)) {
  console.error(`scan: ${LIST} is missing. Refusing to pass (fail closed).`);
  process.exit(1);
}
const patterns = readFileSync(LIST, 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => new RegExp(l, 'i'));
// Generic id shapes (app.../rec...) are NOT used: they false-match code like applyD1Migrations.
// The real base and record ids go in the private list instead.
patterns.push(/sk-ant-[a-z0-9_-]{10,}/i);

const diff = execSync('git diff --cached -U0', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
let file = '';
const hits = [];
for (const line of diff.split('\n')) {
  if (line.startsWith('+++ b/')) file = line.slice(6);
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  for (const p of patterns) if (p.test(line)) hits.push(`${file}: ${p} :: ${line.slice(0, 120)}`);
}
if (hits.length) {
  console.error('scan: BLOCKED\n' + hits.join('\n'));
  process.exit(1);
}
console.log('scan: clean');
```

- [ ] **Step 13: Write `prompts/call.example.md` (public, short)**

```markdown
<!-- Public example prompt. The demo uses private/prompts/call.md when it exists. -->
You extract follow-ups, tasks and figures from a mortgage call for {{org_name}}.

Team: {{team_roster}}
Call date: {{call_date}} · type: {{call_type}} · direction: {{direction}} · participants: {{participants}}
Contact: {{contact_name}} · stage: {{stage}} · partner: {{referral_partner}} · language: {{preferred_language}}
Last note: {{last_note}}
Current key facts: {{current_key_facts}}
Call criteria: {{script_criteria}}

Rules:
- Only report what was said on this call. Never invent a figure or a date.
- Every figure, date, blocker, key fact and next action carries `evidence`: one contiguous, verbatim
  quote from the transcript of at least 10 words that contains the value. No ellipses, no paraphrase.
- A field that was not discussed is null.
- Resolve relative dates ("Thursday") against the call date, as YYYY-MM-DD.
- `next_action` goes in `qualification` as "<kind> | <owner> | <due or -> | <action>".
```

- [ ] **Step 14: Update `.gitignore`**

Add these lines if they're absent: `.dev.vars*`, `.env*`, `node_modules/`, `dist/`, `.wrangler/`. `private/` is already ignored. Verify:

```bash
git check-ignore -v private/scrub-names.txt
```

Expected: a line naming `.gitignore` and `private/`.

- [ ] **Step 15: Commit**

```bash
git add -A && npm run scan && git commit -m "Slice 1: scaffold Worker, Vite, tests, staged-diff scan"
```

---

### Task 2: Port the core (redact, guard, validate, schema, types, extract) with its tests

**Files:**
- Create: `src/core/redact.ts`, `src/core/guard.ts`, `src/core/validate.ts`, `src/core/schema.ts`, `src/core/types.ts`, `src/core/extract.ts`, `test/core/validate.test.ts`, `test/core/spans.test.ts`, `test/core/structure.test.ts`, `test/core/qualification.test.ts`, `test/core/redact.test.ts`, `test/core/extract.test.ts`, `test/core/port.test.ts`
- Create (private): `private/prompts/call.md`, `private/prompts/script-criteria.md`, `private/regression/*.json`, `private/edge-cases.md`

**Interfaces:**
- Produces (exact exports later tasks use):
  - `redact.ts`: `redactTranscript(raw: string): RedactionResult` (has `.text` and counts; read the source for exact field names), `SSN_SHAPE`, `LONG_DIGIT_RUN`
  - `guard.ts`: `class UnredactedTranscriptError extends Error`, `assertRedacted(transcript: string): string[]`
  - `validate.ts`: `validateForWriteback(extraction, transcript, callDate: Date): WritebackValidationResult`, `canonicalizeSpan(raw: string): string`, `summarizeFailures(f: ValidationFailure[]): string`, `ENUM_VALUES`, and the types `WritebackValidationResult`, `ValidationFailure`, `NextAction`, `Guardrails`
  - `types.ts`: `interface Extraction`
  - `extract.ts`: `buildExtractionRequest`, `parseExtractionResponse`, `renderPrompt(template, vars)`, `readUsage`, `runCost`, `totalTokens`, `ModelPrice`, `RunUsage`, `ExtractionResult`, `ExtractionRefusedError`, `ExtractionIncompleteError`, `DEFAULT_MODEL`, `DEFAULT_EFFORT`, and `extract(input, apiKey, fetchFn: typeof fetch = fetch): Promise<ExtractionResult>`

- [ ] **Step 1: Write the port invariants test first**

```ts
// test/core/port.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const coreFiles = readdirSync(new URL('../../src/core/', import.meta.url)).filter((f) => f.endsWith('.ts'));

test('no NUL bytes in core sources (git would treat the file as binary)', () => {
  for (const f of coreFiles) {
    const buf = readFileSync(new URL(`../../src/core/${f}`, import.meta.url));
    assert.equal(buf.includes(0), false, `${f} contains a NUL byte`);
  }
});

test('core imports nothing outside src/core', () => {
  for (const f of coreFiles) {
    const src = readFileSync(new URL(`../../src/core/${f}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      assert.match(m[1], /^\.\/[\w-]+\.ts$/, `${f} imports ${m[1]}`);
    }
  }
});

test('the six ported modules exist', () => {
  for (const f of ['redact.ts', 'guard.ts', 'validate.ts', 'schema.ts', 'types.ts', 'extract.ts']) {
    assert.ok(coreFiles.includes(f), `missing ${f}`);
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:core`
Expected: FAIL on "the six ported modules exist".

- [ ] **Step 3: Copy the modules**

```bash
SRC="/c/Users/danxc/OneDrive/Desktop/AI Resources/workspaces/aquarius-ops/rate-audit/rate-engine"
mkdir -p src/core test/core
cp "$SRC/src/redact.ts" "$SRC/src/validate.ts" "$SRC/src/schema.ts" "$SRC/src/extract.ts" src/core/
```

- [ ] **Step 4: Fix the NUL byte in `validate.ts`**

At about line 402, `const NOT_A_NUMBER = '<raw NUL>';` holds a literal 0x00 character. Replace it with the escape:

```bash
python - <<'EOF'
p='src/core/validate.ts'; b=open(p,'rb').read()
assert b.count(b'\x00')==1
open(p,'wb').write(b.replace(b'\x00', b'\\u0000'))
EOF
```

The result must read `const NOT_A_NUMBER = '\u0000';`. Behaviour is identical; it's the same one-character string.

- [ ] **Step 5: Create `types.ts` and `guard.ts`, and repoint `extract.ts`**

`types.ts`: copy the `Extraction` interface verbatim from `$SRC/src/writeback.ts` (the block starting `export interface Extraction extends SpannedExtraction, StructuralFields {`), with this header:

```ts
// The step-5 output shape. Span-carrying fields accept a bare value or {value, evidence}.
import type { SpannedExtraction, StructuralFields } from './validate.ts';
```

`guard.ts`: copy `UnredactedTranscriptError` and `assertRedacted` verbatim from `$SRC/src/writeback.ts`, with this header:

```ts
import { SSN_SHAPE, LONG_DIGIT_RUN } from './redact.ts';
```

In `src/core/extract.ts`, change `import type { Extraction } from './writeback.ts';` to `import type { Extraction } from './types.ts';`, and make `fetch` injectable:

```ts
export async function extract(
  input: BuildExtractionRequestInput,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<ExtractionResult> {
  const req = buildExtractionRequest(input);
  const res = await fetchFn(req.url, {
    method: 'POST',
    headers: { ...req.headers, 'x-api-key': apiKey },
    body: JSON.stringify(req.body),
  });
  // ...rest unchanged
```

- [ ] **Step 6: Scrub comments in all six files**

Run the scan pattern list directly over the files:

```bash
grep -nEif <(grep -v '^#' private/scrub-names.txt) src/core/*.ts
grep -nE "D-[0-9]+|Codex|WF-[0-9]|Airtable|n8n|Quo|Hub|Run Log|first live day" src/core/*.ts
```

For each hit, rewrite the comment to keep the *rule* and drop the *history*. Example: `D-35 (2026-09-20): unlike a number, a next_action ...` → `Unlike a number, a next_action ...`. Airtable/n8n/Run Log wording → "the store" / "the run record". **Do not change any code**, only comments and string literals that are names in examples. If a string literal that matters to behaviour contains a name, stop and report it (expected: none in these six files). Repeat both greps until they return nothing.

- [ ] **Step 7: Run the invariants test**

Run: `npm run test:core`
Expected: PASS for all three tests in `port.test.ts`.

- [ ] **Step 8: Port the unit suites**

```bash
cp "$SRC/test/validate.test.ts" "$SRC/test/spans.test.ts" "$SRC/test/structure.test.ts" \
   "$SRC/test/qualification.test.ts" "$SRC/test/redact.test.ts" test/core/
sed -i "s#'\.\./src/\([a-z-]*\)\.ts'#'../../src/core/\1.ts'#g" test/core/*.test.ts
sed -i "s#'../../src/core/writeback.ts'#'../../src/core/guard.ts'#" test/core/redact.test.ts
```

`redact.test.ts` reads `fixtures/regression/R-07-application-intake.json`. Point it at the private copy and skip the test when it's absent:

```ts
import { existsSync, readFileSync } from 'node:fs';
const R07_URL = new URL('../../private/regression/R-07-application-intake.json', import.meta.url);
const R07 = existsSync(R07_URL) ? JSON.parse(readFileSync(R07_URL, 'utf8')) : null;
// each test that uses R07: test('...', { skip: R07 ? false : 'private regression set absent' }, () => { ... })
```

- [ ] **Step 9: Port `extract.test.ts` (extract-only parts)**

Copy `$SRC/test/extract.test.ts` to `test/core/extract.test.ts`. Delete every test that imports or uses `buildWriteback`, `CONTACT_FIELDS`/`schema-contract`, or reads `prompts/*.md`, and remove those imports. Keep the tests for `buildExtractionRequest`, `parseExtractionResponse`, `renderPrompt`, `readUsage`, `runCost` and the schema invariants (`additionalProperties:false`, enum identity). Then add:

```ts
test('extract() uses the injected fetch and never puts the key in the body', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({
      stop_reason: 'end_turn', model: 'claude-opus-5-5',
      content: [{ type: 'text', text: '{"crm_note":"x"}' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await extract({ redactedTranscript: 'hello', systemPrompt: 'sys' }, 'k-123', fakeFetch);
  assert.equal(r.extraction.crm_note, 'x');
  assert.equal((seen!.init.headers as Record<string, string>)['x-api-key'], 'k-123');
  assert.ok(!String(seen!.init.body).includes('k-123'));
});
```

- [ ] **Step 10: Scrub names in the tests**

```bash
grep -nEif <(grep -v '^#' private/scrub-names.txt) test/core/*.ts
```

Replace every hit using this Tallbrook roster (keep the same role, keep accents where a Spanish name was used):

| Role | Tallbrook name | Aliases to use where the source had spoken variants |
|---|---|---|
| Owner / loan officer | Renata Cole | renata |
| Assistant (bilingual) | Marcus Webb | marcus, marco |
| Processor | Priya Shah | priya |
| Realtor partner | Grant Hollis | grant |

Speaker labels like `<LO>:` → `Renata:`. Re-run the grep until it's empty. Also grep for `D-[0-9]+|Codex|Airtable|n8n|Quo` in test names and strip the history from the titles (keep the rule).

- [ ] **Step 11: Run all core tests**

Run: `npm run test:core`
Expected: PASS. The count must equal the source's count for these five files (see `grep -c "^\s*test(" "$SRC/test/<file>"`), minus the deleted extract tests, plus 4 new. **Any failing ported test is a port bug, not a test to edit.** Use superpowers:systematic-debugging.

- [ ] **Step 12: Port the private material**

```bash
mkdir -p private/prompts private/regression
cp "$SRC/prompts/call.md" "$SRC/prompts/script-criteria.md" private/prompts/
cp "$SRC"/fixtures/regression/R-*.json private/regression/
cp "$SRC/README.md" private/edge-cases.md
```

Then, in `private/prompts/call.md`: replace the team roster section's body with `{{team_roster}}` and every lender/team name with `{{org_name}}`. In `private/regression/*.json`: rename people per the Step 10 table. Fixture client names that aren't in `scrub-names.txt` stay as they are (they were fabricated), but check each one by eye. In `script-criteria.md`, replace the team name. Then run:

```bash
grep -lEif <(grep -v '^#' private/scrub-names.txt) private/prompts/* private/regression/*
```

Expected: no files. (`private/` is never committed; this keeps the private demo prompt itself clean of client names.)

- [ ] **Step 13: Write `scripts/regress.ts` (public runner over the private set)**

```ts
// Runs the private regression set if present. Asserts each fixture's `expected` extraction
// survives validation (the false-drop guard). Probe semantics live in the fixtures themselves.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { validateForWriteback, summarizeFailures } from '../src/core/validate.ts';

const DIR = new URL('../private/regression/', import.meta.url);
if (!existsSync(DIR)) {
  console.log('regress: private/regression absent; skipping');
  process.exit(0);
}
let failed = 0;
for (const f of readdirSync(DIR).filter((n) => n.endsWith('.json')).sort()) {
  const fx = JSON.parse(readFileSync(new URL(f, DIR), 'utf8'));
  const r = validateForWriteback(fx.expected, fx.transcript, new Date(fx.call_date + 'T12:00:00Z'));
  const drops = r.failures.filter((x) => x.reason !== 'older_call_kept');
  if (drops.length) {
    failed++;
    console.log(`FAIL ${fx.id}: ${summarizeFailures(drops)}`);
  } else console.log(`ok   ${fx.id}`);
}
process.exit(failed ? 1 : 0);
```

Run: `npm run regress`
Expected: one line per fixture. If a fixture's `expected` was always meant to carry a failure (check its `probes`/`why` in the private copy), compare against `$SRC`'s own `npm run regress` output: the two must match fixture for fixture. A difference means the rename broke a quote (a renamed name inside an evidence span must be renamed identically in the transcript).

- [ ] **Step 14: Commit**

```bash
git add src/core test/core scripts/regress.ts && npm run scan && git commit -m "Port extraction core: redact, guard, validate, schema, extract (+ tests)"
```

---

### Task 3: `locateSpan`: find a validated quote's character range

**Files:**
- Create: `src/core/locate.ts`, `test/core/locate.test.ts`

**Interfaces:**
- Consumes: `canonicalizeSpan(raw: string): string` from `./validate.ts`
- Produces: `interface Located { start: number; end: number }`, `locateSpan(transcript: string, quote: string): Located | null`. `transcript.slice(start, end)` is the raw text a person sees highlighted.

- [ ] **Step 1: Write the failing tests**

```ts
// test/core/locate.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateSpan } from '../../src/core/locate.ts';

const T = [
  'Renata: Thanks for jumping on. So we\u2019d be looking at about thirty two hundred a month, all in.',
  'Client: Okay. And the rate?',
  'Renata: Between six and a half and six and seven eighths \u2014 that\u2019s 6.875%.',
].join('\n');

test('finds an exact quote and returns the raw range', () => {
  const q = 'looking at about thirty two hundred a month';
  const r = locateSpan(T, q)!;
  assert.equal(T.slice(r.start, r.end), 'looking at about thirty two hundred a month,');
});

test('curly vs straight apostrophes still match', () => {
  const r = locateSpan(T, "So we'd be looking at about thirty two hundred")!;
  assert.equal(T.slice(r.start, r.end), 'So we\u2019d be looking at about thirty two hundred');
});

test('a quote missing the trailing % still matches', () => {
  const r = locateSpan(T, 'six and seven eighths that\'s 6.875')!;
  assert.ok(T.slice(r.start, r.end).startsWith('six and seven eighths'));
  assert.ok(T.slice(r.start, r.end).endsWith('6.875%.'));
});

test('speaker labels are never part of a match', () => {
  assert.equal(locateSpan(T, 'Renata Thanks for jumping on'), null);
  const r = locateSpan(T, 'Thanks for jumping on')!;
  assert.equal(r.start, T.indexOf('Thanks'));
});

test('returns null when the quote is not there', () => {
  assert.equal(locateSpan(T, 'approved up to four hundred thousand'), null);
});

test('empty quote returns null', () => {
  assert.equal(locateSpan(T, '   '), null);
});

test('word boundaries: "in rent" does not match "in rental"', () => {
  assert.equal(locateSpan('Renata: it is in rental condition', 'in rent'), null);
});

test('accents fold on both sides', () => {
  const t = 'Marcus: El pago está en dos mil cuatrocientos al mes.';
  const r = locateSpan(t, 'el pago esta en dos mil cuatrocientos')!;
  assert.equal(t.slice(r.start, r.end), 'El pago está en dos mil cuatrocientos');
});

test('CRLF transcripts: offsets still point at the right characters', () => {
  const crlf = T.replace(/\n/g, '\r\n');
  const r = locateSpan(crlf, 'And the rate')!;
  assert.equal(crlf.slice(r.start, r.end), 'And the rate?');
});

test('a phrase said twice returns the first occurrence, and it is a real match', () => {
  const t = 'Client: we pay thirty two hundred a month now.\nRenata: keep it at thirty two hundred a month.';
  const r = locateSpan(t, 'thirty two hundred a month')!;
  assert.equal(r.start, t.indexOf('thirty'));
  assert.equal(t.slice(r.start, r.end), 'thirty two hundred a month.');
});

test('hyphenated number words split into canonical words', () => {
  const t = 'Renata: about thirty-two hundred a month';
  const r = locateSpan(t, 'about thirty two hundred a month')!;
  assert.equal(t.slice(r.start, r.end), 'about thirty-two hundred a month');
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `node --experimental-strip-types --test test/core/locate.test.ts`
Expected: FAIL (cannot find module `locate.ts`).

- [ ] **Step 3: Implement**

```ts
// src/core/locate.ts
// Maps a validated (canonical-form) quote back to a character range in the raw redacted
// transcript, so the UI can highlight the exact words a person said.
//
// Each raw whitespace token is canonicalised on its own with the SAME function the validator
// uses, so a token-level match is a validator-level match. Every canonicalisation rule works
// inside a single token (case, accents, quotes, apostrophes, %, punctuation, thousands
// separators), except hyphen splitting, which yields several canonical words that all map back
// to the one raw token.
import { canonicalizeSpan } from './validate.ts';

export interface Located {
  start: number;
  end: number;
}

interface Tok {
  canon: string;
  start: number;
  end: number;
}

/** Same label shape the validator strips: up to ~40 chars then ": " at line start. */
const LABEL = /^\s*([\p{L}\p{N}+()' .-]{1,40}?):\s+/u;

function tokenize(transcript: string): Tok[] {
  const toks: Tok[] = [];
  let lineStart = 0;
  for (const line of transcript.split('\n')) {
    const m = LABEL.exec(line);
    const bodyOffset = m ? m[0].length : 0;
    const body = line.slice(bodyOffset);
    const re = /\S+/g;
    let w: RegExpExecArray | null;
    while ((w = re.exec(body))) {
      const c = canonicalizeSpan(w[0]);
      if (c === '') continue;
      const start = lineStart + bodyOffset + w.index;
      const end = start + w[0].length;
      for (const part of c.split(' ')) toks.push({ canon: part, start, end });
    }
    lineStart += line.length + 1;
  }
  return toks;
}

export function locateSpan(transcript: string, quote: string): Located | null {
  const q = canonicalizeSpan(quote || '');
  if (q === '') return null;
  const words = q.split(' ');
  const toks = tokenize(transcript || '');
  outer: for (let i = 0; i + words.length <= toks.length; i++) {
    for (let j = 0; j < words.length; j++) {
      if (toks[i + j].canon !== words[j]) continue outer;
    }
    return { start: toks[i].start, end: toks[i + words.length - 1].end };
  }
  return null;
}
```

Note: `\r` stays at the end of a CRLF line, and `\S+` never includes it, so offsets stay exact.

- [ ] **Step 4: Run and confirm everything passes**

Run: `npm run test:core`
Expected: PASS, all suites including the 11 `locate` tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/locate.ts test/core/locate.test.ts && npm run scan && git commit -m "Add locateSpan: map a validated quote to its range in the transcript"
```

---

### Task 4: `buildProposals`: validated extraction to Proposals and Dropped

**Files:**
- Create: `src/core/proposals.ts`, `test/core/proposals.test.ts`

**Interfaces:**
- Consumes: `validateForWriteback`, `WritebackValidationResult`, `ValidationFailure` (`./validate.ts`), `locateSpan` (`./locate.ts`)
- Produces:

```ts
export type ProposalKind = 'follow_up' | 'task' | 'figure';
export interface ProposalDraft { kind: ProposalKind; field: string; label: string; value: string; quote: string; start: number | null; end: number | null }
export interface DroppedDraft { field: string; value: string; reason: string }
export interface ProposalSet { proposals: ProposalDraft[]; dropped: DroppedDraft[]; unlocated: string[] }
export function buildProposals(v: WritebackValidationResult, redactedTranscript: string): ProposalSet
```

- [ ] **Step 1: Write the failing tests (they drive the real validator)**

```ts
// test/core/proposals.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateForWriteback } from '../../src/core/validate.ts';
import { buildProposals } from '../../src/core/proposals.ts';

const CALL_DATE = new Date('2026-10-01T15:00:00Z');
const T = [
  'Renata: Good news, the lender came back and we can get you approved up to four hundred thousand on this one.',
  'Client: Wow. And monthly, where does that land for us?',
  'Renata: So we would be looking at about thirty two hundred a month all in with taxes and insurance.',
  'Client: Okay, can you call me back on Thursday after I talk to my husband about it?',
  'Renata: Absolutely, I will call you back on Thursday and Marcus will send the fee sheet over today.',
].join('\n');

const QUOTE_PRICE = 'we can get you approved up to four hundred thousand on this one';
const QUOTE_PAY = 'we would be looking at about thirty two hundred a month all in';
const QUOTE_FU = 'I will call you back on Thursday and Marcus will send';
const QUOTE_TASK = 'Marcus will send the fee sheet over today';

function run(extraction: Record<string, unknown>) {
  const v = validateForWriteback(extraction as never, T, CALL_DATE);
  return buildProposals(v, T);
}

test('grounded figures and follow-up become proposals; a paraphrased task does not', () => {
  const s = run({
    guardrails: {
      approved_price: { value: 400000, evidence: QUOTE_PRICE },
      max_payment: { value: 3200, evidence: QUOTE_PAY },
    },
    follow_up_date: { value: '2026-10-08', evidence: QUOTE_FU },
    qualification: [{ field: 'next_action', value: 'deliverable | Marcus | 2026-10-01 | Send the fee sheet', evidence: QUOTE_TASK + ' as promised' }],
  });
  const kinds = s.proposals.map((p) => `${p.kind}:${p.field}`).sort();
  assert.deepEqual(kinds, ['figure:approved_price', 'figure:max_payment', 'follow_up:follow_up_date']);
  for (const p of s.proposals) {
    assert.notEqual(p.start, null, `${p.field} not located`);
    assert.ok(T.slice(p.start!, p.end!).length > 0);
  }
  const price = s.proposals.find((p) => p.field === 'approved_price')!;
  assert.equal(price.value, '400000');
  assert.equal(price.label, 'Approved up to');
});

test('a task with a verified quote becomes a task proposal', () => {
  const s = run({
    qualification: [{ field: 'next_action', value: 'deliverable | Marcus | 2026-10-01 | Send the fee sheet', evidence: 'I will call you back on Thursday and Marcus will send the fee sheet over today' }],
  });
  const task = s.proposals.find((p) => p.kind === 'task');
  assert.ok(task, 'expected a task');
  assert.equal(task!.value, 'Send the fee sheet');
  assert.match(task!.label, /due 2026-10-01/);
});

test('a task whose quote is not verbatim is dropped, never proposed', () => {
  const s = run({
    qualification: [{ field: 'next_action', value: 'deliverable | Marcus | - | Send the fee sheet', evidence: 'Marcus promised to email the fee sheet to the client by the end of today' }],
  });
  assert.equal(s.proposals.filter((p) => p.kind === 'task').length, 0);
  assert.ok(s.dropped.some((d) => d.field === 'next_action'));
});

test('a fabricated figure lands in dropped with its reason', () => {
  const s = run({ guardrails: { max_out_of_pocket: { value: 25000, evidence: QUOTE_PAY } } });
  assert.equal(s.proposals.length, 0);
  const d = s.dropped.find((x) => x.field === 'max_out_of_pocket')!;
  assert.equal(d.value, '25000');
  assert.ok(d.reason.length > 0);
});

test('a bare value with no quote is dropped as evidence_missing, even if the number was said', () => {
  const s = run({ guardrails: { max_payment: 3200 } });
  assert.equal(s.proposals.length, 0);
  assert.deepEqual(s.dropped, [{ field: 'max_payment', value: '3200', reason: 'evidence_missing' }]);
});

test('nothing discussed gives nothing', () => {
  const s = run({ guardrails: { approved_price: null }, follow_up_date: null });
  assert.deepEqual(s, { proposals: [], dropped: [], unlocated: [] });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `node --experimental-strip-types --test test/core/proposals.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/core/proposals.ts
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

  const guardrails = v.guardrails as Record<string, unknown>;
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
```

- [ ] **Step 4: Run and confirm everything passes**

Run: `npm run test:core`
Expected: PASS. If a test fails because the real validator shapes something differently than assumed (e.g. the evidence key for `follow_up_date`, or whether an unverified `next_action` survives to `v.next_action`), read the validator and fix `proposals.ts`, not the validator. Keep the test's intent.

- [ ] **Step 5: Commit**

```bash
git add src/core/proposals.ts test/core/proposals.test.ts && npm run scan && git commit -m "Add buildProposals: quote it or drop it"
```

---

### Task 5: D1 schema and data access

**Files:**
- Modify: `migrations/0001_init.sql`
- Create: `src/worker/db.ts`, `test/worker/db.test.ts`

**Interfaces:**
- Consumes: `ProposalDraft`, `DroppedDraft` from `src/core/proposals.ts`
- Produces:

```ts
export const ORG_ID = 'org_tallbrook';
export type CallStatus = 'processing' | 'ready' | 'failed';
export interface RunRecord { model: string; effort: string; inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; costUsd: number | null; durationMs: number; failures: string; needsReviewReasons: string; extractionJson: string }
export interface CallContext { crmNote: string | null; urgency: string | null }
export interface CallView { id: string; status: CallStatus; error: string | null; callDate: string; transcript: string; needsReview: boolean; context: CallContext; proposals: ProposalRow[]; dropped: DroppedDraft[] }
export interface ProposalRow extends ProposalDraft { id: string; status: 'proposed' | 'approved' | 'rejected'; rejectReason: string | null; decidedAt: string | null }
export type RejectReason = 'wrong_value' | 'wrong_person' | 'not_agreed' | 'other';
insertCall(db, { id, callDate, redactedTranscript }): Promise<void>
getCallInput(db, id): Promise<{ redactedTranscript: string; callDate: string } | null>
saveResults(db, id, { proposals, dropped, run, needsReview, context }): Promise<void>
markFailed(db, id, error: string): Promise<void>
markProcessing(db, id): Promise<void>
getCallView(db, id): Promise<CallView | null>
decideProposal(db, proposalId, decision: { status: 'approved' } | { status: 'rejected'; reason: RejectReason | null }): Promise<'ok' | 'not_found' | 'already_decided'>
```

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0001_init.sql
CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  call_date TEXT NOT NULL,
  redacted_transcript TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing','ready','failed')),
  error TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  crm_note TEXT,
  urgency TEXT
);
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  call_id TEXT NOT NULL REFERENCES calls(id),
  kind TEXT NOT NULL CHECK (kind IN ('follow_up','task','figure')),
  field TEXT NOT NULL,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  quote TEXT NOT NULL,
  start_offset INTEGER,
  end_offset INTEGER,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')),
  reject_reason TEXT CHECK (reject_reason IN ('wrong_value','wrong_person','not_agreed','other')),
  decided_at TEXT
);
CREATE INDEX proposals_call ON proposals(call_id);
CREATE TABLE dropped (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  call_id TEXT NOT NULL REFERENCES calls(id),
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX dropped_call ON dropped(call_id);
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  call_id TEXT NOT NULL REFERENCES calls(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cost_usd REAL,
  duration_ms INTEGER NOT NULL,
  failures TEXT NOT NULL,
  needs_review_reasons TEXT NOT NULL,
  extraction_json TEXT NOT NULL
);
```

- [ ] **Step 2: Write the failing tests**

```ts
// test/worker/db.test.ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { insertCall, getCallInput, saveResults, getCallView, decideProposal, markFailed, type RunRecord } from '../../src/worker/db.ts';

const RUN: RunRecord = {
  model: 'claude-opus-5-5', effort: 'high', inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0,
  cacheReadTokens: 0, costUsd: null, durationMs: 10, failures: '', needsReviewReasons: '', extractionJson: '{}',
};

async function seed(id: string) {
  await insertCall(env.DB, { id, callDate: '2026-10-01', redactedTranscript: 'Renata: hello there' });
  await saveResults(env.DB, id, {
    proposals: [{ kind: 'figure', field: 'max_payment', label: 'Max monthly payment', value: '3200', quote: 'hello there', start: 8, end: 19 }],
    dropped: [{ field: 'max_out_of_pocket', value: '25000', reason: 'not_grounded_in_transcript' }],
    run: RUN, needsReview: false, context: { crmNote: 'Called about payment.', urgency: 'normal' },
  });
}

describe('db', () => {
  it('a new call is processing and returns its input', async () => {
    await insertCall(env.DB, { id: 'c1', callDate: '2026-10-01', redactedTranscript: 'x' });
    expect(await getCallInput(env.DB, 'c1')).toEqual({ redactedTranscript: 'x', callDate: '2026-10-01' });
    expect((await getCallView(env.DB, 'c1'))!.status).toBe('processing');
  });

  it('saveResults makes the call ready with proposals, dropped and context', async () => {
    await seed('c2');
    const v = (await getCallView(env.DB, 'c2'))!;
    expect(v.status).toBe('ready');
    expect(v.context).toEqual({ crmNote: 'Called about payment.', urgency: 'normal' });
    expect(v.proposals).toHaveLength(1);
    expect(v.proposals[0]).toMatchObject({ field: 'max_payment', status: 'proposed', start: 8, end: 19 });
    expect(v.dropped).toEqual([{ field: 'max_out_of_pocket', value: '25000', reason: 'not_grounded_in_transcript' }]);
  });

  it('approve then reject: the second decision is refused', async () => {
    await seed('c3');
    const p = (await getCallView(env.DB, 'c3'))!.proposals[0];
    expect(await decideProposal(env.DB, p.id, { status: 'approved' })).toBe('ok');
    expect(await decideProposal(env.DB, p.id, { status: 'rejected', reason: 'other' })).toBe('already_decided');
    const after = (await getCallView(env.DB, 'c3'))!.proposals[0];
    expect(after.status).toBe('approved');
    expect(after.decidedAt).not.toBeNull();
  });

  it('reject stores the optional reason', async () => {
    await seed('c4');
    const p = (await getCallView(env.DB, 'c4'))!.proposals[0];
    expect(await decideProposal(env.DB, p.id, { status: 'rejected', reason: 'wrong_person' })).toBe('ok');
    expect((await getCallView(env.DB, 'c4'))!.proposals[0].rejectReason).toBe('wrong_person');
  });

  it('unknown proposal is not_found; unknown call is null', async () => {
    expect(await decideProposal(env.DB, 'nope', { status: 'approved' })).toBe('not_found');
    expect(await getCallView(env.DB, 'nope')).toBeNull();
  });

  it('markFailed records the error', async () => {
    await insertCall(env.DB, { id: 'c5', callDate: '2026-10-01', redactedTranscript: 'x' });
    await markFailed(env.DB, 'c5', 'refused');
    expect(await getCallView(env.DB, 'c5')).toMatchObject({ status: 'failed', error: 'refused' });
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `npm run test:worker`
Expected: FAIL (cannot resolve `src/worker/db.ts`).

- [ ] **Step 4: Implement `src/worker/db.ts`**

```ts
import type { DroppedDraft, ProposalDraft } from '../core/proposals.ts';

export const ORG_ID = 'org_tallbrook';
export type CallStatus = 'processing' | 'ready' | 'failed';
export type RejectReason = 'wrong_value' | 'wrong_person' | 'not_agreed' | 'other';

export interface RunRecord {
  model: string; effort: string; inputTokens: number; outputTokens: number;
  cacheWriteTokens: number; cacheReadTokens: number; costUsd: number | null; durationMs: number;
  failures: string; needsReviewReasons: string; extractionJson: string;
}
export interface CallContext { crmNote: string | null; urgency: string | null }
export interface ProposalRow extends ProposalDraft {
  id: string; status: 'proposed' | 'approved' | 'rejected'; rejectReason: string | null; decidedAt: string | null;
}
export interface CallView {
  id: string; status: CallStatus; error: string | null; callDate: string; transcript: string;
  needsReview: boolean; context: CallContext; proposals: ProposalRow[]; dropped: DroppedDraft[];
}

export async function insertCall(db: D1Database, c: { id: string; callDate: string; redactedTranscript: string }) {
  await db.prepare(
    `INSERT INTO calls (id, org_id, call_date, redacted_transcript, status) VALUES (?, ?, ?, ?, 'processing')`,
  ).bind(c.id, ORG_ID, c.callDate, c.redactedTranscript).run();
}

export async function getCallInput(db: D1Database, id: string) {
  const r = await db.prepare(`SELECT redacted_transcript, call_date FROM calls WHERE id = ? AND org_id = ?`)
    .bind(id, ORG_ID).first<{ redacted_transcript: string; call_date: string }>();
  return r ? { redactedTranscript: r.redacted_transcript, callDate: r.call_date } : null;
}

export async function markProcessing(db: D1Database, id: string) {
  await db.prepare(`UPDATE calls SET status = 'processing', error = NULL WHERE id = ? AND org_id = ?`).bind(id, ORG_ID).run();
}

export async function markFailed(db: D1Database, id: string, error: string) {
  await db.prepare(`UPDATE calls SET status = 'failed', error = ? WHERE id = ? AND org_id = ?`).bind(error, id, ORG_ID).run();
}

export async function saveResults(
  db: D1Database,
  callId: string,
  r: { proposals: ProposalDraft[]; dropped: DroppedDraft[]; run: RunRecord; needsReview: boolean; context: CallContext },
) {
  const stmts: D1PreparedStatement[] = [
    // Idempotent on Workflow retry: clear any rows a previous attempt wrote.
    db.prepare(`DELETE FROM proposals WHERE call_id = ? AND status = 'proposed'`).bind(callId),
    db.prepare(`DELETE FROM dropped WHERE call_id = ?`).bind(callId),
  ];
  for (const p of r.proposals) {
    stmts.push(db.prepare(
      `INSERT INTO proposals (id, org_id, call_id, kind, field, label, value, quote, start_offset, end_offset)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), ORG_ID, callId, p.kind, p.field, p.label, p.value, p.quote, p.start, p.end));
  }
  for (const d of r.dropped) {
    stmts.push(db.prepare(`INSERT INTO dropped (id, org_id, call_id, field, value, reason) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), ORG_ID, callId, d.field, d.value, d.reason));
  }
  const u = r.run;
  stmts.push(db.prepare(
    `INSERT INTO runs (id, org_id, call_id, model, effort, input_tokens, output_tokens, cache_write_tokens,
       cache_read_tokens, cost_usd, duration_ms, failures, needs_review_reasons, extraction_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), ORG_ID, callId, u.model, u.effort, u.inputTokens, u.outputTokens, u.cacheWriteTokens,
    u.cacheReadTokens, u.costUsd, u.durationMs, u.failures, u.needsReviewReasons, u.extractionJson));
  stmts.push(db.prepare(
    `UPDATE calls SET status = 'ready', error = NULL, needs_review = ?, crm_note = ?, urgency = ? WHERE id = ? AND org_id = ?`,
  ).bind(r.needsReview ? 1 : 0, r.context.crmNote, r.context.urgency, callId, ORG_ID));
  await db.batch(stmts);
}

export async function getCallView(db: D1Database, id: string): Promise<CallView | null> {
  const c = await db.prepare(`SELECT * FROM calls WHERE id = ? AND org_id = ?`).bind(id, ORG_ID).first<Record<string, unknown>>();
  if (!c) return null;
  const ps = await db.prepare(`SELECT * FROM proposals WHERE call_id = ? ORDER BY kind, field`).bind(id).all<Record<string, unknown>>();
  const ds = await db.prepare(`SELECT field, value, reason FROM dropped WHERE call_id = ? ORDER BY field`).bind(id).all<DroppedDraft>();
  return {
    id,
    status: c.status as CallStatus,
    error: (c.error as string) ?? null,
    callDate: c.call_date as string,
    transcript: c.redacted_transcript as string,
    needsReview: c.needs_review === 1,
    context: { crmNote: (c.crm_note as string) ?? null, urgency: (c.urgency as string) ?? null },
    proposals: ps.results.map((p) => ({
      id: p.id as string, kind: p.kind as ProposalRow['kind'], field: p.field as string, label: p.label as string,
      value: p.value as string, quote: p.quote as string,
      start: (p.start_offset as number | null) ?? null, end: (p.end_offset as number | null) ?? null,
      status: p.status as ProposalRow['status'], rejectReason: (p.reject_reason as string) ?? null,
      decidedAt: (p.decided_at as string) ?? null,
    })),
    dropped: ds.results,
  };
}

export async function decideProposal(
  db: D1Database,
  proposalId: string,
  d: { status: 'approved' } | { status: 'rejected'; reason: RejectReason | null },
): Promise<'ok' | 'not_found' | 'already_decided'> {
  const reason = d.status === 'rejected' ? d.reason : null;
  const res = await db.prepare(
    `UPDATE proposals SET status = ?, reject_reason = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND org_id = ? AND status = 'proposed'`,
  ).bind(d.status, reason, proposalId, ORG_ID).run();
  if (res.meta.changes === 1) return 'ok';
  const exists = await db.prepare(`SELECT 1 AS x FROM proposals WHERE id = ? AND org_id = ?`).bind(proposalId, ORG_ID).first();
  return exists ? 'already_decided' : 'not_found';
}
```

- [ ] **Step 5: Run and confirm everything passes**

Run: `npm run test:worker`
Expected: PASS (health plus 6 db tests).

- [ ] **Step 6: Commit**

```bash
git add migrations src/worker/db.ts test/worker/db.test.ts && npm run scan && git commit -m "D1 schema and data access for calls, proposals, dropped, runs"
```

---

### Task 6: Pipeline, prompt, `ProcessCall` Workflow and the call API

**Files:**
- Create: `src/core/config.ts`, `src/core/pipeline.ts`, `test/core/pipeline.test.ts`, `src/worker/prompt.ts`, `src/worker/workflow.ts`, `test/worker/api.test.ts`
- Modify: `src/worker/index.ts`, `src/worker/routes.ts`, `wrangler.jsonc` (restore `workflows` if removed in Task 1)

**Interfaces:**
- Consumes: `extract`, `renderPrompt`, `readUsage`, `runCost`, `DEFAULT_MODEL`, `DEFAULT_EFFORT` (`extract.ts`); `validateForWriteback`, `summarizeFailures` (`validate.ts`); `buildProposals` (`proposals.ts`); `redactTranscript` (`redact.ts`); `assertRedacted`, `UnredactedTranscriptError` (`guard.ts`); the `db.ts` functions
- Produces:
  - `config.ts`: `ORG_NAME = 'Tallbrook Home Loans'`, `TEAM_ROSTER: string`, `PRICING: Record<string, ModelPrice>`, `CONFIDENCE_THRESHOLD = 0.6`, `MIN_TRANSCRIPT_WORDS = 20`, `promptVars(callDate: string, scriptCriteria: string): Record<string, string>`
  - `pipeline.ts`: `processTranscript(input: { redactedTranscript: string; callDate: string; systemPrompt: string; apiKey: string; fetchFn?: typeof fetch; now?: () => number }): Promise<PipelineResult>`, where `PipelineResult = { proposals; dropped; unlocated; needsReview: boolean; context: CallContext; run: RunRecord }` (the `CallContext`/`RunRecord` shapes are declared again in core so core stays import-free; `db.ts` types are structurally identical)
  - API: `POST /api/calls {transcript, callDate}` → `202 {id}` | `400 {error}` | `422 {error}`; `GET /api/calls/:id` → `CallView` | 404; `POST /api/proposals/:id/approve` → 200 | 404 | 409; `POST /api/proposals/:id/reject {reason?}` → 200 | 400 | 404 | 409; `POST /api/calls/:id/retry` → 202 | 404 | 409; `GET /api/samples` → `[{id, title, callDate, transcript}]`

- [ ] **Step 1: Write `src/core/config.ts`**

```ts
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
```

If `private/prompts/call.md` uses a placeholder not in this list, `renderPrompt` throws, which fails the pipeline test in Step 2 when run against the private prompt. Add the key with a "(not provided)" or "(none)" default.

- [ ] **Step 2: Write the failing pipeline test**

```ts
// test/core/pipeline.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processTranscript } from '../../src/core/pipeline.ts';

const T = [
  'Renata: Good news, the lender came back and we can get you approved up to four hundred thousand on this one.',
  'Client: Wow. And monthly, where does that land for us, roughly speaking, all in?',
  'Renata: So we would be looking at about thirty two hundred a month all in with taxes and insurance.',
].join('\n');

function fakeFetch(extraction: unknown, usage = { input_tokens: 1000, output_tokens: 500 }) {
  return (async () => new Response(JSON.stringify({
    stop_reason: 'end_turn', model: 'claude-opus-5-5',
    content: [{ type: 'text', text: JSON.stringify(extraction) }], usage,
  }), { status: 200 })) as unknown as typeof fetch;
}

test('processTranscript runs extract → validate → proposals and builds the run record', async () => {
  let t = 0;
  const r = await processTranscript({
    redactedTranscript: T, callDate: '2026-10-01', systemPrompt: 'sys', apiKey: 'k',
    now: () => (t += 1500),
    fetchFn: fakeFetch({
      crm_note: 'Pre-approval discussed.', urgency_flag: 'normal', confidence: 0.9,
      guardrails: {
        approved_price: { value: 400000, evidence: 'we can get you approved up to four hundred thousand on this one' },
        max_out_of_pocket: { value: 25000, evidence: 'we would be looking at about thirty two hundred a month all in' },
      },
    }),
  });
  assert.equal(r.proposals.length, 1);
  assert.equal(r.proposals[0].field, 'approved_price');
  assert.ok(r.dropped.some((d) => d.field === 'max_out_of_pocket'));
  assert.deepEqual(r.context, { crmNote: 'Pre-approval discussed.', urgency: 'normal' });
  assert.equal(r.run.model, 'claude-opus-5-5');
  assert.equal(r.run.inputTokens, 1000);
  assert.equal(r.run.durationMs, 1500);
  assert.equal(r.run.costUsd, (1000 * 4 + 500 * 20) / 1e6);
  assert.match(r.run.failures, /max_out_of_pocket/);
  assert.equal(r.needsReview, false);
});

test('low confidence sets needsReview with a reason', async () => {
  const r = await processTranscript({
    redactedTranscript: T, callDate: '2026-10-01', systemPrompt: 'sys', apiKey: 'k',
    fetchFn: fakeFetch({ crm_note: 'x', confidence: 0.3 }),
  });
  assert.equal(r.needsReview, true);
  assert.match(r.run.needsReviewReasons, /confidence/);
});

test('a refusal throws a named error', async () => {
  const refuse = (async () => new Response(JSON.stringify({ stop_reason: 'refusal', content: [] }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(
    processTranscript({ redactedTranscript: T, callDate: '2026-10-01', systemPrompt: 'sys', apiKey: 'k', fetchFn: refuse }),
    { name: 'ExtractionRefusedError' },
  );
});
```

If the ported `ExtractionRefusedError` doesn't set `this.name`, add `this.name = 'ExtractionRefusedError'` (and likewise for `ExtractionIncompleteError`) in `extract.ts`. That's the only allowed change to ported code in this task.

- [ ] **Step 3: Run it and confirm it fails**

Run: `node --experimental-strip-types --test test/core/pipeline.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `src/core/pipeline.ts`**

```ts
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
  const conf = res.extraction.confidence;
  if (typeof conf === 'number' && conf < CONFIDENCE_THRESHOLD) reasons.push(`confidence ${conf}`);
  if (set.unlocated.length) reasons.push(`span_unlocated: ${set.unlocated.join(', ')}`);

  const usage = res.usage; // parseExtractionResponse already ran readUsage
  return {
    proposals: set.proposals,
    dropped: set.dropped,
    unlocated: set.unlocated,
    needsReview: reasons.some((r) => !r.startsWith('span_unlocated')),
    context: {
      crmNote: res.extraction.crm_note ?? null,
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
```

`res.usage` from `parseExtractionResponse` is already a `RunUsage`. Do not pass it through `readUsage` again: that function reads the API's snake_case keys and would return zeros.

- [ ] **Step 5: Run and confirm the pipeline tests pass**

Run: `npm run test:core`
Expected: PASS.

- [ ] **Step 6: Write `src/worker/prompt.ts` and `src/worker/workflow.ts`**

```ts
// src/worker/prompt.ts
// '@prompts' resolves to private/prompts when present, else the public example (vite.config.ts).
import callMd from '@prompts/call.md?raw';
import { renderPrompt } from '../core/extract.ts';
import { promptVars } from '../core/config.ts';

const criteria = import.meta.glob('@prompts/script-criteria.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const scriptCriteria = Object.values(criteria)[0] ?? '';

export function systemPrompt(callDate: string): string {
  return renderPrompt(callMd, promptVars(callDate, scriptCriteria));
}
```

If `import.meta.glob` with an alias doesn't resolve under the Workers Vite plugin, replace it with an explicit `prompts/script-criteria.example.md` (one line: `(not provided)`) beside `call.example.md`, and import `@prompts/script-criteria.md?raw` directly.

```ts
// src/worker/workflow.ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, NonRetryableError } from 'cloudflare:workers';
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
```

- [ ] **Step 7: Write the failing API tests**

```ts
// test/worker/api.test.ts
import { describe, it, expect } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { introspectWorkflow } from 'cloudflare:test';
import { insertCall, saveResults, getCallView } from '../../src/worker/db.ts';

const BASE = 'https://verbatim.test';
const LONG = 'Renata: we can get you approved up to four hundred thousand on this one and the payment would be about thirty two hundred a month all in with taxes.';

const post = (path: string, body?: unknown) =>
  exports.default.fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

const MOCK_RESULT = {
  proposals: [{ kind: 'figure', field: 'approved_price', label: 'Approved up to', value: '400000', quote: 'approved up to four hundred thousand', start: 23, end: 59 }],
  dropped: [{ field: 'max_out_of_pocket', value: '25000', reason: 'not_grounded_in_transcript' }],
  unlocated: [], needsReview: false, context: { crmNote: 'Note.', urgency: 'normal' },
  run: { model: 'claude-opus-5-5', effort: 'high', inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: null, durationMs: 5, failures: '', needsReviewReasons: '', extractionJson: '{}' },
};

describe('POST /api/calls', () => {
  it('400 on an empty or tiny transcript, before any model spend', async () => {
    expect((await post('/api/calls', { transcript: '', callDate: '2026-10-01' })).status).toBe(400);
    expect((await post('/api/calls', { transcript: 'hi there you', callDate: '2026-10-01' })).status).toBe(400);
  });

  it('400 on a bad call date', async () => {
    expect((await post('/api/calls', { transcript: LONG, callDate: '10/01/2026' })).status).toBe(400);
  });

  it('stores only the redacted transcript and runs the workflow to ready', async () => {
    await using wf = await introspectWorkflow(env.PROCESS_CALL);
    await wf.modifyAll(async (m) => { await m.mockStepResult({ name: 'extract' }, MOCK_RESULT); });

    const withSsn = LONG + ' My social is 123-45-6789 by the way, if you need it for anything.';
    const res = await post('/api/calls', { transcript: withSsn, callDate: '2026-10-01' });
    expect(res.status).toBe(202);
    const { id } = await res.json<{ id: string }>();

    const [instance] = await wf.get();
    await instance.waitForStatus('complete');

    const view = (await getCallView(env.DB, id))!;
    expect(view.status).toBe('ready');
    expect(view.transcript).not.toContain('123-45-6789');
    expect(view.proposals).toHaveLength(1);
    expect(view.dropped).toHaveLength(1);
  });

  it('a failing extract marks the call failed', async () => {
    await using wf = await introspectWorkflow(env.PROCESS_CALL);
    await wf.modifyAll(async (m) => { await m.mockStepError({ name: 'extract' }, new Error('boom'), 3); });
    const { id } = await (await post('/api/calls', { transcript: LONG, callDate: '2026-10-01' })).json<{ id: string }>();
    const [instance] = await wf.get();
    await instance.waitForStatus('errored');
    expect((await getCallView(env.DB, id))!.status).toBe('failed');
  });
});

describe('GET /api/calls/:id and decisions', () => {
  async function seeded(id: string) {
    await insertCall(env.DB, { id, callDate: '2026-10-01', redactedTranscript: LONG });
    await saveResults(env.DB, id, MOCK_RESULT as never);
    return (await getCallView(env.DB, id))!.proposals[0].id;
  }

  it('404 for an unknown call', async () => {
    expect((await exports.default.fetch(`${BASE}/api/calls/nope`)).status).toBe(404);
  });

  it('returns the call view', async () => {
    await seeded('g1');
    const v = await (await exports.default.fetch(`${BASE}/api/calls/g1`)).json<{ status: string; proposals: unknown[] }>();
    expect(v.status).toBe('ready');
    expect(v.proposals).toHaveLength(1);
  });

  it('approve is 200, then a second approve is 409', async () => {
    const pid = await seeded('g2');
    expect((await post(`/api/proposals/${pid}/approve`)).status).toBe(200);
    expect((await post(`/api/proposals/${pid}/approve`)).status).toBe(409);
  });

  it('reject accepts a known reason, refuses an unknown one', async () => {
    const pid = await seeded('g3');
    expect((await post(`/api/proposals/${pid}/reject`, { reason: 'made_up' })).status).toBe(400);
    expect((await post(`/api/proposals/${pid}/reject`, { reason: 'wrong_person' })).status).toBe(200);
  });

  it('reject without a reason is fine', async () => {
    const pid = await seeded('g4');
    expect((await post(`/api/proposals/${pid}/reject`, {})).status).toBe(200);
  });

  it('retry is 409 unless the call failed', async () => {
    await seeded('g5');
    expect((await post('/api/calls/g5/retry')).status).toBe(409);
  });
});
```

`await wf.get()` and the exact introspection method names follow the Cloudflare docs current on 2026-10-02 (`introspectWorkflow`, `modifyAll`, `mockStepResult`, `mockStepError`, `waitForStatus`). If a name differs in the installed version, check `node_modules/@cloudflare/vitest-plugin` types and adapt the test, not the app.

- [ ] **Step 8: Run them and confirm they fail**

Run: `npm run test:worker`
Expected: FAIL (routes return 404; `ProcessCall` isn't exported).

- [ ] **Step 9: Implement the routes and export the Workflow**

```ts
// src/worker/routes.ts
import { redactTranscript } from '../core/redact.ts';
import { assertRedacted, UnredactedTranscriptError } from '../core/guard.ts';
import { MIN_TRANSCRIPT_WORDS } from '../core/config.ts';
import { insertCall, getCallView, decideProposal, markProcessing, type RejectReason } from './db.ts';
import { SAMPLES } from './samples.ts';

const REJECT_REASONS: readonly RejectReason[] = ['wrong_value', 'wrong_person', 'not_agreed', 'other'];

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try { return (await req.json()) as Record<string, unknown>; } catch { return {}; }
}

function validDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const m = (re: RegExp) => re.exec(path);

  if (req.method === 'GET' && path === '/api/health') return json({ ok: true });
  if (req.method === 'GET' && path === '/api/samples') return json(SAMPLES);

  if (req.method === 'POST' && path === '/api/calls') {
    const b = await body(req);
    const transcript = typeof b.transcript === 'string' ? b.transcript : '';
    if (transcript.trim().split(/\s+/).filter(Boolean).length < MIN_TRANSCRIPT_WORDS) {
      return json({ error: `Paste a transcript of at least ${MIN_TRANSCRIPT_WORDS} words.` }, 400);
    }
    if (!validDate(b.callDate)) return json({ error: 'callDate must be YYYY-MM-DD.' }, 400);
    const redacted = redactTranscript(transcript).text;
    try {
      assertRedacted(redacted);
    } catch (e) {
      if (e instanceof UnredactedTranscriptError) return json({ error: 'Redaction check failed; nothing was processed.' }, 422);
      throw e;
    }
    const id = crypto.randomUUID();
    await insertCall(env.DB, { id, callDate: b.callDate, redactedTranscript: redacted });
    await env.PROCESS_CALL.create({ id, params: { callId: id } });
    return json({ id }, 202);
  }

  let r = m(/^\/api\/calls\/([\w-]+)$/);
  if (req.method === 'GET' && r) {
    const v = await getCallView(env.DB, r[1]);
    return v ? json(v) : json({ error: 'not found' }, 404);
  }

  r = m(/^\/api\/calls\/([\w-]+)\/retry$/);
  if (req.method === 'POST' && r) {
    const v = await getCallView(env.DB, r[1]);
    if (!v) return json({ error: 'not found' }, 404);
    if (v.status !== 'failed') return json({ error: 'only a failed call can be retried' }, 409);
    await markProcessing(env.DB, v.id);
    await env.PROCESS_CALL.create({ id: `${v.id}-retry-${Date.now()}`, params: { callId: v.id } });
    return json({ id: v.id }, 202);
  }

  r = m(/^\/api\/proposals\/([\w-]+)\/(approve|reject)$/);
  if (req.method === 'POST' && r) {
    let decision: { status: 'approved' } | { status: 'rejected'; reason: RejectReason | null };
    if (r[2] === 'approve') decision = { status: 'approved' };
    else {
      const reason = (await body(req)).reason ?? null;
      if (reason !== null && !REJECT_REASONS.includes(reason as RejectReason)) return json({ error: 'unknown reason' }, 400);
      decision = { status: 'rejected', reason: reason as RejectReason | null };
    }
    const out = await decideProposal(env.DB, r[1], decision);
    if (out === 'not_found') return json({ error: 'not found' }, 404);
    if (out === 'already_decided') return json({ error: 'already decided' }, 409);
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}
```

The redaction function's return field may not be `.text`. Check `RedactionResult` in `src/core/redact.ts` and use its real field name.

```ts
// src/worker/samples.ts  (filled with real samples in Task 9; empty list keeps the route valid)
export interface Sample { id: string; title: string; callDate: string; transcript: string }
export const SAMPLES: Sample[] = [];
```

```ts
// src/worker/index.ts
import { handle } from './routes.ts';
export { ProcessCall } from './workflow.ts';

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env);
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 10: Run and confirm everything passes**

Run: `npm test`
Expected: PASS (core and worker).

- [ ] **Step 11: Commit**

```bash
git add src test wrangler.jsonc && npm run scan && git commit -m "ProcessCall workflow, pipeline and call API"
```

---

### Task 7: Transcript highlight segments (pure)

**Files:**
- Create: `src/web/segments.ts`, `test/core/segments.test.ts`

**Interfaces:**
- Produces: `interface Segment { text: string; proposalIds: string[] }`, `segments(transcript: string, spans: { id: string; start: number | null; end: number | null }[]): Segment[]`. Concatenating `text` returns the transcript exactly. Overlapping spans produce segments carrying every covering id.

`segments.ts` must import nothing, so `node --test` can run it.

- [ ] **Step 1: Write the failing tests**

```ts
// test/core/segments.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segments } from '../../src/web/segments.ts';

const T = 'abc def ghi jkl';

test('no spans: one plain segment', () => {
  assert.deepEqual(segments(T, []), [{ text: T, proposalIds: [] }]);
});

test('one span splits into three', () => {
  assert.deepEqual(segments(T, [{ id: 'a', start: 4, end: 7 }]), [
    { text: 'abc ', proposalIds: [] },
    { text: 'def', proposalIds: ['a'] },
    { text: ' ghi jkl', proposalIds: [] },
  ]);
});

test('overlapping spans carry both ids on the overlap', () => {
  const s = segments(T, [{ id: 'a', start: 0, end: 7 }, { id: 'b', start: 4, end: 11 }]);
  assert.equal(s.map((x) => x.text).join(''), T);
  assert.deepEqual(s.find((x) => x.text === 'def')!.proposalIds.sort(), ['a', 'b']);
});

test('unlocated spans (null) are ignored', () => {
  assert.deepEqual(segments(T, [{ id: 'a', start: null, end: null }]), [{ text: T, proposalIds: [] }]);
});

test('out-of-range offsets are clamped, never thrown', () => {
  const s = segments(T, [{ id: 'a', start: 12, end: 999 }]);
  assert.equal(s.map((x) => x.text).join(''), T);
  assert.deepEqual(s.at(-1), { text: 'jkl', proposalIds: ['a'] });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `node --experimental-strip-types --test test/core/segments.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/web/segments.ts
export interface Segment { text: string; proposalIds: string[] }

export function segments(
  transcript: string,
  spans: { id: string; start: number | null; end: number | null }[],
): Segment[] {
  const n = transcript.length;
  const valid = spans
    .filter((s) => s.start !== null && s.end !== null)
    .map((s) => ({ id: s.id, start: Math.max(0, Math.min(n, s.start!)), end: Math.max(0, Math.min(n, s.end!)) }))
    .filter((s) => s.end > s.start);
  const cuts = new Set<number>([0, n]);
  for (const s of valid) { cuts.add(s.start); cuts.add(s.end); }
  const points = [...cuts].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    if (b <= a) continue;
    const ids = valid.filter((s) => s.start <= a && s.end >= b).map((s) => s.id);
    const prev = out.at(-1);
    if (prev && prev.proposalIds.join() === ids.join()) prev.text += transcript.slice(a, b);
    else out.push({ text: transcript.slice(a, b), proposalIds: ids });
  }
  return out.length ? out : [{ text: transcript, proposalIds: [] }];
}
```

- [ ] **Step 4: Run and confirm everything passes**

Run: `npm run test:core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/segments.ts test/core/segments.test.ts && npm run scan && git commit -m "Transcript highlight segments"
```

---

### Task 8: The review screen

**Files:**
- Create: `src/web/api.ts`, `src/web/styles.css`, `src/web/components/SubmitForm.tsx`, `src/web/components/CallView.tsx`, `src/web/components/ProposalCard.tsx`, `src/web/components/TranscriptPane.tsx`, `src/web/components/DroppedTray.tsx`
- Modify: `src/web/App.tsx`, `src/web/main.tsx` (import `styles.css`)

**Interfaces:**
- Consumes: the API from Task 6; `segments` from Task 7. The `CallView` JSON shape is re-declared in `api.ts` (the web bundle doesn't import worker code).

This task's tests are behavioural and run in a browser (Step 4). The logic that can break silently, highlight segmentation, is already pinned by Task 7.

- [ ] **Step 1: Write `src/web/api.ts`**

```ts
export type Kind = 'follow_up' | 'task' | 'figure';
export interface Proposal {
  id: string; kind: Kind; field: string; label: string; value: string; quote: string;
  start: number | null; end: number | null; status: 'proposed' | 'approved' | 'rejected';
  rejectReason: string | null; decidedAt: string | null;
}
export interface Dropped { field: string; value: string; reason: string }
export interface CallView {
  id: string; status: 'processing' | 'ready' | 'failed'; error: string | null; callDate: string;
  transcript: string; needsReview: boolean; context: { crmNote: string | null; urgency: string | null };
  proposals: Proposal[]; dropped: Dropped[];
}
export interface Sample { id: string; title: string; callDate: string; transcript: string }
export type RejectReason = 'wrong_value' | 'wrong_person' | 'not_agreed' | 'other';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  samples: () => req<Sample[]>('/api/samples'),
  submit: (transcript: string, callDate: string) =>
    req<{ id: string }>('/api/calls', { method: 'POST', body: JSON.stringify({ transcript, callDate }) }),
  call: (id: string) => req<CallView>(`/api/calls/${id}`),
  retry: (id: string) => req<{ id: string }>(`/api/calls/${id}/retry`, { method: 'POST' }),
  approve: (pid: string) => req<{ ok: true }>(`/api/proposals/${pid}/approve`, { method: 'POST' }),
  reject: (pid: string, reason: RejectReason | null) =>
    req<{ ok: true }>(`/api/proposals/${pid}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
};
```

- [ ] **Step 2: Write the components**

```tsx
// src/web/App.tsx
import { useEffect, useState } from 'react';
import { SubmitForm } from './components/SubmitForm.tsx';
import { CallViewScreen } from './components/CallView.tsx';

export function App() {
  const [callId, setCallId] = useState<string | null>(() => new URLSearchParams(location.search).get('call'));
  useEffect(() => {
    const u = new URL(location.href);
    if (callId) u.searchParams.set('call', callId); else u.searchParams.delete('call');
    history.replaceState(null, '', u);
  }, [callId]);
  return (
    <main className="app">
      <header className="top">
        <h1>Verbatim</h1>
        <span className="org">Tallbrook Home Loans · synthetic demo data</span>
        {callId && <button className="link" onClick={() => setCallId(null)}>New call</button>}
      </header>
      {callId ? <CallViewScreen id={callId} /> : <SubmitForm onSubmitted={setCallId} />}
    </main>
  );
}
```

```tsx
// src/web/components/SubmitForm.tsx
import { useEffect, useState } from 'react';
import { api, type Sample } from '../api.ts';

export function SubmitForm({ onSubmitted }: { onSubmitted: (id: string) => void }) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [transcript, setTranscript] = useState('');
  const [callDate, setCallDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.samples().then(setSamples).catch(() => setSamples([])); }, []);

  async function submit() {
    setBusy(true); setError(null);
    try { onSubmitted((await api.submit(transcript, callDate)).id); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <section className="submit">
      {samples.length > 0 && (
        <label>Load a sample call{' '}
          <select defaultValue="" onChange={(e) => {
            const s = samples.find((x) => x.id === e.target.value);
            if (s) { setTranscript(s.transcript); setCallDate(s.callDate); }
          }}>
            <option value="" disabled>Choose…</option>
            {samples.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </label>
      )}
      <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={16}
        placeholder="Paste a call transcript. One line per speaker turn, like  Renata: ..." />
      <label>Call date <input type="date" value={callDate} onChange={(e) => setCallDate(e.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={busy || !transcript.trim()} onClick={submit}>
        {busy ? 'Submitting…' : 'Process call'}
      </button>
    </section>
  );
}
```

```tsx
// src/web/components/CallView.tsx
import { useCallback, useEffect, useState } from 'react';
import { api, type CallView, type Kind } from '../api.ts';
import { ProposalCard } from './ProposalCard.tsx';
import { TranscriptPane } from './TranscriptPane.tsx';
import { DroppedTray } from './DroppedTray.tsx';

const GROUPS: { kind: Kind; title: string }[] = [
  { kind: 'follow_up', title: 'Follow-ups' },
  { kind: 'task', title: 'Tasks' },
  { kind: 'figure', title: 'Figures' },
];

export function CallViewScreen({ id }: { id: string }) {
  const [view, setView] = useState<CallView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);

  const load = useCallback(() => api.call(id).then(setView).catch((e) => setError((e as Error).message)), [id]);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      setView((v) => { if (!v || v.status === 'processing') load(); return v; });
    }, 2000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!view || view.status === 'processing') return <p className="status">Processing the call… this usually takes under a minute.</p>;
  if (view.status === 'failed') {
    return (
      <div className="status">
        <p className="error">Processing failed: {view.error}</p>
        <button onClick={() => api.retry(id).then(load)}>Retry</button>
      </div>
    );
  }

  return (
    <>
      <section className="context">
        {view.needsReview && <span className="badge review">Needs review</span>}
        {view.context.urgency && <span className={`badge urgency-${view.context.urgency}`}>Urgency: {view.context.urgency}</span>}
        {view.context.crmNote && <p className="note">{view.context.crmNote}</p>}
      </section>
      <div className="panes">
        <section className="cards">
          {GROUPS.map((g) => {
            const items = view.proposals.filter((p) => p.kind === g.kind);
            return (
              <div key={g.kind} className="group">
                <h2>{g.title} <span className="count">{items.length}</span></h2>
                {items.length === 0 && <p className="empty">None on this call.</p>}
                {items.map((p) => (
                  <ProposalCard key={p.id} p={p} focused={focus === p.id} onFocus={() => setFocus(p.id)} onDecided={load} />
                ))}
              </div>
            );
          })}
        </section>
        <TranscriptPane transcript={view.transcript} proposals={view.proposals} focus={focus} onPick={setFocus} />
      </div>
      <DroppedTray dropped={view.dropped} />
    </>
  );
}
```

```tsx
// src/web/components/ProposalCard.tsx
import { useState } from 'react';
import { api, type Proposal, type RejectReason } from '../api.ts';

const REASONS: { id: RejectReason; label: string }[] = [
  { id: 'wrong_value', label: 'Wrong value' },
  { id: 'wrong_person', label: 'Wrong person said it' },
  { id: 'not_agreed', label: 'Not actually agreed' },
  { id: 'other', label: 'Other' },
];

export function ProposalCard({ p, focused, onFocus, onDecided }: {
  p: Proposal; focused: boolean; onFocus: () => void; onDecided: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); onDecided(); } catch (e) { setError((e as Error).message); onDecided(); }
    finally { setBusy(false); setRejecting(false); }
  }

  return (
    <article className={`card ${p.status} ${focused ? 'focused' : ''}`} onClick={onFocus}>
      <div className="label">{p.label}</div>
      <div className="value">{p.value}</div>
      <blockquote>“{p.quote}”{p.start === null && <em className="muted"> (not highlighted)</em>}</blockquote>
      {p.status === 'proposed' ? (
        <div className="actions" onClick={(e) => e.stopPropagation()}>
          <button className="approve" disabled={busy} onClick={() => act(() => api.approve(p.id))}>Approve</button>
          <button className="reject" disabled={busy} onClick={() => setRejecting((r) => !r)}>Reject</button>
          {rejecting && (
            <div className="reasons">
              {REASONS.map((r) => <button key={r.id} disabled={busy} onClick={() => act(() => api.reject(p.id, r.id))}>{r.label}</button>)}
              <button disabled={busy} onClick={() => act(() => api.reject(p.id, null))}>Just reject</button>
            </div>
          )}
        </div>
      ) : (
        <div className="decided">{p.status === 'approved' ? 'Approved' : `Rejected${p.rejectReason ? ` · ${p.rejectReason.replace('_', ' ')}` : ''}`}</div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </article>
  );
}
```

```tsx
// src/web/components/TranscriptPane.tsx
import { useEffect, useMemo, useRef } from 'react';
import type { Proposal } from '../api.ts';
import { segments } from '../segments.ts';

export function TranscriptPane({ transcript, proposals, focus, onPick }: {
  transcript: string; proposals: Proposal[]; focus: string | null; onPick: (id: string) => void;
}) {
  const segs = useMemo(() => segments(transcript, proposals), [transcript, proposals]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus) return;
    const el = ref.current?.querySelector(`[data-ids~="${focus}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('pulse'); void (el as HTMLElement).offsetWidth; el.classList.add('pulse');
    }
  }, [focus]);
  return (
    <section className="transcript" ref={ref}>
      <h2>Transcript</h2>
      <pre>
        {segs.map((s, i) => s.proposalIds.length === 0
          ? <span key={i}>{s.text}</span>
          : <mark key={i} data-ids={s.proposalIds.join(' ')} className={s.proposalIds.includes(focus ?? '') ? 'active' : ''}
              onClick={() => onPick(s.proposalIds[0])}>{s.text}</mark>)}
      </pre>
    </section>
  );
}
```

```tsx
// src/web/components/DroppedTray.tsx
import { useState } from 'react';
import type { Dropped } from '../api.ts';

const REASON_TEXT: Record<string, string> = {
  not_grounded_in_transcript: 'that number was never said',
  evidence_missing: 'no quote given',
  evidence_not_in_transcript: 'the quote is not in the call',
  evidence_too_short: 'quote too short to check',
  implausible_for_field: 'not a plausible value',
  not_a_valid_date: 'not a real date',
  date_before_call: 'date is before the call',
  date_in_future: 'date is in the future',
  date_implausibly_far: 'date is implausibly far out',
};

export function DroppedTray({ dropped }: { dropped: Dropped[] }) {
  const [open, setOpen] = useState(false);
  if (dropped.length === 0) return null;
  return (
    <section className="dropped">
      <button className="link" onClick={() => setOpen((o) => !o)}>
        Dropped: couldn't quote it ({dropped.length}) {open ? '▾' : '▸'}
      </button>
      {open && (
        <ul>
          {dropped.map((d, i) => (
            <li key={i}><code>{d.field}</code> = <strong>{d.value}</strong> · {REASON_TEXT[d.reason] ?? d.reason}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Write `src/web/styles.css` and import it in `main.tsx`**

Add `import './styles.css';` at the top of `main.tsx`. Then:

```css
:root {
  --bg: #fbfaf7; --fg: #1c1b19; --muted: #6b675f; --line: #e4e0d6; --card: #ffffff;
  --accent: #1f5f4a; --mark: #fff1b8; --mark-active: #ffd75e; --bad: #a3321f; --ok: #1f5f4a;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: var(--fg); background: var(--bg);
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #161513; --fg: #ece9e2; --muted: #a29d92; --line: #34312c; --card: #1f1d1a;
          --accent: #6fc3a2; --mark: #4a4120; --mark-active: #7a6a1f; --bad: #f08a75; --ok: #6fc3a2; }
}
body { margin: 0; background: var(--bg); }
.app { max-width: 1200px; margin: 0 auto; padding: 16px; }
.top { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; border-bottom: 1px solid var(--line); margin-bottom: 16px; }
.top h1 { margin: 8px 0; font-size: 22px; }
.org { color: var(--muted); font-size: 13px; }
button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
button.primary, button.approve { background: var(--accent); color: var(--bg); border-color: var(--accent); }
button.link { border: none; background: none; color: var(--accent); padding: 0; text-decoration: underline; }
.submit { display: grid; gap: 12px; }
.submit textarea { width: 100%; box-sizing: border-box; font: 14px/1.5 ui-monospace, monospace; padding: 10px; background: var(--card); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; }
.error { color: var(--bad); }
.status { padding: 32px 0; color: var(--muted); }
.context { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
.context .note { flex-basis: 100%; margin: 4px 0 0; color: var(--muted); }
.badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); }
.badge.review, .badge.urgency-rush, .badge.urgency-critical { border-color: var(--bad); color: var(--bad); }
.panes { display: grid; grid-template-columns: minmax(280px, 2fr) 3fr; gap: 16px; }
@media (max-width: 760px) { .panes { grid-template-columns: 1fr; } }
.group h2, .transcript h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.count { font-weight: normal; }
.empty { color: var(--muted); font-size: 13px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; cursor: pointer; }
.card.focused { border-color: var(--accent); }
.card.approved { border-left: 4px solid var(--ok); }
.card.rejected { opacity: .6; border-left: 4px solid var(--bad); }
.card .label { font-size: 12px; color: var(--muted); }
.card .value { font-size: 18px; font-weight: 600; margin: 2px 0 6px; }
.card blockquote { margin: 0 0 8px; font-size: 13px; color: var(--muted); }
.actions, .reasons { display: flex; gap: 6px; flex-wrap: wrap; }
.reasons { flex-basis: 100%; }
.decided { font-size: 13px; color: var(--muted); }
.muted { color: var(--muted); }
.transcript pre { white-space: pre-wrap; word-wrap: break-word; font: 14px/1.6 ui-monospace, monospace; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; max-height: 70vh; overflow: auto; }
mark { background: var(--mark); color: inherit; cursor: pointer; border-radius: 2px; }
mark.active { background: var(--mark-active); }
mark.pulse { animation: pulse 1s ease-out 1; }
@keyframes pulse { 0% { box-shadow: 0 0 0 4px var(--mark-active); } 100% { box-shadow: 0 0 0 0 transparent; } }
.dropped { margin-top: 16px; border-top: 1px solid var(--line); padding-top: 12px; }
.dropped ul { padding-left: 18px; }
```

- [ ] **Step 4: Run it in the browser and check the behaviour**

```bash
npm run db:migrate:local && npm run dev
```

The local run needs a `.dev.vars` file containing `ANTHROPIC_API_KEY=...`, created by Dan (never by the agent). Until Task 10, test with the extract step failing gracefully: with no key, submit a pasted 25-word transcript and confirm the call reaches **Processing failed** with a Retry button. Then, with a key, check:
1. Cards appear in three groups.
2. Clicking a card scrolls to and pulses its words.
3. Clicking a highlight focuses its card.
4. Approve persists after a page reload.
5. Reject shows the reason chips; picking one persists after a reload.
6. A second click on a decided card's buttons isn't possible (the buttons are gone).
7. The Dropped tray toggles.
8. At 375 px wide, the panes stack and nothing scrolls sideways.

Use the `run` skill or the built-in browser to drive this. Take one screenshot of the ready state for the task review.

- [ ] **Step 5: Run every test**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web && npm run scan && git commit -m "Review screen: cards, highlighted transcript, dropped tray"
```

---

### Task 9: Tallbrook demo calls

**Files:**
- Create: `samples/tallbrook-01-preapproval.json`, `samples/tallbrook-02-results-es.json`, `samples/tallbrook-03-bait.json`, `test/core/samples.test.ts`
- Modify: `src/worker/samples.ts`

**Interfaces:**
- Produces: `SAMPLES: Sample[]` (3 entries) served by `GET /api/samples`. File shape: `{ "id", "title", "callDate", "transcript" }`.

These are written fresh for Tallbrook. Nothing is copied or paraphrased from the Rate build or the private regression set. People: Renata Cole (LO), Marcus Webb (assistant), Priya Shah (processor), Grant Hollis (realtor). Clients are invented per call (e.g. "Dana Whitfield", "Luis and Carmen Ortega", "Jordan Pike").

- [ ] **Step 1: Write the failing sample test**

```ts
// test/core/samples.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { redactTranscript } from '../../src/core/redact.ts';

const DIR = new URL('../../samples/', import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));

test('three samples exist', () => assert.equal(files.length, 3));

for (const f of files) {
  const s = JSON.parse(readFileSync(new URL(f, DIR), 'utf8'));
  test(`${f}: shape`, () => {
    assert.ok(s.id && s.title && /^\d{4}-\d{2}-\d{2}$/.test(s.callDate));
    assert.ok(s.transcript.split(/\s+/).length >= 150, 'a demo call should be at least 150 words');
    assert.match(s.transcript, /^Renata: /m);
  });
  test(`${f}: nothing for redaction to remove (demo text is clean)`, () => {
    const r = redactTranscript(s.transcript);
    assert.equal(r.text, s.transcript);
  });
}
```

(Use the real field name of `RedactionResult` here, as in Task 6.)

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:core`
Expected: FAIL ("three samples exist").

- [ ] **Step 3: Write the three calls**

Each call is 250–450 words, one line per turn, `Name: text`, and spoken numerals the way people talk ("thirty two hundred", "six and seven eighths"). Required content per file:

- **01 preapproval (English).** Renata with client Dana Whitfield, callDate `2026-09-28` (a Monday). Spoken: approved up to four hundred twenty five thousand; payment around thirty one fifty a month; about eighteen thousand to close; rate between six and a quarter and six and five eighths. Renata promises to "call you Thursday after the appraisal comes back". Marcus "will send the fee sheet today". The client mentions current rent ("we pay twenty four hundred right now"), so a person can see the difference between rent and budget.
- **02 results, code-switched (EN/ES).** Marcus with Luis and Carmen Ortega, callDate `2026-09-29`. The figures are said in Spanish ("el pago sería unos dos mil ochocientos al mes", "aprobados hasta trescientos sesenta mil"), with one English figure inside a Spanish sentence. Follow-up: "le llamo el viernes". Task: Priya needs two pay stubs; owner Priya, kind third_party.
- **03 bait.** Renata with Jordan Pike, callDate `2026-09-30`. The call discusses the down payment *vaguely* ("we'll figure out what you need to bring, it depends on the program") and never says an out-of-pocket number. Jordan asks "so roughly what would closing look like?" and Renata answers "I'll run it and get back to you". Approved amount and payment *are* said. A follow-up is agreed ("I'll text you tomorrow with the numbers"). This call tempts a model to fill `max_out_of_pocket` with a number that was never said; if it does, the Dropped tray shows it. If the real run in Task 10 doesn't produce a drop on any sample, record that honestly; don't edit the transcript to force one.

Then:

```ts
// src/worker/samples.ts
import s1 from '../../samples/tallbrook-01-preapproval.json';
import s2 from '../../samples/tallbrook-02-results-es.json';
import s3 from '../../samples/tallbrook-03-bait.json';

export interface Sample { id: string; title: string; callDate: string; transcript: string }
export const SAMPLES: Sample[] = [s1, s2, s3];
```

Add `"resolveJsonModule": true` to `tsconfig.json`.

- [ ] **Step 4: Run and confirm everything passes**

Run: `npm test`
Expected: PASS. The name scan must also pass: `git add samples src/worker/samples.ts && npm run scan`.

- [ ] **Step 5: Commit**

```bash
git commit -m "Three Tallbrook demo calls"
```

---

### Task 10: Real run, deploy behind Access, changelog and handoff

**Files:**
- Modify: `wrangler.jsonc` (`database_id`), `README.md` (status line), `src/core/config.ts` (pricing, only if the check differs)
- Create: `docs/CHANGELOG.md`, `docs/HANDOFF.md`

Some steps here are Dan's because they involve secrets, accounts, or spending money. The agent stops and asks for each one marked **[Dan]**.

- [ ] **Step 1: Verify pricing**

Check `claude-opus-5-5` per-million-token prices on Anthropic's official pricing page (use the `claude-api` skill or fetch the page). If they differ from `PRICING` in `src/core/config.ts`, update the values and add the source URL and date as a comment. Run `npm run test:core` (the pipeline cost assertion must be updated to match).

- [ ] **Step 2: [Dan] Local secret and first real run**

Dan creates `.dev.vars` with `ANTHROPIC_API_KEY=...`. Then:

```bash
npm run db:migrate:local && npm run dev
```

Run all three samples through the UI. Then read the real numbers:

```bash
npx wrangler d1 execute verbatim --local --command "SELECT model, input_tokens, output_tokens, cost_usd, duration_ms, failures FROM runs ORDER BY created_at"
```

Record each row exactly as returned in `docs/HANDOFF.md`. **These are the only numbers any post may use.**

- [ ] **Step 3: [Dan] Create the remote D1 and set the secret**

```bash
npx wrangler d1 create verbatim
```

Put the returned `database_id` in `wrangler.jsonc`. Then:

```bash
npm run db:migrate:remote
```

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

- [ ] **Step 4: [Dan] Deploy and protect it**

```bash
npm run deploy
```

Then, in the Cloudflare dashboard, go to Workers & Pages → `verbatim` → Access tab → **Protect this Worker behind Access** → All traffic → a policy allowing Dan's email only. (Zero Trust must be enabled on the account.) Verify in a private browser window that the workers.dev URL shows the Access login, not the app.

- [ ] **Step 5: Run the definition of done on the deployed URL**

Tick each item in `docs/HANDOFF.md` with evidence:
1. `npm test` and `npm run regress` pass (paste the summary lines).
2. A fresh Tallbrook call runs end to end on the deployed URL.
3. Every proposal highlights its words, or the run's `needs_review_reasons` shows `span_unlocated`.
4. At least one fabricated figure is in the Dropped tray. If no sample produced one, say so plainly. That's a finding, not a failure to hide.
5. Approve and reject survive a reload.
6. One real run's cost and duration, from `runs`.
7. A 30–60 s clip (Dan records it).
8. The changelog line and this handoff.

- [ ] **Step 6: Write `docs/CHANGELOG.md` and `docs/HANDOFF.md`**

```markdown
# Changelog

## 2026-10-0X: Slice 1: one call in, approved proposals out
Paste a call. Follow-ups, tasks and figures come out, each highlighted in the transcript where it
was said. Anything the AI couldn't quote is listed as dropped. Nothing counts until a person
approves it. Synthetic data (Tallbrook Home Loans).
```

`docs/HANDOFF.md`: what shipped, the real run numbers from Step 2, the definition-of-done evidence, what's next (slice 2: edit-before-approve, the validate.ts split), open questions (NMLS check on "Tallbrook" if still open).

Update the README status line to: `**Status:** slice 1 shipped: one synthetic call in, approved proposals out.`

- [ ] **Step 7: Commit, show the diff, push, open the PR**

```bash
git add -A && npm run scan && git diff --cached --stat
```

Show Dan the full `git diff --cached`, then:

```bash
git commit -m "Slice 1 done: deploy, real-run numbers, changelog, handoff"
git push -u origin slice-1
```

Then superpowers:finishing-a-development-branch (merge `slice-1` into `main` after superpowers:requesting-code-review).
