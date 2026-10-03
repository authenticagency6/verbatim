import { describe, it, expect } from 'vitest';
import { exports } from 'cloudflare:workers';

describe('health', () => {
  it('GET /api/health returns ok', async () => {
    const res = await exports.default.fetch('https://verbatim.test/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
