import * as store from "./lib/store.js";
import { gradeTranscript, PROVIDERS } from "./lib/llm.js";
import { effectiveItems, effectiveOverall, activeRun } from "./lib/grade.js";
import { gradesCsv, markdownReport, transcriptText, download, safeName, zip } from "./lib/export.js";
import { fetchTranscriptViaTab, runPool } from "./lib/batch.js";
import { rubricMax } from "./lib/rubric.js";
import { esc, shortModel } from "./lib/ui.js";
import { icon } from "./lib/icons.js";
import { makeSheet, mountSettings, mountHwSelect, quickModels } from "./lib/settings.js";
import { mountRubricEditor } from "./lib/rubricEditor.js";

const $ = s => document.querySelector(s);
let hw = null, grades = [], settings = null, filter = "all", pool = null;
let sel = null; // batch model {provider, model}; defaults to settings
const busy = new Map();
const sheet = makeSheet(document.body), nested = makeSheet(document.body);

const FILTERS = {
  all: ["All", () => true],
  pending: ["Pending", g => g.status === "pending"],
  ai: ["Review", g => g.status === "ai"],
  reviewed: ["Reviewed", g => g.status === "reviewed"],
  failed: ["Failed", g => g.status === "failed"],
  unverified: [icon("exclamationmark.triangle", "xs"), g => hw?.rubric && effectiveItems(g, hw.rubric.items).some(e => e.unverified)],
};

// static button contents
$("#menu").innerHTML = icon("line.3.horizontal");
$("#add").innerHTML = `${icon("plus")} Add`;
$("#b-ungraded").innerHTML = `${icon("sparkles")} Grade ungraded`;
$("#b-all").innerHTML = icon("arrow.clockwise");
$("#b-fetch").innerHTML = icon("doc.text");
$("#b-failed").innerHTML = icon("exclamationmark.triangle");
$("#b-stop").innerHTML = `${icon("stop.fill")} Stop`;
$("#x-menu").innerHTML = `${icon("square.and.arrow.up")} ${icon("chevron.down", "xs")}`;

async function load() {
  settings = await store.getSettings();
  if (!sel) sel = { provider: settings.provider, model: settings.model };
  hw = await store.getActiveHw();
  await mountHwSelect($("#hw"), { onChange: load, onAction: k => k === "new" ? openNewHw() : openEditHw() });
  $("#rubricinfo").textContent = hw?.rubric ? `${hw.rubric.items.length} items · ${rubricMax(hw.rubric.items)} pts` : "";
  grades = hw ? await store.listGrades(hw.id) : [];
  $("#b-model").innerHTML = `${esc(sel.provider === "manual" ? "Manual" : shortModel(sel.model))} ${icon("chevron.down", "xs")}`;
  render();
}
function openNewHw() { sheet.open("New homework", el => mountRubricEditor(el, { onDone: () => sheet.close(), onCancel: () => sheet.close() }), { onClose: load }); }
function openEditHw() { if (!hw) return openNewHw(); sheet.open(hw.name, el => mountRubricEditor(el, { hw, onDelete: () => sheet.close() }), { onClose: load }); }
$("#menu").onclick = () => sheet.open("Settings", el => mountSettings(el, { sheet: nested, onChange: load }), { onClose: load });

