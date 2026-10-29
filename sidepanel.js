import * as store from "./lib/store.js";
import { gradeTranscript, PROVIDERS } from "./lib/llm.js";
import { effectiveItems, effectiveOverall, activeRun, round } from "./lib/grade.js";
import { manualSnippet } from "./lib/grounding.js";
import { markdownReport, gradesCsv, transcriptText, download, safeName } from "./lib/export.js";
import { rubricMax } from "./lib/rubric.js";
import { esc, itemColor, ago, shortModel } from "./lib/ui.js";
import { icon } from "./lib/icons.js";
import { makeSheet, mountSettings, mountHwSelect, quickModels } from "./lib/settings.js";
import { mountRubricEditor } from "./lib/rubricEditor.js";

const $ = s => document.querySelector(s);
const S = {
  tabId: null, info: null,          // current YouTube tab + {videoId,title,url}
  hw: null, grade: null, settings: null,
  view: "rubric", compare: false,
  busy: null, error: null, search: "",
};
const sheet = makeSheet(document.body);
$("#menu").innerHTML = icon("line.3.horizontal");

// ---------------- data ----------------
async function loadHw() {
  S.settings = await store.getSettings();
  S.hw = await store.getActiveHw();
  await mountHwSelect($("#hw"), {
    onChange: async () => { await loadHw(); await loadGrade(); render(); },
    onAction: kind => kind === "new" ? openNewHw() : openEditHw(),
  });
}
function openNewHw() {
  sheet.open("New homework", el => mountRubricEditor(el, { onDone: () => sheet.close(), onCancel: () => sheet.close() }), { onClose: reload });
}
function openEditHw() {
  if (!S.hw) return openNewHw();
  sheet.open(S.hw.name, el => mountRubricEditor(el, { hw: S.hw, onDelete: () => sheet.close() }), { onClose: reload });
}
function openSettings() {
  sheet.open("Settings", el => mountSettings(el, { sheet: nested, onChange: reload }), { onClose: reload });
}
const nested = makeSheet(document.body); // second layer for hw edit from settings
async function reload() { await loadHw(); await loadGrade(); render(); }

async function detectTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const vid = tab.url ? store.parseVideoId(tab.url) : null;
  S.tabId = tab.id;
  S.info = vid ? { videoId: vid, title: (tab.title || "").replace(/ - YouTube$/, "").replace(/^\(\d+\)\s*/, ""), url: store.videoLink(vid) } : null;
}
async function loadGrade() { S.grade = S.hw && S.info ? await store.getGrade(S.hw.id, S.info.videoId) : null; }
async function save() { await store.saveGrade(S.grade); render(); }

async function ensureGrade(payload) {
  if (!S.hw) throw new Error("Create a homework first.");
  let g = await store.getGrade(S.hw.id, payload.videoId);
  if (!g) g = store.newGrade(S.hw.id, payload);
  if (payload.transcript?.length) g.transcript = payload.transcript;
  if (payload.title) g.title = payload.title;
  S.grade = await store.saveGrade(g);
  return g;
}

async function handlePending() {
  const { pendingGrade: p } = await chrome.storage.session.get("pendingGrade");
  if (!p || Date.now() - p.at > 120000) return;
  await chrome.storage.session.remove("pendingGrade");
  S.tabId = p.tabId;
  S.info = { videoId: p.videoId, title: p.title, url: p.url };
  S.error = null;
  try {
    await ensureGrade(p);
    if (S.settings.provider === "manual") { S.view = "transcript"; render(); }
    else if (!S.grade.runs.length) await runGrade();
    else render();
  } catch (e) { S.error = e.message; render(); }
}

async function loadTranscript() {
  S.busy = "Loading transcript…"; S.error = null; render();
  try {
    const res = await chrome.tabs.sendMessage(S.tabId, { action: "getTranscript", open: true });
    if (!res?.ok) throw new Error(res?.error || "Couldn't read transcript.");
    await ensureGrade({ ...res.info, transcript: res.transcript });
  } catch (e) {
    S.error = /Receiving end/.test(e.message) ? "Refresh the YouTube tab (extension was reloaded)." : e.message;
  }
  S.busy = null; render();
}

