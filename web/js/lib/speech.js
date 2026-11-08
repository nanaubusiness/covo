// Turn a SpeechRecognition result list into one clean transcript.
// Android Chrome sends results that each already contain everything said so far (and sometimes
// repeats a final result), while desktop browsers send separate pieces. Joining them naively
// repeats words many times, so merge by overlap instead.
const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

export function mergeSpeech(a, b) {
  a = (a || '').trim(); b = (b || '').trim();
  if (!a) return b;
  if (!b) return a;
  const na = norm(a), nb = norm(b);
  if (na === nb) return a.length >= b.length ? a : b; // same words: keep the punctuated one
  if (nb.startsWith(na)) return b;          // b is a's cumulative update
  if (na.startsWith(nb) || na.endsWith(nb)) return a; // b repeats something already there
  // Join on the longest word overlap (end of a == start of b).
  const wa = a.split(/\s+/), wb = b.split(/\s+/);
  for (let k = Math.min(wa.length, wb.length); k > 0; k--) {
    if (norm(wa.slice(-k).join(' ')) === norm(wb.slice(0, k).join(' '))) return [...wa, ...wb.slice(k)].join(' ');
  }
  return `${a} ${b}`;
}

export function transcriptOf(results) {
  let finals = '';
  let interim = '';
  for (let i = 0; i < results.length; i++) {
    const t = results[i][0]?.transcript || '';
    if (results[i].isFinal) finals = mergeSpeech(finals, t);
    else interim = mergeSpeech(interim, t);
  }
  return mergeSpeech(finals, interim);
}

export const isAndroid = () => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