function render() {
  const setup = $("#setup"), work = $("#work");
  if (!hw || !hw.rubric?.items?.length) {
    work.hidden = true; setup.hidden = false;
    setup.innerHTML = `<h2 style="font-size:16px;margin-bottom:10px">${hw ? "Add a rubric" : "New homework"}</h2><div id="setup-ed"></div>`;
    mountRubricEditor($("#setup-ed"), hw ? { hw, onDone: load, onDelete: load } : { onDone: load });
    return;
  }
  setup.hidden = true; work.hidden = false;
  $("#filters").innerHTML = Object.entries(FILTERS).map(([k, [label, fn]]) =>
    `<button class="${k === filter ? "on" : ""}" data-f="${k}">${label} <span class="muted">${grades.filter(fn).length}</span></button>`).join("");
  const items = hw.rubric.items;
  const rows = grades.filter(FILTERS[filter][1]);
  const statusBadge = g => busy.has(g.videoId) ? `<span class="badge"><span class="spin"></span> ${esc(busy.get(g.videoId))}</span>` :
    ({ pending: `<span class="badge">pending</span>`, ai: `<span class="badge warn">review</span>`,
       reviewed: `<span class="badge ok">${icon("checkmark", "xs")} reviewed</span>`, failed: `<span class="badge bad" title="${esc(g.error || "")}">failed</span>` }[g.status] || g.status);
  $("#tbl").innerHTML = `<thead><tr><th>#</th><th>Student</th><th>Video</th><th>Status</th>
    ${items.map(it => `<th class="num" title="${esc(it.description)}">${esc(it.title.length > 18 ? it.title.slice(0, 17) + "…" : it.title)}<div class="small muted">/${it.maxPoints ?? "?"}</div></th>`).join("")}
    <th class="num">Total<div class="small muted">/${rubricMax(items)}</div></th><th>Model</th><th></th></tr></thead>
    <tbody>${rows.map((g, n) => {
      const eff = effectiveItems(g, items), ov = effectiveOverall(g, items), run = activeRun(g);
      const unv = eff.reduce((s, e) => s + e.unverified, 0);
      return `<tr data-v="${g.videoId}" class="${busy.has(g.videoId) ? "busy" : ""}">
        <td class="muted">${n + 1}</td>
        <td><input class="student" data-v="${g.videoId}" value="${esc(g.student)}" placeholder="—"></td>
        <td class="title"><a href="${esc(g.url)}" target="_blank">${esc(g.title || g.videoId)}</a>
          ${g.transcript?.length ? "" : `<span class="badge">no transcript</span>`} ${unv ? `<span class="badge warn" title="Quotes not found in transcript">${icon("exclamationmark.triangle", "xs")} ${unv}</span>` : ""}</td>
        <td>${statusBadge(g)}</td>
        ${eff.map(e => `<td class="num" title="${esc(e.rationale)}">${e.score == null ? `<span class="muted">–</span>` : e.overridden ? `<span class="ovr" title="AI: ${e.aiScore ?? "–"}">${e.score}</span>` : e.score}</td>`).join("")}
        <td class="num"><b class="${ov.overridden ? "ovr" : ""}">${ov.graded ? ov.overall : "–"}</b></td>
        <td class="small muted">${run ? esc(shortModel(run.model)) + (g.runs.length > 1 ? ` +${g.runs.length - 1}` : "") : ""}</td>
        <td class="acts">
          <button class="icon sm" data-a="open" title="Open in side panel">${icon("arrow.up.right")}</button>
          <button class="icon sm" data-a="grade" title="Grade">${icon("sparkles")}</button>
          <button class="icon sm danger" data-a="del" title="Remove">${icon("xmark")}</button></td></tr>`;
    }).join("") || `<tr><td colspan="${items.length + 7}" class="muted">No videos yet. Paste URLs above, or click Grade on any YouTube transcript.</td></tr>`}</tbody>`;
}

// ---------- add videos ----------
function parseLines(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split(/[,\t]/).map(c => c.trim().replace(/^"|"$/g, ""));
    const ui = cells.findIndex(c => store.parseVideoId(c));
    if (ui < 0) continue;
    out.push({ videoId: store.parseVideoId(cells[ui]), student: cells.filter((c, i) => i !== ui && c && !/^https?:/.test(c)).join(" ") });
  }
  return out;
}
$("#add").onclick = async () => {
  const list = parseLines($("#urls").value);
  let added = 0, updated = 0;
  for (const { videoId, student } of list) {
    const ex = await store.getGrade(hw.id, videoId);
    if (ex) { if (student && !ex.student) { ex.student = student; await store.saveGrade(ex); updated++; } continue; }
    await store.saveGrade(store.newGrade(hw.id, { videoId, student }));
    added++;
  }
  $("#progtext").textContent = `Added ${added}${updated ? `, updated ${updated}` : ""}${list.length - added - updated ? `, ${list.length - added - updated} already there` : ""}`;
  if (added) $("#urls").value = "";
  await load();
};

