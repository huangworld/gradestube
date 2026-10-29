import * as store from "./lib/store.js";
import { gradeTranscript } from "./lib/llm.js";
import { effectiveItems, effectiveOverall, activeRun } from "./lib/grade.js";
import { gradesCsv, markdownReport, transcriptText, download, safeName, zip } from "./lib/export.js";
import { fetchTranscriptViaTab, runPool } from "./lib/batch.js";
import { mountPicker } from "./lib/picker.js";
import { rubricMax } from "./lib/rubric.js";
import { esc, shortModel } from "./lib/ui.js";

const $ = s => document.querySelector(s);
let hw = null, grades = [], picker, filter = "all", pool = null;
const busy = new Map(); // videoId -> label

const FILTERS = {
  all: ["All", () => true],
  pending: ["Pending", g => g.status === "pending"],
  ai: ["Needs review", g => g.status === "ai"],
  reviewed: ["Reviewed", g => g.status === "reviewed"],
  failed: ["Failed", g => g.status === "failed"],
  unverified: ["⚠ Unverified quotes", g => hw?.rubric && effectiveItems(g, hw.rubric.items).some(e => e.unverified)],
};

async function load() {
  const all = await store.getHomeworks(), active = await store.getActiveHwId();
  hw = all[active] || null;
  $("#hw").innerHTML = Object.values(all).map(h => `<option value="${h.id}" ${h.id === active ? "selected" : ""}>${esc(h.name)}</option>`).join("")
    || `<option>No homework</option>`;
  $("#rubricinfo").textContent = !hw ? "Create a homework in Settings." :
    hw.rubric ? `${hw.rubric.items.length} rubric items · ${rubricMax(hw.rubric.items)} pts` : "⚠ No rubric — add one in Settings";
  grades = hw ? await store.listGrades(hw.id) : [];
  render();
}

function render() {
  $("#filters").innerHTML = Object.entries(FILTERS).map(([k, [label, fn]]) =>
    `<span class="chip ${k === filter ? "on" : ""}" data-f="${k}">${label} (${grades.filter(fn).length})</span>`).join("");
  const items = hw?.rubric?.items || [];
  const rows = grades.filter(FILTERS[filter][1]);
  const statusBadge = g => busy.has(g.videoId) ? `<span class="badge"><span class="spin"></span> ${esc(busy.get(g.videoId))}</span>` :
    ({ pending: `<span class="badge">pending</span>`, ai: `<span class="badge warn">needs review</span>`,
       reviewed: `<span class="badge ok">reviewed ✓</span>`, failed: `<span class="badge bad" title="${esc(g.error || "")}">failed</span>` }[g.status] || g.status);
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
          ${g.transcript?.length ? "" : `<span class="badge">no transcript</span>`} ${unv ? `<span class="badge warn" title="Quotes not found in transcript">⚠ ${unv}</span>` : ""}</td>
        <td>${statusBadge(g)}</td>
        ${eff.map(e => `<td class="num" title="${esc(e.rationale)}">${e.score == null ? `<span class="muted">–</span>` : e.overridden ? `<span class="ovr" title="AI: ${e.aiScore ?? "–"}">${e.score}</span>` : e.score}</td>`).join("")}
        <td class="num"><b class="${ov.overridden ? "ovr" : ""}">${ov.graded ? ov.overall : "–"}</b></td>
        <td class="small muted">${run ? esc(shortModel(run.model)) + (g.runs.length > 1 ? ` +${g.runs.length - 1}` : "") : ""}</td>
        <td class="row" style="flex-wrap:nowrap">
          <button class="icon" data-a="open" title="Open video + side panel">↗</button>
          <button class="icon" data-a="grade" title="Grade with selected model">▶</button>
          <button class="icon danger" data-a="del" title="Remove from homework">×</button></td></tr>`;
    }).join("") || `<tr><td colspan="${items.length + 7}" class="muted">No videos here yet. Paste URLs above, or click “Grade based on rubric” on any YouTube transcript.</td></tr>`}</tbody>`;
}

// ---------- add videos ----------
function parseLines(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split(/[,\t]/).map(c => c.trim().replace(/^"|"$/g, ""));
    const ui = cells.findIndex(c => store.parseVideoId(c));
    if (ui < 0) continue; // header or junk
    out.push({ videoId: store.parseVideoId(cells[ui]), student: cells.filter((c, i) => i !== ui && c && !/^https?:/.test(c)).join(" ") });
  }
  return out;
}

$("#add").onclick = async () => {
  if (!hw) return alert("Create a homework first (Settings).");
  const list = parseLines($("#urls").value);
  let added = 0, updated = 0;
  for (const { videoId, student } of list) {
    const ex = await store.getGrade(hw.id, videoId);
    if (ex) { if (student && !ex.student) { ex.student = student; await store.saveGrade(ex); updated++; } continue; }
    await store.saveGrade(store.newGrade(hw.id, { videoId, student }));
    added++;
  }
  $("#addmsg").textContent = `Added ${added}${updated ? `, updated ${updated}` : ""}${list.length - added - updated ? `, ${list.length - added - updated} already there` : ""}.`;
  if (added) $("#urls").value = "";
  await load();
};

