import { effectiveItems, effectiveOverall, activeRun } from "./grade.js";
import { videoLink } from "./store.js";
import { rubricMax } from "./rubric.js";

export function transcriptText(g) {
  const head = `${g.title || g.videoId}\n${g.url}\n${g.student ? `Student: ${g.student}\n` : ""}\n`;
  return head + (g.transcript || []).map(s => `[${s.ts}] ${s.text}`).join("\n") + "\n";
}

export function markdownReport(g, hw) {
  const items = hw.rubric?.items || [];
  const eff = effectiveItems(g, items);
  const ov = effectiveOverall(g, items);
  const run = activeRun(g);
  const out = [`# ${g.title || g.videoId}`, `${g.url}`];
  if (g.student) out.push(`Student: ${g.student}`);
  out.push(`Homework: ${hw.name}`, `**Overall: ${ov.overall} / ${rubricMax(items)}**${ov.overridden ? " (overridden)" : ""}`);
  if (run) out.push(`Model: ${run.provider}/${run.model}`);
  out.push("");
  for (const e of eff) {
    out.push(`## ${e.item.title} — ${e.score ?? "–"} / ${e.item.maxPoints ?? "?"}${e.overridden ? ` (AI: ${e.aiScore ?? "–"})` : ""}`);
    if (e.rationale) out.push(e.rationale);
    if (e.note) out.push(`> TA note: ${e.note}`);
    for (const s of e.snippets) out.push(`- [${s.ts}](${videoLink(g.videoId, s.t)}) "${s.quote}"${s.verified ? "" : " ⚠ unverified"}${s.source === "manual" ? " (TA)" : ""}`);
    out.push("");
  }
  if (g.comment || run?.comment) out.push("## Comment", g.comment || run.comment, "");
  return out.join("\n");
}

const csvCell = v => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function gradesCsv(grades, hw) {
  const items = hw.rubric?.items || [];
  const head = ["student", "title", "url", "video_id", "status",
    ...items.map(it => `${it.title} (/${it.maxPoints ?? "?"})`),
    "total", "max", "overall_overridden", "items_overridden", "unverified_quotes", "model", "comment", "updated"];
  const rows = grades.map(g => {
    const eff = effectiveItems(g, items), ov = effectiveOverall(g, items), run = activeRun(g);
    return [g.student, g.title, g.url, g.videoId, g.status,
      ...eff.map(e => e.score ?? ""),
      ov.graded ? ov.overall : "", rubricMax(items), ov.overridden ? "yes" : "",
      eff.filter(e => e.overridden).map(e => e.item.title).join("; "),
      eff.reduce((s, e) => s + e.unverified, 0),
      run ? `${run.provider}/${run.model}` : (g.status === "pending" ? "" : "manual"),
      g.comment || run?.comment || "", new Date(g.updatedAt).toISOString()];
  });
  return [head, ...rows].map(r => r.map(csvCell).join(",")).join("\n") + "\n";
}

export function download(filename, content, type = "text/plain") {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export const safeName = s => (s || "untitled").replace(/[^\w\-. ]+/g, "_").trim().slice(0, 80);

// ---- minimal ZIP writer (store, no compression) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function zip(files) { // files: [{name, content(string)}]
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = enc.encode(f.content), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}
