import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

const root = fileURLToPath(new URL('.', import.meta.url));
// The full prompts live in private/ (gitignored). A fresh public clone falls back to the examples.
// Each file resolves on its own, so both cases point at a file that exists.
const pick = (name: string, example: string) =>
  existsSync(`${root}private/prompts/${name}`) ? `${root}private/prompts/${name}` : `${root}prompts/${example}`;
export const promptAliases = [
  { find: /^@prompt-call(\?.*)?$/, replacement: `${pick('call.md', 'call.example.md')}$1` },
  { find: /^@prompt-criteria(\?.*)?$/, replacement: `${pick('script-criteria.md', 'script-criteria.example.md')}$1` },
];

export default defineConfig({
  plugins: [react(), cloudflare()],
  resolve: { alias: promptAliases },
});
