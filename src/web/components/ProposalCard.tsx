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
