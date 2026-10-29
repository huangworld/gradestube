// Homework + rubric editor. Create mode (hw=null) or edit mode. Used by side panel, dashboard, options.
import * as store from "./store.js";
import { parseRubric, rubricMax } from "./rubric.js";
import { icon } from "./icons.js";
import { esc } from "./ui.js";

const PH = "# Rubric\n## Problem framing (10 pts)\nClearly states the user need…\n## Demo (20 pts)\n…\n\nMarkdown tables (Criterion | Description | Points) work too.";

export function mountRubricEditor(el, { hw = null, onDone, onCancel, onDelete } = {}) {
  let ed = hw ? structuredClone(hw) : { name: "", rubric: null };
  let raw = ed.rubric?.rawText || "", filename = ed.rubric?.filename || null;
  const create = !hw;
  el.classList.add("rub");

  function render() {
    const r = ed.rubric;
    el.innerHTML = `
      <div class="row nowrap">
        <input id="rub-name" class="grow" placeholder="Homework name, e.g. A3 Video Pitch" value="${esc(ed.name)}" style="font-weight:600">
        ${create ? "" : `<button class="icon danger" id="rub-del" title="Delete homework and its grades">${icon("trash")}</button>`}
      </div>
      <div class="drop" id="rub-drop" style="margin-top:8px">Drop a .txt / .md rubric, <label style="color:var(--accent);cursor:pointer">choose a file<input type="file" id="rub-file" accept=".txt,.md,.markdown,text/plain,text/markdown" hidden></label>, or paste below</div>
      <textarea id="rub-raw" class="raw" placeholder="${esc(PH)}">${esc(raw)}</textarea>
      <div class="row" style="margin-top:6px">
        ${create
          ? `<button class="primary" id="rub-ok">${icon("checkmark")} Create</button>${onCancel ? `<button class="ghost" id="rub-cancel">Cancel</button>` : ""}`
          : `<button id="rub-parse">${icon("arrow.clockwise")} Re-parse</button>${r ? `<button class="ghost danger" id="rub-rm">Remove rubric</button>` : ""}${onDone ? `<button class="primary" id="rub-done">Done</button>` : ""}`}
        <span class="grow"></span><span id="rub-msg" class="small muted"></span>
      </div>
      ${r ? `<div class="sec">${r.items.length} items · ${rubricMax(r.items)} pts</div>
      <div class="items">${r.items.map((it, i) => `<div class="it" data-i="${i}">
        <input type="text" data-f="title" value="${esc(it.title)}" placeholder="Item">
        <input type="number" step="0.5" data-f="maxPoints" value="${it.maxPoints ?? ""}" placeholder="pts">
        <button class="icon sm danger" data-del="${i}" title="Remove">${icon("xmark")}</button>
        <textarea data-f="description" rows="1" placeholder="Description (optional)">${esc(it.description)}</textarea></div>`).join("")}
      </div><button class="ghost" id="rub-add" style="margin-top:6px">${icon("plus")} Add item</button>` : ""}`;

    el.querySelector("#rub-name").oninput = e => { ed.name = e.target.value; if (!create) persist(true); };
    el.querySelector("#rub-raw").oninput = e => { raw = e.target.value; };
    el.querySelector("#rub-file").onchange = e => readFile(e.target.files[0]);
    const drop = el.querySelector("#rub-drop");
    drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); readFile(e.dataTransfer.files[0]); };
    el.querySelector("#rub-ok")?.addEventListener("click", async () => {
      const items = raw.trim() ? parseRubric(raw) : [];
      if (raw.trim() && !items.length) return alert("Couldn't find rubric items. Use headings or bullets with points, e.g. “## Demo (20 pts)”, or a markdown table.");
      const rubric = items.length ? { rawText: raw, items, filename, uploadedAt: Date.now() } : null;
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
    if (!/\.(txt|md|markdown)$/i.test(f.name) && !/^text\//.test(f.type)) return alert("Please use a .txt or .md file.");
    raw = await f.text(); filename = f.name;
    el.querySelector("#rub-raw").value = raw;
    if (!ed.name.trim()) { ed.name = f.name.replace(/\.(txt|md|markdown)$/i, ""); el.querySelector("#rub-name").value = ed.name; }
    if (!create) applyRaw(); else msg(`${parseRubric(raw).length} items found`);
  }

  async function applyRaw() {
    const items = parseRubric(raw);
    if (!items.length) return alert("Couldn't find rubric items. Use headings or bullets with points, e.g. “## Demo (20 pts)”, or a markdown table.");
    if (ed.rubric && !confirm(`Replace the current rubric (${ed.rubric.items.length} items) with ${items.length} parsed items?`)) return;
    ed.rubric = { rawText: raw, items, filename, uploadedAt: Date.now() };
    await persist(); render();
  }

  let t;
  async function persist(debounce = false) {
    if (create) return;
    clearTimeout(t);
    const go = async () => { ed.name = ed.name.trim() || "Untitled"; await store.saveHomework(ed); msg("Saved"); };
    if (debounce) t = setTimeout(go, 400); else await go();
  }
  function msg(s) { const m = el.querySelector("#rub-msg"); if (m) { m.textContent = s; setTimeout(() => (m.textContent = ""), 1500); } }

  render();
  return { get: () => ed };
}