async function runGrade() {
  const { provider, model } = S.settings;
  if (provider === "manual") { S.view = "transcript"; render(); return; }
  if (!S.grade?.transcript?.length) { await loadTranscript(); if (!S.grade?.transcript?.length) return; }
  S.busy = `Grading with ${shortModel(model)}…`; S.error = null; render();
  try {
    const run = await gradeTranscript({ provider, model, keys: S.settings.keys, rubric: S.hw.rubric, transcript: S.grade.transcript, info: S.grade });
    const g = await store.getGrade(S.hw.id, S.grade.videoId) || S.grade;
    g.runs.push(run); g.activeRunId = run.id;
    if (g.status !== "reviewed") g.status = "ai";
    g.error = null;
    S.grade = g; S.view = "rubric";
    await store.saveGrade(g);
  } catch (e) { S.error = e.message; }
  S.busy = null; render();
}

async function seek(t) {
  const link = store.videoLink(S.grade.videoId, t);
  try {
    const tab = await chrome.tabs.get(S.tabId);
    if (store.parseVideoId(tab.url || "") === S.grade.videoId) { await chrome.tabs.sendMessage(S.tabId, { action: "seek", t }); return; }
  } catch {}
  const tab = await chrome.tabs.create({ url: link });
  S.tabId = tab.id;
}

// ---------------- render ----------------
function gradeButton(g) {
  const manual = S.settings.provider === "manual";
  const label = manual ? "Tag" : g?.runs.length ? "Re-grade" : "Grade";
  const dis = !!S.busy || !S.hw?.rubric?.items?.length || !S.info;
  return `<span class="grade-btn">
    <button class="primary" data-a="grade" ${dis ? "disabled" : ""}>${icon(manual ? "tag" : "sparkles")} ${label}</button>
    <button class="model" data-a="model" title="Switch model" ${S.busy ? "disabled" : ""}>${esc(manual ? "Manual" : shortModel(S.settings.model))} ${icon("chevron.down", "xs")}</button></span>`;
}