// ---------- batch ----------
async function processOne(videoId, mode) {
  const s = await store.getSettings();
  try {
    let g = await store.getGrade(hw.id, videoId);
    if (!g.transcript?.length) {
      busy.set(videoId, "fetching"); render();
      const res = await fetchTranscriptViaTab(g.url, { foreground: s.foregroundTabs });
      g = await store.getGrade(hw.id, videoId);
      g.transcript = res.transcript; g.title = g.title || res.info.title; g.error = null;
      if (g.status === "failed") g.status = "pending";
      await store.saveGrade(g);
    }
    if (mode !== "fetch" && sel.provider !== "manual") {
      busy.set(videoId, shortModel(sel.model)); render();
      const run = await gradeTranscript({ ...sel, keys: s.keys, rubric: hw.rubric, transcript: g.transcript, info: g });
      g = await store.getGrade(hw.id, videoId);
      g.runs.push(run); g.activeRunId = run.id;
      if (g.status !== "reviewed") g.status = "ai";
      g.error = null;
      await store.saveGrade(g);
    }
  } catch (e) {
    const g = await store.getGrade(hw.id, videoId);
    if (g) { g.status = "failed"; g.error = e.message; await store.saveGrade(g); }
    const log = $("#log"); log.hidden = false;
    log.textContent += `${videoId}: ${e.message}\n`;
  } finally { busy.delete(videoId); }
}

async function startBatch(mode) {
  if (pool) return;
  if (mode !== "fetch" && sel.provider === "manual") mode = "fetch";
  const todo = grades.filter(g =>
    mode === "all" ? true :
    mode === "fetch" ? !g.transcript?.length :
    mode === "failed" ? g.status === "failed" :
    !g.runs.length && g.status !== "reviewed").map(g => g.videoId);
  if (!todo.length) return alert("Nothing to do.");
  if (mode === "all" && !confirm(`Re-grade all ${todo.length} videos with ${sel.model}? Each adds a run; your overrides are kept.`)) return;
  $("#log").textContent = ""; $("#log").hidden = true;
  $("#prog").hidden = false; $("#b-stop").hidden = false;
  let done = 0;
  const upd = () => { $("#bar").max = todo.length; $("#bar").value = done; $("#progtext").textContent = `${done} / ${todo.length}`; };
  upd();
  const s = await store.getSettings();
  pool = runPool(todo, Number(s.concurrency || 2), async v => { await processOne(v, mode === "fetch" ? "fetch" : "grade"); done++; upd(); });
  await pool.done;
  pool = null; $("#b-stop").hidden = true; $("#prog").hidden = true;
  $("#progtext").textContent += " · done";
  await load();
}
$("#b-ungraded").onclick = () => startBatch("ungraded");
$("#b-all").onclick = () => startBatch("all");
$("#b-fetch").onclick = () => startBatch("fetch");
$("#b-failed").onclick = () => startBatch("failed");
$("#b-stop").onclick = () => { pool?.stop(); $("#progtext").textContent += " · stopping…"; };

// ---------- popover menus ----------
function popAt(anchor, html) {
  const pop = $("#popover");
  pop.innerHTML = html; pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  pop.style.top = Math.min(r.bottom + 4, innerHeight - pop.offsetHeight - 8) + "px";
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + "px";
  return pop;
}
document.addEventListener("mousedown", e => { if (!e.target.closest?.("#popover, #b-model, #x-menu")) $("#popover").hidden = true; });

$("#b-model").onclick = () => {
  const cur = `${sel.provider}:${sel.model}`;
  const opts = quickModels(settings, sel.provider !== "manual" ? [cur] : []);
  const pop = popAt($("#b-model"), `${opts.map(f => `<button class="mi ${f === cur ? "on" : ""}" data-m="${esc(f)}">${icon(f === cur ? "checkmark" : "circle", "xs")} ${esc(shortModel(f.split(":").slice(1).join(":")))}<span class="muted small" style="margin-left:auto">${esc(PROVIDERS[f.split(":")[0]]?.label || "")}</span></button>`).join("")}
    <hr><button class="mi ${sel.provider === "manual" ? "on" : ""}" data-m="manual:">${icon(sel.provider === "manual" ? "checkmark" : "tag", "xs")} Manual (fetch only)</button>
    <hr><button class="mi" data-more>${icon("gearshape", "xs")} More models…</button>`);
  pop.querySelectorAll("[data-m]").forEach(b => b.onclick = () => {
    const [p, ...m] = b.dataset.m.split(":");
    sel = { provider: p, model: m.join(":") || sel.model }; pop.hidden = true; load();
  });
  pop.querySelector("[data-more]").onclick = () => { pop.hidden = true; $("#menu").click(); };
};

