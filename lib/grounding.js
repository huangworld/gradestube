// Verify LLM-cited quotes against the transcript and pin them to real timestamps.
import { uid } from "./store.js";

const norm = s => (s || "").toLowerCase().replace(/[’']/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

// Flatten transcript to tokens with segment index.
export function tokenize(transcript) {
  const toks = [];
  transcript.forEach((seg, i) => norm(seg.text).forEach(w => toks.push({ w, seg: i })));
  return toks;
}

function exactFind(toks, q, from, to) {
  outer: for (let i = from; i + q.length <= to; i++) {
    for (let j = 0; j < q.length; j++) if (toks[i + j].w !== q[j]) continue outer;
    return i;
  }
  return -1;
}

function fuzzyFind(toks, q) {
  if (q.length < 3) return null;
  const need = new Map();
  q.forEach(w => need.set(w, (need.get(w) || 0) + 1));
  let best = { score: 0, i: -1 };
  for (let i = 0; i + q.length <= toks.length; i++) {
    const have = new Map(need);
    let hit = 0;
    for (let j = 0; j < q.length; j++) {
      const c = have.get(toks[i + j].w);
      if (c) { hit++; have.set(toks[i + j].w, c - 1); }
    }
    const score = hit / q.length;
    if (score > best.score) best = { score, i };
  }
  return best.score >= 0.75 ? best : null;
}

// evidence: {quote, seg_start, seg_end}; returns snippet
export function ground(ev, transcript, toks = tokenize(transcript)) {
  const q = norm(ev.quote);
  const n = transcript.length;
  const segToTok = s => toks.findIndex(t => t.seg >= s);
  const mk = (segStart, segEnd, verified, fuzzy = false) => {
    segStart = Math.max(0, Math.min(n - 1, segStart | 0));
    segEnd = Math.max(segStart, Math.min(n - 1, segEnd | 0));
    return {
      id: uid(), quote: ev.quote, segStart, segEnd,
      t: transcript[segStart]?.t ?? 0, ts: transcript[segStart]?.ts ?? "0:00",
      source: "ai", verified, fuzzy,
    };
  };
  if (!q.length || !n) return mk(ev.seg_start || 0, ev.seg_end || 0, false);

  // 1) exact within cited window ±2 segs, 2) exact anywhere
  const lo = Math.max(0, segToTok(Math.max(0, (ev.seg_start | 0) - 2)));
  let hiTok = segToTok(Math.min(n, (ev.seg_end | 0) + 3));
  if (hiTok < 0) hiTok = toks.length;
  let i = exactFind(toks, q, lo, hiTok);
  if (i < 0) i = exactFind(toks, q, 0, toks.length);
  if (i >= 0) return mk(toks[i].seg, toks[i + q.length - 1].seg, true);

  // 3) fuzzy (word overlap ≥75%) anywhere
  const f = fuzzyFind(toks, q);
  if (f) return mk(toks[f.i].seg, toks[f.i + q.length - 1].seg, true, true);

  return mk(ev.seg_start ?? 0, ev.seg_end ?? ev.seg_start ?? 0, false);
}

// Snippet from a manual selection over segments [a..b]
export function manualSnippet(transcript, a, b, quote) {
  const segStart = Math.min(a, b), segEnd = Math.max(a, b);
  return {
    id: uid(), segStart, segEnd,
    quote: quote || transcript.slice(segStart, segEnd + 1).map(s => s.text).join(" "),
    t: transcript[segStart].t, ts: transcript[segStart].ts,
    source: "manual", verified: true, fuzzy: false,
  };
}