function render() {
  const app = $("#app");
  const msgs = [];
  if (S.busy) msgs.push(`<div class="card row nowrap"><span class="spin"></span> ${esc(S.busy)}</div>`);
  if (S.error) msgs.push(`<div class="err">${esc(S.error)}</div>`);

  if (!S.hw) {
    app.innerHTML = msgs.join("") + `<div class="setup"><h2>New homework</h2><div id="setup"></div></div>`;
    mountRubricEditor($("#setup"), { onDone: reload });
    return;
  }
  if (!S.hw.rubric?.items?.length) {
    app.innerHTML = msgs.join("") + `<div class="setup"><h2>Add a rubric</h2><div id="setup"></div></div>`;
    mountRubricEditor($("#setup"), { hw: S.hw, onDone: reload, onDelete: reload });
    return;
  }
  if (!S.info) {
    app.innerHTML = msgs.join("") + `<div class="empty">${icon("play.fill")}<div>Open a YouTube video, show its transcript, then click <b>Grade</b>.</div></div>`;
    return;
  }
  if (!S.grade?.transcript?.length) {
    app.innerHTML = msgs.join("") + `<div class="video"><h2>${esc(S.info.title)}</h2></div>
      <div class="empty">${icon("doc.text")}<div>No transcript yet.</div>
      <button class="primary" data-a="load" ${S.busy ? "disabled" : ""} style="margin-top:10px">${icon("square.and.arrow.down")} Load transcript</button></div>`;
    return;
  }

  const g = S.grade, items = S.hw.rubric.items;
  const eff = effectiveItems(g, items), ov = effectiveOverall(g, items), max = rubricMax(items);
  const run = activeRun(g);

  const head = `<div class="video">
    <h2><a href="${esc(g.url)}" target="_blank">${esc(g.title || g.videoId)}</a></h2>
    <div class="row nowrap">
      <input id="student" class="grow" placeholder="Student" value="${esc(g.student)}">
      <select id="status">${["pending", "ai", "reviewed", "failed"].map(s => `<option value="${s}" ${g.status === s ? "selected" : ""}>${{ pending: "Pending", ai: "AI graded", reviewed: "Reviewed", failed: "Failed" }[s]}</option>`).join("")}</select>
    </div></div>`;

  const score = `<div class="score-row">
    <span class="big ${ov.overridden ? "overridden" : ""}" style="${ov.overridden ? "color:var(--override)" : ""}">${ov.graded ? ov.overall : "–"}</span><span class="max">/ ${max}</span>
    <input type="number" step="any" id="overall" class="${ov.overridden ? "overridden" : ""}" value="${ov.overridden ? ov.overall : ""}" placeholder="edit" title="Override total (sum: ${ov.sum}${run ? `, AI: ${ov.aiSum}` : ""})">
    ${ov.overridden ? `<button class="icon sm" data-a="resetoverall" title="Reset to sum (${ov.sum})">${icon("arrow.counterclockwise")}</button>` : ""}
    <span class="grow"></span>${gradeButton(g)}</div>`;

  const runs = g.runs.length ? `<div class="runs">
    ${g.runs.map(r => `<span class="chip ${r.id === run?.id ? "on" : ""}" data-a="run" data-id="${r.id}" title="${esc(r.provider)} · ${new Date(r.at).toLocaleString()}">${esc(shortModel(r.model))} · ${ago(r.at)}<button class="icon sm x" data-a="delrun" data-id="${r.id}" title="Delete run" style="color:inherit">${icon("xmark", "xs")}</button></span>`).join("")}
    ${g.runs.length > 1 ? `<button class="icon sm ${S.compare ? "on" : ""}" data-a="compare" title="Compare runs" style="${S.compare ? "color:var(--accent)" : ""}">${icon("arrow.left.arrow.right")}</button>` : ""}</div>` : "";

  const tabs = `<div class="seg-ctl tabs">
    <button data-a="view" data-v="rubric" class="${S.view === "rubric" ? "on" : ""}">Rubric</button>
    <button data-a="view" data-v="transcript" class="${S.view === "transcript" ? "on" : ""}">Transcript</button></div>`;

  const body = S.view === "rubric" ? renderRubric(g, eff, run) : renderTranscript(g, eff);

  const foot = `<footer class="actions">
    <button class="icon" data-a="copyreport" title="Copy report (Markdown)">${icon("doc.on.doc")}</button>
    <button class="icon" data-a="dltranscript" title="Download transcript">${icon("square.and.arrow.down")}</button>
    <button class="icon" data-a="csv" title="Export homework CSV">${icon("square.and.arrow.up")}</button>
    <span class="grow"></span>
    <button class="icon" data-a="dash" title="Dashboard">${icon("tablecells")}</button></footer>`;

  const scroll = app.scrollTop;
  app.innerHTML = msgs.join("") + head + score + runs + tabs + body + foot;
  app.scrollTop = scroll;
}

