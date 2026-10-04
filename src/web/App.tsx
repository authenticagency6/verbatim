import { useEffect, useState } from 'react';
import { SubmitForm } from './components/SubmitForm.tsx';
import { CallViewScreen } from './components/CallView.tsx';

export function App() {
  const [callId, setCallId] = useState<string | null>(() => new URLSearchParams(location.search).get('call'));
  useEffect(() => {
    const u = new URL(location.href);
    if (callId) u.searchParams.set('call', callId); else u.searchParams.delete('call');
    history.replaceState(null, '', u);
  }, [callId]);
  return (
    <main className="app">
      <header className="top">
        <h1>Verbatim</h1>
        <span className="org">Tallbrook Home Loans · synthetic demo data</span>
        {callId && <button className="link" onClick={() => setCallId(null)}>New call</button>}
      </header>
      {callId ? <CallViewScreen id={callId} /> : <SubmitForm onSubmitted={setCallId} />}
    </main>
  );
}
