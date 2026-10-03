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