function renderRubric(g, eff, run) {
  const comment = `<textarea class="comment" id="comment" rows="1" placeholder="${esc(run?.comment || "Comment")}">${esc(g.comment)}</textarea>`;
  const cards = eff.map((e, i) => {
    const it = e.item;
    let cmp = "";
    if (S.compare && g.runs.length > 1) {
      const scores = g.runs.map(r => ({ r, s: r.items.find(x => x.id === it.id)?.score }));
      const vals = scores.map(x => x.s).filter(v => v != null);
      const spread = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
      const dis = spread >= Math.max(1, 0.2 * (it.maxPoints || 0));
      cmp = `<div class="cmp">${scores.map(x => `<span class="chip ${dis ? "disagree" : ""}" title="${esc(x.r.items.find(y => y.id === it.id)?.rationale || "")}">${esc(shortModel(x.r.model))} ${x.s ?? "–"}</span>`).join("")}</div>`;
    }
    const snips = e.snippets.map(s => `<div class="snip ${s.source}">
        <button class="link ts" data-a="seek" data-t="${s.t}" title="Play from here (⌘-click: new tab)">${esc(s.ts)}</button>
        <span class="q" data-a="goto" data-seg="${s.segStart}" title="Show in transcript">“${esc(s.quote)}”</span>
        ${s.verified ? (s.fuzzy ? `<span class="badge" title="Close but not exact match">≈</span>` : "") : `<span class="badge warn" title="Quote not found in transcript">${icon("exclamationmark.triangle", "xs")}</span>`}
        ${s.source === "manual" ? `<span class="badge" title="Tagged by you">${icon("person", "xs")}</span>` : ""}
        <button class="icon sm x" data-a="delsnip" data-item="${it.id}" data-id="${s.id}" title="Remove">${icon("xmark", "xs")}</button></div>`).join("");
    return `<div class="card item" style="--c:${itemColor(i)}">
      <div class="item-head">
        <div class="title">${esc(it.title)}${it.description ? `<div class="desc">${esc(it.description)}</div>` : ""}</div>
        <div class="score-box">
          <input type="number" step="any" min="0" ${it.maxPoints != null ? `max="${it.maxPoints}"` : ""} data-score="${it.id}" class="${e.overridden ? "overridden" : ""}" value="${e.score ?? ""}" placeholder="–" title="${e.overridden ? `AI: ${e.aiScore ?? "–"}` : "Score"}">
          <span class="max">/${it.maxPoints ?? "?"}</span>
          ${e.overridden ? `<button class="icon sm" data-a="resetitem" data-id="${it.id}" title="Reset to AI score (${e.aiScore ?? "–"})">${icon("arrow.counterclockwise")}</button>` : ""}
        </div>
      </div>
      ${cmp}
      ${e.rationale ? `<div class="rationale">${esc(e.rationale)}</div>` : ""}
      <div class="snips">${snips || `<span class="muted small">No evidence</span>`}</div>
      <textarea class="note" data-note="${it.id}" rows="1" placeholder="Note">${esc(e.note)}</textarea>
    </div>`;
  }).join("");
  return comment + cards;
}

function renderTranscript(g, eff) {
  const segItems = g.transcript.map(() => []);
  eff.forEach((e, i) => e.snippets.forEach(s => {
    for (let k = s.segStart; k <= s.segEnd && k < segItems.length; k++) if (!segItems[k].includes(i)) segItems[k].push(i);
  }));
  const q = S.search.trim().toLowerCase();
  const legend = `<div class="legend">${eff.map((e, i) => `<span style="--c:${itemColor(i)}">${esc(e.item.title)} ${e.snippets.length}</span>`).join("")}</div>`;
  const rows = g.transcript.map((s, i) => {
    if (q && !s.text.toLowerCase().includes(q)) return "";
    const tags = segItems[i];
    return `<div class="seg ${tags.length ? "tagged" : ""}" data-i="${i}" style="${tags.length ? `--c:${itemColor(tags[0])}` : ""}" title="${tags.map(k => esc(eff[k].item.title)).join(", ")}">
      <button class="link ts" data-a="seek" data-t="${s.t}">${esc(s.ts)}</button>
      <span class="txt">${esc(s.text)}</span>
      <span class="dots">${tags.map(k => `<span class="dot" style="--c:${itemColor(k)}"></span>`).join("")}</span></div>`;
  }).join("");
  return `<div class="search">${icon("magnifyingglass")}<input id="search" placeholder="Search · select text to tag it" value="${esc(S.search)}"></div>
    ${legend}<div id="segs">${rows}</div>`;
}

