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
