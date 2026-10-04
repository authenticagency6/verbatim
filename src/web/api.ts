export type Kind = 'follow_up' | 'task' | 'figure';
export interface Proposal {
  id: string; kind: Kind; field: string; label: string; value: string; quote: string;
  start: number | null; end: number | null; status: 'proposed' | 'approved' | 'rejected';
  rejectReason: string | null; decidedAt: string | null;
}
export interface Dropped { field: string; value: string; reason: string }
export interface CallView {
  id: string; status: 'processing' | 'ready' | 'failed'; error: string | null; callDate: string;
  transcript: string; needsReview: boolean; context: { crmNote: string | null; urgency: string | null };
  proposals: Proposal[]; dropped: Dropped[];
}
export interface Sample { id: string; title: string; callDate: string; transcript: string }
export type RejectReason = 'wrong_value' | 'wrong_person' | 'not_agreed' | 'other';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  samples: () => req<Sample[]>('/api/samples'),
  submit: (transcript: string, callDate: string) =>
    req<{ id: string }>('/api/calls', { method: 'POST', body: JSON.stringify({ transcript, callDate }) }),
  call: (id: string) => req<CallView>(`/api/calls/${id}`),
  retry: (id: string) => req<{ id: string }>(`/api/calls/${id}/retry`, { method: 'POST' }),
  approve: (pid: string) => req<{ ok: true }>(`/api/proposals/${pid}/approve`, { method: 'POST' }),
  reject: (pid: string, reason: RejectReason | null) =>
    req<{ ok: true }>(`/api/proposals/${pid}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
};
