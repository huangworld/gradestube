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

// ---- delimited tables (CSV / TSV / spreadsheet export) ----
function splitDelimited(text) {
  const firstLines = text.split("\n").slice(0, 20).join("\n");
  const delim = (firstLines.match(/\t/g) || []).length > (firstLines.match(/,/g) || []).length ? "\t" : ",";
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"' && cell === "") q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(c => c.trim()));
}

const num = s => { const m = String(s || "").match(/-?\d+(?:\.\d+)?|-?\.\d+/); return m ? parseFloat(m[0]) : null; };
const findCol = (head, re, not = []) => head.findIndex((h, i) => re.test(h) && !not.includes(i));

// Structured rubric table. Handles: item/sub-part columns (blank item = continues previous),
// item pts vs part max pts, full/partial/zero credit columns, group column, notes after the table.
export function parseDelimited(text) {
  if (!/[,\t]/.test(text)) return null;
  const rows = splitDelimited(text.replace(/\r/g, ""));
  const hi = rows.findIndex(r => {
    const h = r.map(c => c.toLowerCase());
    return h.filter(Boolean).length >= 2 && h.some(c => /point|pts|score|max|marks|weight/.test(c)) &&
      h.some(c => /criteri|item|category|component|section|dimension|name|what is scored|part/.test(c));
  });
  if (hi < 0) return null;
  const head = rows[hi].map(c => c.toLowerCase());
  const used = [];
  const take = (re, not = []) => { const i = findCol(head, re, [...used, ...not]); if (i >= 0) used.push(i); return i; };
  const maxC = take(/^max|max\s*(pts|points)|part\s*(pts|points)/);
  const itemPtsC = take(/item\s*(pts|points)|^(pts|points|score|marks|weight)$|points|pts/);
  const ptsC = maxC >= 0 ? maxC : itemPtsC;
  const subC = take(/what is scored|sub.?part|sub.?criteri|aspect|component/);
  const itemC = take(/criteri|^item|item$|category|section|dimension|name|title/);
  const groupC = take(/^part$|^group$|^type$|^scope$/);
  const fullC = take(/full|excellent|exemplary|meets|description|descr|expect|requirement/);
  const partC = take(/partial/);
  const zeroC = take(/zero|none|fail|missing/);
  if (itemC < 0 && subC < 0) return null;

  const items = []; let lastItem = "", lastGroup = "", end = rows.length;
  for (let r = hi + 1; r < rows.length; r++) {
    const row = rows[r], g = i => (i >= 0 ? row[i] || "" : "");
    if (!row.some(Boolean)) { if (items.length) { end = r; break; } continue; }
    const itemName = g(itemC), sub = g(subC), pts = num(g(ptsC)) ?? num(g(itemPtsC));
    const labelish = [itemName, sub, g(groupC)].join(" ");
    if (/^\s*(total|subtotal|sum|group items|individual items)\b/i.test(sub || itemName) || (!itemName && !g(fullC) && /total|items/i.test(labelish))) continue;
    if (itemName) lastItem = itemName;
    if (g(groupC)) lastGroup = g(groupC);
    const base = itemName || lastItem;
    if (!base && !sub) continue;
    const whole = !sub || /^whole( item)?$/i.test(sub);
    const title = whole ? base : base ? `${base} · ${sub}` : sub;
    const desc = [
      fullC >= 0 && g(fullC) ? `Full: ${g(fullC)}` : "",
      partC >= 0 && g(partC) ? `Partial: ${g(partC)}` : "",
      zeroC >= 0 && g(zeroC) ? `Zero: ${g(zeroC)}` : "",
      groupC >= 0 && lastGroup ? `(${lastGroup})` : "",
    ].filter(Boolean).join("\n");
    const extra = row.map((c, i) => (!used.includes(i) && c ? c : "")).filter(Boolean).join(" — ");
    items.push({ title, description: desc || extra, maxPoints: pts });
  }
  if (!items.length) return null;
  // Notes = non-empty rows after the table, plus intro lines before the header.
  const join = rs => rs.map(r => r.filter(Boolean).join(" ")).filter(Boolean);
  let after = join(rows.slice(end)).filter(l => !/^\s*(total|group items|individual items)\b/i.test(l));
  const nextSheet = after.findIndex(l => /^## Sheet:/.test(l));
  if (nextSheet >= 0) after = after.slice(0, nextSheet);
  const before = join(rows.slice(0, hi)).filter(l => !/^## Sheet:/.test(l));
  return { items, notes: after.join("\n"), title: before[0] || "", intro: before.slice(1).join("\n") };
}

export function parseRubricStructured(text) {
  const d = parseDelimited(text || "");
  if (d) return { ...d, items: d.items.map((it, i) => ({ id: `c${i + 1}`, ...it })) };
  return null;
}

export function parseRubric(text) {
  const lines = (text || "").replace(/\r/g, "").split("\n");
  const d = parseDelimited(text || "");
  const items = d?.items || parseTable(lines) || parseLines(lines);
  return items.map((it, i) => ({ id: `c${i + 1}`, ...it }));
}

export const rubricMax = items => items.reduce((s, it) => s + (Number(it.maxPoints) || 0), 0);

// ---- LLM parsing: any format (CSV, tables, prose) → items ----
import { callJson } from "./llm.js";

const PARSE_SYSTEM = `You convert grading rubrics into a structured list of gradable items. The input may be Markdown, plain text, CSV/spreadsheet rows, or loosely written prose.

Rules:
- One item per separately scored thing. If a criterion is split into sub-parts with their own points, emit one item per sub-part and name it "Parent · Sub-part".
- title: short (under 60 chars). description: what full credit requires, then partial/zero credit guidance if given, each on its own line prefixed "Full:", "Partial:", "Zero:". Keep the rubric's own wording; do not invent criteria.
- max_points: the points for that item (fractions allowed). If the rubric has no points, use null.
- Skip totals, headers, and summary rows. Put grading rules, policies, and other notes that apply across items in notes (verbatim-ish, concise).
- Preserve the rubric's order.`;

const PARSE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["title", "items", "notes"],
  properties: {
    title: { type: "string" },
    items: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "description", "max_points"],
      properties: { title: { type: "string" }, description: { type: "string" }, max_points: { type: ["number", "null"] } } } },
    notes: { type: "string" },
  },
};

export async function parseRubricLLM(text, { provider, model, keys }) {
  const out = await callJson({ provider, model, keys, system: PARSE_SYSTEM, user: `<rubric>\n${text}\n</rubric>\n\nExtract the gradable items.`, schema: PARSE_SCHEMA });
  const items = (out.items || []).filter(it => it.title?.trim()).map((it, i) => ({
    id: `c${i + 1}`, title: it.title.trim(), description: (it.description || "").trim(),
    maxPoints: it.max_points == null || isNaN(Number(it.max_points)) ? null : Number(it.max_points),
  }));
  if (!items.length) throw new Error("The model found no rubric items in that text.");
  return { items, notes: (out.notes || "").trim(), title: (out.title || "").trim() };
}
