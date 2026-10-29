// Effective (displayed) grade = active AI run + TA overrides + manual snippets.
export function activeRun(g) {
  return g.runs.find(r => r.id === g.activeRunId) || g.runs[g.runs.length - 1] || null;
}

export function effectiveItems(g, rubricItems) {
  const run = activeRun(g);
  return rubricItems.map(item => {
    const ai = run?.items.find(x => x.id === item.id);
    const override = g.overrides[item.id];
    const aiSnips = (ai?.snippets || []).filter(s => !g.removed[s.id]);
    const snippets = [...aiSnips, ...(g.manualSnippets[item.id] || [])].sort((a, b) => a.t - b.t);
    return {
      item,
      aiScore: ai ? ai.score : null,
      score: override != null ? override : (ai ? ai.score : null),
      overridden: override != null,
      rationale: ai?.rationale || "",
      note: g.notes[item.id] || "",
      snippets,
      unverified: snippets.filter(s => !s.verified).length,
    };
  });
}

export function effectiveOverall(g, rubricItems) {
  const eff = effectiveItems(g, rubricItems);
  const sum = eff.reduce((s, e) => s + (Number(e.score) || 0), 0);
  const aiSum = eff.reduce((s, e) => s + (Number(e.aiScore) || 0), 0);
  return {
    sum: round(sum), aiSum: round(aiSum),
    overall: g.overallOverride != null ? g.overallOverride : round(sum),
    overridden: g.overallOverride != null,
    graded: eff.some(e => e.score != null),
  };
}

export const round = n => Math.round(n * 10000) / 10000;

export function fmtTs(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`;
}
