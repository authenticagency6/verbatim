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
