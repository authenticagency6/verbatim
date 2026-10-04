import { useEffect, useState } from 'react';
import { api, type Sample } from '../api.ts';

export function SubmitForm({ onSubmitted }: { onSubmitted: (id: string) => void }) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [transcript, setTranscript] = useState('');
  const [callDate, setCallDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.samples().then(setSamples).catch(() => setSamples([])); }, []);

  async function submit() {
    setBusy(true); setError(null);
    try { onSubmitted((await api.submit(transcript, callDate)).id); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <section className="submit">
      {samples.length > 0 && (
        <label>Load a sample call{' '}
          <select defaultValue="" onChange={(e) => {
            const s = samples.find((x) => x.id === e.target.value);
            if (s) { setTranscript(s.transcript); setCallDate(s.callDate); }
          }}>
            <option value="" disabled>Choose…</option>
            {samples.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </label>
      )}
      <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={16}
        placeholder="Paste a call transcript. One line per speaker turn, like  Renata: ..." />
      <label>Call date <input type="date" value={callDate} onChange={(e) => setCallDate(e.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={busy || !transcript.trim()} onClick={submit}>
        {busy ? 'Submitting…' : 'Process call'}
      </button>
    </section>
  );
}