// ---------- batch ----------
async function processOne(videoId, mode) {
  const sel = picker.get();
  const settings = await store.getSettings();
  try {
    let g = await store.getGrade(hw.id, videoId);
    if (!g.transcript?.length) {
      busy.set(videoId, "fetching transcript"); render();
      const res = await fetchTranscriptViaTab(g.url, { foreground: $("#fg").checked });
      g = await store.getGrade(hw.id, videoId);
      g.transcript = res.transcript;
      g.title = g.title || res.info.title;
      g.error = null;
      if (g.status === "failed") g.status = "pending";
      await store.saveGrade(g);
    }
    if (mode !== "fetch" && sel.provider !== "manual") {
      busy.set(videoId, `grading · ${shortModel(sel.model)}`); render();
      const run = await gradeTranscript({ ...sel, keys: settings.keys, rubric: hw.rubric, transcript: g.transcript, info: g });
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
  if (!hw?.rubric && mode !== "fetch") return alert("This homework has no rubric.");
  if (pool) return;
  const sel = picker.get();
  if (mode !== "fetch" && sel.provider === "manual") mode = "fetch";
  const todo = grades.filter(g =>
    mode === "all" ? true :
    mode === "fetch" ? !g.transcript?.length :
    mode === "failed" ? g.status === "failed" :
    !g.runs.length && g.status !== "reviewed").map(g => g.videoId);
  if (!todo.length) return alert("Nothing to do for that selection.");
  if (mode === "all" && !confirm(`Re-grade all ${todo.length} videos with ${sel.model}? Each adds a new run (your overrides are kept).`)) return;
  $("#log").textContent = ""; $("#log").hidden = true;
  $("#prog").hidden = false; $("#b-stop").hidden = false;
  let done = 0;
  const upd = () => { $("#bar").max = todo.length; $("#bar").value = done; $("#progtext").textContent = `${done} / ${todo.length} done`; };
  upd();
  pool = runPool(todo, Number($("#conc").value), async v => { await processOne(v, mode === "fetch" ? "fetch" : "grade"); done++; upd(); });
  await pool.done;
  pool = null; $("#b-stop").hidden = true;
  $("#progtext").textContent += " · finished";
  await load();
}

$("#b-ungraded").onclick = () => startBatch("ungraded");
$("#b-all").onclick = () => startBatch("all");
$("#b-fetch").onclick = () => startBatch("fetch");
$("#b-failed").onclick = () => startBatch("failed");
$("#b-stop").onclick = () => { pool?.stop(); $("#progtext").textContent += " · stopping after current videos…"; };

// ---------- table actions ----------
document.addEventListener("click", async e => {
  const f = e.target.closest?.("[data-f]");
  if (f) { filter = f.dataset.f; render(); return; }
  const b = e.target.closest("[data-a]");
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
  if (e.target.id === "hw") { await store.setActiveHw(e.target.value); return load(); }
  if (e.target.classList.contains("student")) {
    const g = await store.getGrade(hw.id, e.target.dataset.v);
    g.student = e.target.value.trim(); await store.saveGrade(g);
  }
  if (e.target.id === "conc") store.saveSettings({ concurrency: Number(e.target.value) });
  if (e.target.id === "fg") store.saveSettings({ foregroundTabs: e.target.checked });
});

// ---------- exports ----------
const base = () => safeName(hw?.name || "homework");
$("#x-csv").onclick = () => hw && download(`${base()}-grades.csv`, gradesCsv(grades, hw), "text/csv");
$("#x-md").onclick = () => hw && download(`${base()}-report.md`,
  `# ${hw.name} — grading report\n\nGenerated ${new Date().toLocaleString()} · ${grades.length} videos\n\n` +
  grades.map(g => markdownReport(g, hw).replace(/^# /, "## ").replace(/\n## /g, "\n### ")).join("\n---\n\n"), "text/markdown");
$("#x-json").onclick = () => hw && download(`${base()}-grades.json`, JSON.stringify({ homework: hw, grades }, null, 2), "application/json");
$("#x-zip").onclick = () => {
  const files = grades.filter(g => g.transcript?.length)
    .map((g, i) => ({ name: `${String(i + 1).padStart(2, "0")}-${safeName(g.student || g.title || g.videoId)}.txt`, content: transcriptText(g) }));
  if (!files.length) return alert("No transcripts yet.");
  download(`${base()}-transcripts.zip`, zip(files));
};
$("#x-view").onclick = () => {
  const sec = $("#alltr");
  sec.hidden = !sec.hidden;
  if (sec.hidden) return;
  const items = hw?.rubric?.items || [];
  sec.innerHTML = `<h2 style="font-size:16px">All transcripts</h2>` + grades.filter(g => g.transcript?.length).map(g => {
    const tagged = new Set();
    effectiveItems(g, items).forEach(e => e.snippets.forEach(s => { for (let k = s.segStart; k <= s.segEnd; k++) tagged.add(k); }));
    return `<details class="tr"><summary>${esc(g.student || "—")} · ${esc(g.title || g.videoId)} <span class="muted small">(${g.transcript.length} lines)</span></summary>
      ${g.transcript.map((s, i) => `<div class="line ${tagged.has(i) ? "tagged" : ""}"><a class="ts" href="${store.videoLink(g.videoId, s.t)}" target="_blank">${esc(s.ts)}</a><span>${esc(s.text)}</span></div>`).join("")}</details>`;
  }).join("");
};

$("#settings").onclick = () => chrome.runtime.openOptionsPage();

let t;
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || document.activeElement?.classList.contains("student")) return;
  clearTimeout(t); t = setTimeout(load, 250);
});

(async () => {
  const s = await store.getSettings();
  $("#conc").value = String(s.concurrency || 2);
  $("#fg").checked = !!s.foregroundTabs;
  picker = await mountPicker($("#picker"), { persist: false });
  await load();
})();
