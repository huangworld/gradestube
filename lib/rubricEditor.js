// Homework + rubric editor. Create mode (hw=null) or edit mode. Used by side panel, dashboard, options.
import * as store from "./store.js";
import { parseRubric, parseRubricLLM, parseRubricStructured, rubricMax } from "./rubric.js";
import { xlsxToText } from "./xlsx.js";
import { shortModel } from "./ui.js";
import { icon } from "./icons.js";
import { esc } from "./ui.js";

const PH = "Paste anything: Markdown, a CSV/spreadsheet export, or plain prose.\n\n## Problem framing (10 pts)\nClearly states the user need…\n## Demo (20 pts)\n…";
const ACCEPT = ".txt,.md,.markdown,.csv,.tsv,.xlsx,text/plain,text/markdown,text/csv";

export function mountRubricEditor(el, { hw = null, onDone, onCancel, onDelete } = {}) {
  let ed = hw ? structuredClone(hw) : { name: "", rubric: null };
  let raw = ed.rubric?.rawText || "", filename = ed.rubric?.filename || null, busy = false;
  const create = !hw;
  const parserInfo = async () => {
    const s = await store.getSettings();
    return s.provider !== "manual" && s.keys[s.provider] ? { provider: s.provider, model: s.model, keys: s.keys } : null;
  };
  el.classList.add("rub");

  function render() {
    const r = ed.rubric;
    el.innerHTML = `
      <div class="row nowrap">
        <input id="rub-name" class="grow" placeholder="Homework name, e.g. A3 Video Pitch" value="${esc(ed.name)}" style="font-weight:600">
        ${create ? "" : `<button class="icon danger" id="rub-del" title="Delete homework and its grades">${icon("trash")}</button>`}
      </div>
      <div class="drop" id="rub-drop" style="margin-top:8px">Drop a rubric (.md, .txt, .csv, .xlsx), <label style="color:var(--accent);cursor:pointer">choose a file<input type="file" id="rub-file" accept="${ACCEPT}" hidden></label>, or paste below</div>
      <textarea id="rub-raw" class="raw" placeholder="${esc(PH)}">${esc(raw)}</textarea>
      <div class="row" style="margin-top:6px">
        ${create
          ? `<button class="primary" id="rub-ok" ${busy ? "disabled" : ""}>${icon("checkmark")} Create</button>${onCancel ? `<button class="ghost" id="rub-cancel">Cancel</button>` : ""}`
          : `<button id="rub-parse" ${busy ? "disabled" : ""}>${icon("sparkles")} Re-parse</button>${r ? `<button class="ghost danger" id="rub-rm">Remove rubric</button>` : ""}${onDone ? `<button class="primary" id="rub-done">Done</button>` : ""}`}
        <span class="grow"></span><span id="rub-msg" class="small muted"></span>
      </div>
      <div class="small muted" id="rub-how" style="margin-top:4px"></div>
      </div>
      ${r ? `<div class="sec">${r.items.length} items · ${rubricMax(r.items)} pts</div>
      <div class="items">${r.items.map((it, i) => `<div class="it" data-i="${i}">
        <input type="text" data-f="title" value="${esc(it.title)}" placeholder="Item">
        <input type="number" step="any" data-f="maxPoints" value="${it.maxPoints ?? ""}" placeholder="pts">
        <button class="icon sm danger" data-del="${i}" title="Remove">${icon("xmark")}</button>
        <textarea data-f="description" rows="1" placeholder="Description (optional)">${esc(it.description)}</textarea></div>`).join("")}
      </div><button class="ghost" id="rub-add" style="margin-top:6px">${icon("plus")} Add item</button>
      <div class="sec">Grading notes</div>
      <textarea id="rub-notes" rows="3" placeholder="Rules that apply across items (sent to the model with every video)">${esc(r.notes || "")}</textarea>` : ""}`;
    parserInfo().then(pi => { const h = el.querySelector("#rub-how"); if (h) h.textContent = pi ? `Tables (CSV/xlsx) load directly; other formats are parsed with ${shortModel(pi.model)}.` : "Tables (CSV/xlsx), headings and bullets with points load directly. Add a key in ☰ to parse prose."; });
    el.querySelector("#rub-notes")?.addEventListener("change", e => { r.notes = e.target.value; persist(); });

    el.querySelector("#rub-name").oninput = e => { ed.name = e.target.value; if (!create) persist(true); };
    el.querySelector("#rub-raw").oninput = e => { raw = e.target.value; };
    el.querySelector("#rub-file").onchange = e => readFile(e.target.files[0]);
    const drop = el.querySelector("#rub-drop");
    drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); readFile(e.dataTransfer.files[0]); };
    el.querySelector("#rub-ok")?.addEventListener("click", async () => {
      let rubric = null;
      if (raw.trim()) {
        const parsed = await parse();
        if (!parsed) return;
        rubric = { rawText: raw, items: parsed.items, notes: parsed.notes, filename, uploadedAt: Date.now() };
        if (!ed.name.trim() && parsed.title) ed.name = parsed.title;
      }
      const created = await store.createHomework(ed.name.trim() || "Untitled homework", rubric);
      onDone?.(created);
    });
    el.querySelector("#rub-cancel")?.addEventListener("click", () => onCancel?.());
    el.querySelector("#rub-done")?.addEventListener("click", () => onDone?.(ed));
    el.querySelector("#rub-parse")?.addEventListener("click", () => applyRaw());
    el.querySelector("#rub-rm")?.addEventListener("click", async () => {
      if (!confirm("Remove this rubric? Grades keep their scores but won't display until a rubric is added.")) return;
      ed.rubric = null; await persist(); render();
    });
    el.querySelector("#rub-del")?.addEventListener("click", async () => {
      if (!confirm(`Delete “${ed.name}” and ALL its grades? This can't be undone.`)) return;
      await store.deleteHomework(ed.id); onDelete?.();
    });
    if (r) {
      el.querySelector(".items").addEventListener("change", e => {
        const row = e.target.closest(".it"), f = e.target.dataset.f;
        if (!row || !f) return;
        const it = r.items[Number(row.dataset.i)];
        it[f] = f === "maxPoints" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value;
        persist(); if (f === "maxPoints") render();
      });
      el.querySelector(".items").addEventListener("click", e => {
        const b = e.target.closest("[data-del]"); if (!b) return;
        r.items.splice(Number(b.dataset.del), 1); persist(); render();
      });
      el.querySelector("#rub-add").onclick = () => {
        const n = Math.max(0, ...r.items.map(it => Number(it.id.slice(1)) || 0)) + 1;
        r.items.push({ id: `c${n}`, title: "", description: "", maxPoints: null });
        persist(); render();
        el.querySelector(".it:last-child input")?.focus();
      };
    }
  }

  async function readFile(f) {
    if (!f) return;
    if (/\.xlsx$/i.test(f.name)) {
      try { raw = await xlsxToText(await f.arrayBuffer()); } catch (e) { return alert(`Couldn't read spreadsheet: ${e.message}`); }
    } else if (/\.(txt|md|markdown|csv|tsv)$/i.test(f.name) || /^text\//.test(f.type)) raw = await f.text();
    else return alert("Use a .md, .txt, .csv, .tsv or .xlsx file.");
    filename = f.name;
    el.querySelector("#rub-raw").value = raw;
    if (!ed.name.trim()) { ed.name = f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "); el.querySelector("#rub-name").value = ed.name; }
    if (!create) applyRaw(); else msg("Loaded. Click Create to parse.");
  }

  // Structured table (CSV/TSV/xlsx) → deterministic. Else LLM when a key is set, else heuristic.
  async function parse() {
    const st = parseRubricStructured(raw);
    if (st) { msg(`${st.items.length} items from table`, 3000); return st; }
    const pi = await parserInfo();
    busy = true; setBusy(true);
    try {
      if (pi) {
        msg(`Parsing with ${shortModel(pi.model)}…`, 0);
        try { return await parseRubricLLM(raw, pi); }
        catch (e) { console.warn("LLM parse failed", e); msg(`AI parse failed (${e.message.slice(0, 80)}); using built-in parser`, 5000); }
      }
      const items = parseRubric(raw);
      if (!items.length) { alert("Couldn't find rubric items. Use headings or bullets with points, e.g. “## Demo (20 pts)”, a markdown table, or add an API key in ☰ so the model can parse any format."); return null; }
      return { items, notes: "", title: "" };
    } finally { busy = false; setBusy(false); }
  }
  function setBusy(b) { el.querySelectorAll("#rub-ok, #rub-parse").forEach(x => { x.disabled = b; }); }

  async function applyRaw() {
    if (!raw.trim()) return;
    const parsed = await parse();
    if (!parsed) return;
    if (ed.rubric && !confirm(`Replace the current rubric (${ed.rubric.items.length} items) with ${parsed.items.length} parsed items?`)) return;
    ed.rubric = { rawText: raw, items: parsed.items, notes: parsed.notes || ed.rubric?.notes || "", filename, uploadedAt: Date.now() };
    await persist(); render();
  }

  let t;
  async function persist(debounce = false) {
    if (create) return;
    clearTimeout(t);
    const go = async () => { ed.name = ed.name.trim() || "Untitled"; await store.saveHomework(ed); msg("Saved"); };
    if (debounce) t = setTimeout(go, 400); else await go();
  }
  let mt;
  function msg(s, ms = 1500) { const m = el.querySelector("#rub-msg"); if (!m) return; m.textContent = s; clearTimeout(mt); if (ms) mt = setTimeout(() => (m.textContent = ""), ms); }

  render();
  return { get: () => ed };
}
