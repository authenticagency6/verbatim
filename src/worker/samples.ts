import s1 from '../../samples/tallbrook-01-preapproval.json';
import s2 from '../../samples/tallbrook-02-results-es.json';
import s3 from '../../samples/tallbrook-03-bait.json';

export interface Sample { id: string; title: string; callDate: string; transcript: string }
export const SAMPLES: Sample[] = [s1, s2, s3];