// ---------------- model popover ----------------
function showModelMenu(anchor) {
  const pop = $("#popover"), s = S.settings;
  const cur = `${s.provider}:${s.model}`;
  const opts = quickModels(s);
  pop.innerHTML = `${opts.map(f => `<button class="mi ${f === cur ? "on" : ""}" data-m="${esc(f)}">${icon(f === cur ? "checkmark" : "circle", "xs")} ${esc(shortModel(f.split(":").slice(1).join(":")))}<span class="muted small" style="margin-left:auto">${esc(PROVIDERS[f.split(":")[0]]?.label || "")}</span></button>`).join("")}
    ${opts.length ? "<hr>" : ""}
    <button class="mi ${s.provider === "manual" ? "on" : ""}" data-m="manual:">${icon(s.provider === "manual" ? "checkmark" : "tag", "xs")} Manual</button>
    <hr><button class="mi" data-more>${icon("gearshape", "xs")} More models…</button>`;
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  pop.style.top = Math.min(r.bottom + 4, innerHeight - pop.offsetHeight - 8) + "px";
  pop.style.left = Math.max(8, Math.min(r.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 8)) + "px";
  pop.querySelectorAll("[data-m]").forEach(b => b.onclick = async () => {
    const [p, ...m] = b.dataset.m.split(":");
    S.settings = await store.saveSettings({ provider: p, model: m.join(":") || s.model });
    pop.hidden = true; render();
  });
  pop.querySelector("[data-more]").onclick = () => { pop.hidden = true; openSettings(); };
}
document.addEventListener("mousedown", e => { if (!e.target.closest?.("#popover, [data-a=model]")) $("#popover").hidden = true; });

// ---------------- events ----------------
document.addEventListener("click", async e => {
  const el = e.target.closest?.("[data-a]");
  if (!el) return;
  const a = el.dataset.a, g = S.grade;
  switch (a) {
    case "grade": await runGrade(); break;
    case "model": showModelMenu(el); break;
    case "load": await loadTranscript(); break;
    case "view": S.view = el.dataset.v; render(); break;
    case "compare": S.compare = !S.compare; render(); break;
    case "run": g.activeRunId = el.dataset.id; await save(); break;
    case "delrun":
      e.stopPropagation();
      if (!confirm("Delete this AI run?")) return;
      g.runs = g.runs.filter(r => r.id !== el.dataset.id);
      if (g.activeRunId === el.dataset.id) g.activeRunId = g.runs.at(-1)?.id || null;
      await save(); break;
    case "seek": {
      const t = Number(el.dataset.t);
      if (e.metaKey || e.ctrlKey) chrome.tabs.create({ url: store.videoLink(g.videoId, t) });
      else await seek(t);
      break;
    }
    case "goto":
      S.view = "transcript"; S.search = ""; render();
      requestAnimationFrame(() => {
        const r = document.querySelector(`.seg[data-i="${el.dataset.seg}"]`);
        r?.scrollIntoView({ block: "center" }); r?.classList.add("flash");
      });
      break;
    case "delsnip": {
      const { item, id } = el.dataset;
      if (g.manualSnippets[item]?.some(s => s.id === id)) g.manualSnippets[item] = g.manualSnippets[item].filter(s => s.id !== id);
      else g.removed[id] = true;
      await save(); break;
    }
    case "resetitem": delete g.overrides[el.dataset.id]; await save(); break;
    case "resetoverall": g.overallOverride = null; await save(); break;
    case "copyreport": await navigator.clipboard.writeText(markdownReport(g, S.hw)); flash(el); break;
    case "dltranscript": download(`${safeName(g.student || g.title)}.txt`, transcriptText(g)); break;
    case "csv": download(`${safeName(S.hw.name)}-grades.csv`, gradesCsv(await store.listGrades(S.hw.id), S.hw), "text/csv"); break;
    case "dash": chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") }); break;
  }
});

function flash(el) { const o = el.innerHTML; el.innerHTML = icon("checkmark"); el.style.color = "var(--ok)"; setTimeout(() => { el.innerHTML = o; el.style.color = ""; }, 1200); }

