// Settings panel (model, keys, batch, homeworks) + sliding sheet helper.
import * as store from "./store.js";
import { mountPicker } from "./picker.js";
import { mountRubricEditor } from "./rubricEditor.js";
import { icon } from "./icons.js";
import { esc } from "./ui.js";
import { rubricMax } from "./rubric.js";
import { PROVIDERS } from "./llm.js";

// "provider:model" entries for quick-switch menus: favorites + current + one default per provider with a key.
export function quickModels(s, extra = []) {
  const out = [...s.favorites, ...extra];
  if (s.provider !== "manual" && s.model) out.push(`${s.provider}:${s.model}`);
  for (const [p, v] of Object.entries(PROVIDERS)) if (p !== "manual" && (s.keys[p] || p === "anthropic") && !out.some(f => f.startsWith(p + ":"))) out.push(`${p}:${v.presets[0]}`);
  return [...new Set(out)].filter(f => !f.startsWith("manual"));
}

// Sliding sheet inside `host` (host must be position:relative). Returns {open(title, mount), close}.
export function makeSheet(host) {
  const el = document.createElement("div");
  el.className = "sheet";
  el.innerHTML = `<header><button class="icon" data-close title="Back">${icon("chevron.left")}</button><h2></h2></header><div class="body"></div>`;
  host.appendChild(el);
  const body = el.querySelector(".body");
  let onClose = null;
  const close = () => { el.classList.remove("open"); onClose?.(); onClose = null; setTimeout(() => { if (!el.classList.contains("open")) body.innerHTML = ""; }, 250); };
  el.querySelector("[data-close]").onclick = close;
  return {
    open(title, mount, opts = {}) {
      el.querySelector("h2").textContent = title;
      body.innerHTML = ""; onClose = opts.onClose || null;
      mount(body);
      el.classList.add("open");
      body.scrollTop = 0;
    },
    close, el,
  };
}

// Full settings UI. opts.sheet (optional) lets homework edit open in a nested view.
export async function mountSettings(el, { sheet, onChange } = {}) {
  el.classList.add("settings");
  el.innerHTML = `
    <div class="sec">Model</div><div id="st-picker"></div>
    <div class="sec">API keys</div>
    <div class="field"><span>Anthropic</span><input type="password" data-key="anthropic" placeholder="sk-ant-…" autocomplete="off"></div>
    <div class="field"><span>OpenAI</span><input type="password" data-key="openai" placeholder="sk-…" autocomplete="off"></div>
    <div class="field"><span>Gemini</span><input type="password" data-key="gemini" placeholder="AIza…" autocomplete="off"></div>
    <div class="small muted">Stored in this browser only; sent only to the matching provider.</div>
    <div class="sec">Batch</div>
    <div class="row"><label class="row nowrap">Parallel <select id="st-conc"><option>1</option><option>2</option><option>3</option><option>4</option></select></label>
      <label class="row nowrap" title="Background tabs can be throttled by Chrome. Foreground is slower to watch but more reliable."><input type="checkbox" id="st-fg"> foreground tabs</label></div>
    <div class="sec">Homeworks</div>
    <div id="st-hws"></div>
    <button class="ghost" id="st-newhw">${icon("plus")} New homework</button>
    <div class="sec">More</div>
    <button class="ghost" id="st-dash">${icon("tablecells")} Dashboard</button>`;

  const picker = await mountPicker(el.querySelector("#st-picker"), { onChange: () => onChange?.() });
  const s = await store.getSettings();
  el.querySelectorAll("[data-key]").forEach(inp => {
    inp.value = s.keys[inp.dataset.key] || "";
    inp.onchange = async () => {
      const cur = await store.getSettings();
      await store.saveSettings({ keys: { ...cur.keys, [inp.dataset.key]: inp.value.trim() }, modelCache: { ...cur.modelCache, [inp.dataset.key]: undefined } });
      picker.refresh();
    };
  });
  el.querySelector("#st-conc").value = String(s.concurrency || 2);
  el.querySelector("#st-fg").checked = !!s.foregroundTabs;
  el.querySelector("#st-conc").onchange = e => store.saveSettings({ concurrency: Number(e.target.value) });
  el.querySelector("#st-fg").onchange = e => store.saveSettings({ foregroundTabs: e.target.checked });
  el.querySelector("#st-dash").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });

  async function renderHws() {
    const all = await store.getHomeworks(), active = await store.getActiveHwId();
    const list = Object.values(all).sort((a, b) => (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0));
    el.querySelector("#st-hws").innerHTML = list.map(h => `<div class="hw-row" data-id="${h.id}">
      <span class="cur" style="width:16px">${h.id === active ? icon("checkmark") : ""}</span>
      <button class="link name" data-use style="color:inherit;text-align:left">${esc(h.name)}</button>
      <span class="small muted">${h.rubric ? `${h.rubric.items.length} · ${rubricMax(h.rubric.items)} pts` : `<span class="badge warn">no rubric</span>`}</span>
      <button class="icon sm" data-edit title="Edit rubric">${icon("pencil")}</button></div>`).join("")
      || `<div class="small muted">None yet.</div>`;
    el.querySelectorAll(".hw-row").forEach(row => {
      row.querySelector("[data-use]").onclick = async () => { await store.setActiveHw(row.dataset.id); renderHws(); onChange?.(); };
      row.querySelector("[data-edit]").onclick = async () => editHw(all[row.dataset.id]);
    });
  }
  function editHw(hw) {
    const mount = body => mountRubricEditor(body, { hw, onDelete: () => { sheet?.close(); renderHws(); onChange?.(); } });
    if (sheet) sheet.open(hw.name, mount, { onClose: () => { renderHws(); onChange?.(); } });
    else { const d = document.createElement("div"); d.className = "card"; d.style.margin = "8px 0"; el.querySelector("#st-hws").after(d); mount(d); }
  }
  el.querySelector("#st-newhw").onclick = () => {
    const mount = body => mountRubricEditor(body, { onDone: () => { sheet?.close(); renderHws(); onChange?.(); }, onCancel: () => sheet?.close() });
    if (sheet) sheet.open("New homework", mount, { onClose: () => { renderHws(); onChange?.(); } });
    else { const d = document.createElement("div"); d.className = "card"; d.style.margin = "8px 0"; el.querySelector("#st-newhw").before(d); mountRubricEditor(d, { onDone: () => { d.remove(); renderHws(); onChange?.(); }, onCancel: () => d.remove() }); }
  };
  await renderHws();
  return { picker, renderHws };
}

// Homework <select> with "New…" / "Edit…" actions. onAction(kind) for new/edit.
export async function mountHwSelect(sel, { onChange, onAction }) {
  const all = await store.getHomeworks(), active = await store.getActiveHwId();
  const list = Object.values(all).sort((a, b) => (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0));
  sel.innerHTML = (list.length ? list.map(h => `<option value="${h.id}" ${h.id === active ? "selected" : ""}>${esc(h.name)}</option>`).join("") : `<option value="">No homework</option>`)
    + `<option disabled>──────</option><option value="__new">New homework…</option>${active ? `<option value="__edit">Edit rubric…</option>` : ""}`;
  sel.onchange = async e => {
    const v = e.target.value;
    if (v === "__new" || v === "__edit") { sel.value = active || ""; onAction?.(v.slice(2)); return; }
    await store.setActiveHw(v); onChange?.();
  };
}
