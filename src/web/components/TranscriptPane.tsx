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