document.addEventListener("change", async e => {
  const t = e.target, g = S.grade;
  if (!g || t.closest(".sheet")) return;
  if (t.id === "student") g.student = t.value.trim();
  else if (t.id === "status") g.status = t.value;
  else if (t.id === "comment") g.comment = t.value;
  else if (t.id === "overall") g.overallOverride = t.value === "" ? null : round(Number(t.value));
  else if (t.dataset.score) {
    const id = t.dataset.score;
    const ai = activeRun(g)?.items.find(x => x.id === id)?.score;
    const v = t.value === "" ? null : round(Number(t.value));
    if (v == null || v === ai) delete g.overrides[id]; else g.overrides[id] = v;
  } else if (t.dataset.note) g.notes[t.dataset.note] = t.value;
  else return;
  await save();
});

document.addEventListener("input", e => {
  if (e.target.id === "search") {
    S.search = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const s = $("#search"); s.focus(); s.setSelectionRange(pos, pos);
  }
});

// ---- selection → tag popover ----
document.addEventListener("mouseup", e => {
  if (e.target.closest?.("#popover")) return;
  setTimeout(() => {
    const sel = getSelection();
    const pop = $("#popover");
    if (!sel || sel.isCollapsed || !S.grade || S.view !== "transcript") return;
    const segOf = n => (n.nodeType === 1 ? n : n.parentElement)?.closest(".seg");
    const a = segOf(sel.anchorNode), b = segOf(sel.focusNode);
    if (!a || !b) return;
    const i = Number(a.dataset.i), j = Number(b.dataset.i);
    const quote = sel.toString().replace(/\s*\n\s*\d{1,2}(:\d{2}){1,2}\s*\n?/g, " ").replace(/\s+/g, " ").trim();
    if (!quote) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    pop.innerHTML = `<div class="small muted" style="padding:2px 4px 4px">“${esc(quote.slice(0, 60))}${quote.length > 60 ? "…" : ""}”</div>
      ${S.hw.rubric.items.map((it, k) => `<label><input type="checkbox" value="${it.id}"><span class="sw" style="--c:${itemColor(k)}"></span>${esc(it.title)}</label>`).join("")}
      <div class="row" style="margin-top:6px;padding:0 4px"><button class="primary" id="tag-ok">${icon("tag")} Tag</button><button class="ghost" id="tag-cancel">Cancel</button></div>`;
    pop.hidden = false;
    pop.style.top = Math.min(rect.bottom + 6, innerHeight - pop.offsetHeight - 8) + "px";
    pop.style.left = Math.max(8, Math.min(rect.left, innerWidth - pop.offsetWidth - 8)) + "px";
    $("#tag-cancel").onclick = () => { pop.hidden = true; sel.removeAllRanges(); };
    $("#tag-ok").onclick = async () => {
      const ids = [...pop.querySelectorAll("input:checked")].map(c => c.value);
      if (!ids.length) return;
      const g = S.grade;
      for (const id of ids) (g.manualSnippets[id] ||= []).push(manualSnippet(g.transcript, Math.min(i, j), Math.max(i, j), quote));
      if (g.status === "pending") g.status = "reviewed";
      pop.hidden = true; sel.removeAllRanges();
      await save();
    };
  }, 10);
});

$("#menu").onclick = openSettings;

// ---- keep in sync with tabs/storage ----
async function refreshForTab() { await detectTab(); await loadGrade(); S.error = null; render(); }
chrome.tabs.onActivated.addListener(refreshForTab);
chrome.tabs.onUpdated.addListener((id, ch) => { if (id === S.tabId && ch.url) refreshForTab(); });
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "session" && changes.pendingGrade?.newValue) return handlePending();
  if (area !== "local") return;
  if (changes.settings) S.settings = await store.getSettings();
  if (changes.homeworks || changes.activeHw) { if (!sheet.el.classList.contains("open")) await reload(); return; }
  if (changes.settings && !sheet.el.classList.contains("open")) render();
  if (S.hw && S.grade) {
    const k = store.gradeKey(S.hw.id, S.grade.videoId);
    const nv = changes[k]?.newValue;
    if (nv && nv.updatedAt !== S.grade.updatedAt && !document.activeElement?.matches("input,textarea")) { S.grade = nv; render(); }
  }
});

// ---- init ----
(async () => {
  await loadHw();
  await detectTab();
  await loadGrade();
  render();
  await handlePending();
})();
