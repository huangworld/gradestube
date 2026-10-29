// Parse a TXT / Markdown rubric into items: [{id, title, description, maxPoints}]
const PTS_RES = [
  /\(\s*(\d+(?:\.\d+)?)\s*(?:pts?|points?|marks?)?\s*\)/i,          // (10 pts) / (10)
  /\[\s*(\d+(?:\.\d+)?)\s*(?:pts?|points?|marks?)?\s*\]/i,          // [10 pts]
  /(\d+(?:\.\d+)?)\s*(?:pts?|points?|marks?)\b/i,                   // 10 points
  /\/\s*(\d+(?:\.\d+)?)\s*$/,                                       // .../10
];

function findPoints(s) {
  for (const re of PTS_RES) {
    const m = s.match(re);
    if (m) return { pts: parseFloat(m[1]), match: m[0] };
  }
  return null;
}

const stripMd = s => s.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "")
  .replace(/\*\*|__|`/g, "").trim();

function cleanTitle(s, ptsMatch) {
  let t = stripMd(s);
  if (ptsMatch) t = t.replace(ptsMatch, "");
  return t.replace(/[\s:–—-]+$/, "").replace(/^[\s:–—-]+/, "").trim();
}

function splitTitleDesc(t) {
  const m = t.match(/^(.{2,80}?)\s*[:–—]\s+(.+)$/);
  return m ? { title: m[1].trim(), description: m[2].trim() } : { title: t, description: "" };
}

function parseTable(lines) {
  const rows = lines.filter(l => l.trim().startsWith("|"))
    .map(l => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim()));
  const body = rows.filter(r => !r.every(c => /^:?-{2,}:?$/.test(c) || c === ""));
  if (body.length < 2) return null;
  const head = body[0].map(h => h.toLowerCase());
  let pi = head.findIndex(h => /point|pts|score|max|weight|marks/.test(h));
  let ci = head.findIndex(h => /criteri|item|category|component|name|section|dimension/.test(h));
  if (ci < 0) ci = 0;
  const di = head.findIndex((h, i) => i !== ci && i !== pi && /descr|detail|expect|requirement|full credit|excellent/.test(h));
  const items = [];
  for (const r of body.slice(1)) {
    const title = stripMd(r[ci] || "");
    if (!title || /^total\b/i.test(title)) continue;
    let maxPoints = null;
    if (pi >= 0) { const n = parseFloat((r[pi] || "").replace(/[^\d.]/g, "")); if (!isNaN(n)) maxPoints = n; }
    if (maxPoints == null) { const f = findPoints(r.join(" ")); if (f) maxPoints = f.pts; }
    const description = di >= 0 ? r[di] : r.filter((_, i) => i !== ci && i !== pi).join(" — ");
    items.push({ title, description: stripMd(description || ""), maxPoints });
  }
  return items.length ? items : null;
}

function parseLines(lines) {
  const items = [];
  let cur = null;
  const withPts = lines.some(l => findPoints(l) && !/^\s*total\b/i.test(stripMd(l)));
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const plain = stripMd(line);
    if (/^total\b/i.test(plain)) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const isHeading = /^\s*#{1,6}\s/.test(line);
    const isTopBullet = /^\s*([-*+]|\d+[.)])\s/.test(line) && indent < 2;
    const pts = findPoints(line);
    const startsItem = withPts ? !!pts && (isHeading || isTopBullet || indent < 2) : (isHeading || isTopBullet);
    if (startsItem) {
      const { title, description } = splitTitleDesc(cleanTitle(line, pts?.match));
      cur = { title: title || plain, description, maxPoints: pts ? pts.pts : null };
      items.push(cur);
    } else if (cur) {
      cur.description = (cur.description ? cur.description + "\n" : "") + plain;
    }
  }
  // Drop a leading heading that's just the rubric's title (no points, others have points)
  if (withPts && items.length > 1 && items[0].maxPoints == null) items.shift();
  return items;
}

export function parseRubric(text) {
  const lines = (text || "").replace(/\r/g, "").split("\n");
  const items = parseTable(lines) || parseLines(lines);
  return items.map((it, i) => ({ id: `c${i + 1}`, ...it }));
}

export const rubricMax = items => items.reduce((s, it) => s + (Number(it.maxPoints) || 0), 0);
