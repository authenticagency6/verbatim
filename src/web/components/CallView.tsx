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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const load = useCallback(
    () => api.call(id).then((v) => { setView(v); setLoadError(null); }).catch((e) => setLoadError((e as Error).message)),
    [id],
  );
  const focusOn = (pid: string) => { setFocus(pid); setNonce((n) => n + 1); };

  useEffect(() => { load(); }, [load]);

  const status = view?.status ?? null;
  useEffect(() => {
    if (status === 'ready' || status === 'failed') return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load, status]);

  async function retry() {
    setRetrying(true); setRetryError(null);
    try { await api.retry(id); await load(); }
    catch (e) { setRetryError((e as Error).message); }
    finally { setRetrying(false); }
  }

  if (!view && loadError) return <p className="error" role="alert">{loadError}</p>;
  if (!view || view.status === 'processing') return <p className="status">Processing the call… this usually takes under a minute.</p>;
  if (view.status === 'failed') {
    return (
      <div className="status">
        <p className="error">Processing failed: {view.error}</p>
        <button disabled={retrying} onClick={retry}>{retrying ? 'Retrying…' : 'Retry'}</button>
        {retryError && <p className="error" role="alert">{retryError}</p>}
        {loadError && <p className="error" role="alert">{loadError}</p>}
      </div>
    );
  }

  return (
    <>
      {loadError && <p className="error" role="alert">Couldn't refresh: {loadError}</p>}
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
                  <ProposalCard key={p.id} p={p} focused={focus === p.id} onFocus={() => focusOn(p.id)} onDecided={load} />
                ))}
              </div>
            );
          })}
        </section>
        <TranscriptPane transcript={view.transcript} proposals={view.proposals} focus={focus} nonce={nonce} onPick={focusOn} />
      </div>
      <DroppedTray dropped={view.dropped} />
    </>
  );
}