const base = () => safeName(hw?.name || "homework");
const EXPORTS = {
  csv: ["tablecells", "CSV", () => download(`${base()}-grades.csv`, gradesCsv(grades, hw), "text/csv")],
  md: ["doc.text", "Report (.md)", () => download(`${base()}-report.md`,
    `# ${hw.name} — grading report\n\nGenerated ${new Date().toLocaleString()} · ${grades.length} videos\n\n` +
    grades.map(g => markdownReport(g, hw).replace(/^# /, "## ").replace(/\n## /g, "\n### ")).join("\n---\n\n"), "text/markdown")],
  json: ["doc.on.doc", "JSON", () => download(`${base()}-grades.json`, JSON.stringify({ homework: hw, grades }, null, 2), "application/json")],
  zip: ["folder", "Transcripts (.zip)", () => {
    const files = grades.filter(g => g.transcript?.length)
      .map((g, i) => ({ name: `${String(i + 1).padStart(2, "0")}-${safeName(g.student || g.title || g.videoId)}.txt`, content: transcriptText(g) }));
    if (!files.length) return alert("No transcripts yet.");
    download(`${base()}-transcripts.zip`, zip(files));
  }],
  view: ["text.quote", "View all transcripts", () => {
    const sec = $("#alltr");
    sec.hidden = !sec.hidden;
    if (sec.hidden) return;
    const items = hw?.rubric?.items || [];
    sec.innerHTML = `<h2 style="font-size:15px;margin-bottom:6px">All transcripts</h2>` + grades.filter(g => g.transcript?.length).map(g => {
      const tagged = new Set();
      effectiveItems(g, items).forEach(e => e.snippets.forEach(s => { for (let k = s.segStart; k <= s.segEnd; k++) tagged.add(k); }));
      return `<details class="tr"><summary>${esc(g.student || "—")} · ${esc(g.title || g.videoId)} <span class="muted small">(${g.transcript.length} lines)</span></summary>
        ${g.transcript.map((s, i) => `<div class="line ${tagged.has(i) ? "tagged" : ""}"><a class="ts" href="${store.videoLink(g.videoId, s.t)}" target="_blank">${esc(s.ts)}</a><span>${esc(s.text)}</span></div>`).join("")}</details>`;
    }).join("");
  }],
};
$("#x-menu").onclick = () => {
  const pop = popAt($("#x-menu"), Object.entries(EXPORTS).map(([k, [ic, label]]) => `<button class="mi" data-x="${k}">${icon(ic, "xs")} ${label}</button>`).join(""));
  pop.querySelectorAll("[data-x]").forEach(b => b.onclick = () => { pop.hidden = true; EXPORTS[b.dataset.x][2](); });
};

// ---------- table actions ----------
document.addEventListener("click", async e => {
  const f = e.target.closest?.("[data-f]");
  if (f) { filter = f.dataset.f; render(); return; }
  const b = e.target.closest?.("[data-a]");
  if (!b) return;
  const v = b.closest("tr")?.dataset.v;
  const g = grades.find(x => x.videoId === v);
  if (!g) return;
  if (b.dataset.a === "open") {
    const win = await chrome.windows.getCurrent();
    chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
    chrome.tabs.create({ url: g.url });
  } else if (b.dataset.a === "grade") {
    if (busy.has(v)) return;
    await processOne(v, "grade"); await load();
  } else if (b.dataset.a === "del") {
    if (!confirm(`Remove “${g.title || g.videoId}” and its grades from this homework?`)) return;
    await store.deleteGrade(hw.id, v); await load();
  }
});
document.addEventListener("change", async e => {
  if (e.target.classList.contains("student")) {
    const g = await store.getGrade(hw.id, e.target.dataset.v);
    g.student = e.target.value.trim(); await store.saveGrade(g);
  }
});

let t;
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || document.activeElement?.classList.contains("student") || sheet.el.classList.contains("open")) return;
  clearTimeout(t); t = setTimeout(load, 250);
});
load();
