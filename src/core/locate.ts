// Maps a validated (canonical-form) quote back to a character range in the raw redacted
// transcript, so the UI can highlight the exact words a person said.
//
// Each raw whitespace token is canonicalised on its own with the SAME function the validator
// uses, so a token-level match is a validator-level match. Every canonicalisation rule works
// inside a single token (case, accents, quotes, apostrophes, %, punctuation, thousands
// separators), except hyphen splitting, which yields several canonical words that all map back
// to the one raw token.
import { canonicalizeSpan } from './validate.ts';

export interface Located {
  start: number;
  end: number;
}

interface Tok {
  canon: string;
  start: number;
  end: number;
}

/** Same label shape the validator strips: up to ~40 chars then ": " at line start. */
const LABEL = /^\s*([\p{L}\p{N}+()' .-]{1,40}?):\s+/u;

function tokenize(transcript: string): Tok[] {
  const toks: Tok[] = [];
  let lineStart = 0;
  for (const line of transcript.split('\n')) {
    const m = LABEL.exec(line);
    const bodyOffset = m ? m[0].length : 0;
    const body = line.slice(bodyOffset);
    const re = /\S+/g;
    let w: RegExpExecArray | null;
    while ((w = re.exec(body))) {
      const c = canonicalizeSpan(w[0]);
      if (c === '') continue;
      const start = lineStart + bodyOffset + w.index;
      const end = start + w[0].length;
      for (const part of c.split(' ')) toks.push({ canon: part, start, end });
    }
    lineStart += line.length + 1;
  }
  return toks;
}

export function locateSpan(transcript: string, quote: string): Located | null {
  const q = canonicalizeSpan(quote || '');
  if (q === '') return null;
  const words = q.split(' ');
  const toks = tokenize(transcript || '');
  outer: for (let i = 0; i + words.length <= toks.length; i++) {
    for (let j = 0; j < words.length; j++) {
      if (toks[i + j].canon !== words[j]) continue outer;
    }
    return { start: toks[i].start, end: toks[i + words.length - 1].end };
  }
  return null;
}
