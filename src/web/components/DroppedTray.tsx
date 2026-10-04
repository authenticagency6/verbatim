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
