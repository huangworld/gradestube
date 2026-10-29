import * as store from "./lib/store.js";
import { parseRubric, rubricMax } from "./lib/rubric.js";
import { mountPicker } from "./lib/picker.js";
import { esc } from "./lib/ui.js";

const $ = s => document.querySelector(s);
let picker, editing = null; // editing: working copy of selected homework

async function initKeys() {
  const s = await store.getSettings();
  document.querySelectorAll("[data-key]").forEach(inp => {
    inp.value = s.keys[inp.dataset.key] || "";
    inp.onchange = async () => {
      const cur = await store.getSettings();
      await store.saveSettings({ keys: { ...cur.keys, [inp.dataset.key]: inp.value.trim() }, modelCache: { ...cur.modelCache, [inp.dataset.key]: undefined } });
      picker.refresh();
    };
  });
}

async function renderList() {
  const all = await store.getHomeworks(), active = await store.getActiveHwId();
  $("#hwlist").innerHTML = Object.values(all).map(h =>
    `<span class="chip ${h.id === active ? "on" : ""}" data-id="${h.id}">${esc(h.name)}${h.rubric ? "" : " ⚠"}</span>`).join("")
    || `<span class="muted">No homeworks yet.</span>`;
  $("#hwlist").querySelectorAll(".chip").forEach(c => c.onclick = async () => { await store.setActiveHw(c.dataset.id); await load(); });
}

async function load() {
  await renderList();
  const hw = await store.getActiveHw();
  editing = hw ? structuredClone(hw) : null;
  renderEdit();
}

function renderEdit() {
  const el = $("#hwedit");
  if (!editing) { el.innerHTML = ""; return; }
  const r = editing.rubric;
  el.innerHTML = `
  <h2>Active homework</h2>
  <section class="card">
    <div class="row"><input id="hwname" class="grow" value="${esc(editing.name)}">
      <button id="delhw" class="danger">Delete homework</button></div>
    <div class="small muted" style="margin-top:6px">New videos you grade go into the active homework. The side panel and dashboard can switch homeworks too.</div>
  </section>

  <h2>Rubric ${r ? `<span class="badge">${r.items.length} items · ${rubricMax(r.items)} pts</span>` : ""}</h2>
  <section class="card">
    <div class="drop" id="drop">Drop a <b>.txt</b> or <b>.md</b> rubric here, or <label class="link" style="color:var(--accent);cursor:pointer">choose a file<input type="file" id="file" accept=".txt,.md,.markdown,text/plain,text/markdown" hidden></label>, or paste below.</div>
    <textarea id="raw" placeholder="# Rubric&#10;## Problem framing (10 pts)&#10;Clearly states the user need…&#10;## Demo (20 pts)&#10;…&#10;&#10;Markdown tables (Criterion | Description | Points) work too.">${esc(r?.rawText || "")}</textarea>
    <div class="row" style="margin-top:6px">
      <button id="parse">Parse rubric</button>
      ${r ? `<button id="rmrubric" class="danger">Remove rubric</button>` : ""}
      <span class="grow"></span><span id="savemsg" class="small muted"></span>
    </div>
  </section>

  ${r ? `<h2>Rubric items <span class="small muted">(edit freely; the full rubric text above is also sent to the model)</span></h2>
  <section class="card">
    <table id="items"><thead><tr><th style="width:30%">Item</th><th>Description</th><th>Max pts</th><th></th></tr></thead>
    <tbody>${r.items.map((it, i) => `<tr data-i="${i}">
      <td><input type="text" data-f="title" value="${esc(it.title)}"></td>
      <td><textarea data-f="description" rows="1">${esc(it.description)}</textarea></td>
      <td><input type="number" step="0.5" data-f="maxPoints" value="${it.maxPoints ?? ""}"></td>
      <td><button class="icon danger" data-del="${i}" title="Remove item">×</button></td></tr>`).join("")}</tbody></table>
    <div class="row" style="margin-top:8px"><button id="additem">+ Add item</button><span class="grow"></span><b>Total: ${rubricMax(r.items)}</b></div>
  </section>` : ""}`;

  $("#hwname").onchange = e => { editing.name = e.target.value.trim() || "Untitled"; persist(); };
  $("#delhw").onclick = async () => {
    if (!confirm(`Delete “${editing.name}” and ALL its grades? This can't be undone.`)) return;
    await store.deleteHomework(editing.id); await load();
  };
  $("#file").onchange = e => readFile(e.target.files[0]);
  const drop = $("#drop");
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); readFile(e.dataTransfer.files[0]); };
  $("#parse").onclick = () => applyRaw($("#raw").value);
  $("#rmrubric")?.addEventListener("click", async () => {
    if (!confirm("Remove this rubric? Existing grades keep their scores but won't display until a rubric is added.")) return;
    editing.rubric = null; await persist(); renderEdit();
  });
  if (r) {
    $("#items").addEventListener("change", e => {
      const tr = e.target.closest("tr"), f = e.target.dataset.f;
      if (!tr || !f) return;
      const it = r.items[Number(tr.dataset.i)];
      it[f] = f === "maxPoints" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value;
      persist(); if (f === "maxPoints") renderEdit();
    });
    $("#items").addEventListener("click", e => {
      const i = e.target.dataset.del;
      if (i == null) return;
      r.items.splice(Number(i), 1); persist(); renderEdit();
    });
    $("#additem").onclick = () => {
      const n = Math.max(0, ...r.items.map(it => Number(it.id.slice(1)) || 0)) + 1;
      r.items.push({ id: `c${n}`, title: "New item", description: "", maxPoints: null });
      persist(); renderEdit();
    };
  }
}

async function readFile(f) {
  if (!f) return;
  if (!/\.(txt|md|markdown)$/i.test(f.name) && !/^text\//.test(f.type)) return alert("Please use a .txt or .md file.");
  const text = await f.text();
  $("#raw").value = text;
  applyRaw(text, f.name);
}

async function applyRaw(text, filename) {
  const items = parseRubric(text);
  if (!items.length) return alert("Couldn't find rubric items. Use headings or bullets with points, e.g. “## Demo (20 pts)”, or a markdown table.");
  if (editing.rubric && !confirm(`Replace the current rubric (${editing.rubric.items.length} items) with ${items.length} parsed items?`)) return;
  editing.rubric = { rawText: text, items, filename: filename || null, uploadedAt: Date.now() };
  await persist(); renderEdit();
}

async function persist() {
  await store.saveHomework(editing);
  await renderList();
  const m = $("#savemsg"); if (m) { m.textContent = "Saved ✓"; setTimeout(() => (m.textContent = ""), 1200); }
}

$("#newhw").onclick = async () => {
  const name = prompt("Homework name", "A3 – Video");
  if (!name) return;
  const hw = await store.createHomework(name.trim());
  await store.setActiveHw(hw.id);
  await load();
};

(async () => {
  picker = await mountPicker($("#picker"));
  await initKeys();
  await load();
})();
