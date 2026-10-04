import { describe, it, expect } from 'vitest';
import { exports } from 'cloudflare:workers';

describe('samples', () => {
  it('GET /api/samples returns the three demo calls', async () => {
    const res = await exports.default.fetch('https://verbatim.test/api/samples');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const list = Array.isArray(body) ? body : body.samples;
    expect(list).toHaveLength(3);
    for (const s of list) {
      expect(s.id).toBeTruthy();
      expect(s.title).toBeTruthy();
      expect(s.callDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(s.transcript.length).toBeGreaterThan(100);
    }
  });
});
