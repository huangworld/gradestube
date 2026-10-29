// Provider + model picker with live model lists, favorites, custom ids.
import { getSettings, saveSettings } from "./store.js";
import { PROVIDERS, listModels } from "./llm.js";
import { icon } from "./icons.js";
import { esc, shortModel } from "./ui.js";

const DAY = 864e5;

// state: {provider, model}. onChange called with new state. persist=true saves as default.
export async function mountPicker(el, { onChange, persist = true, initial, compact = false } = {}) {
  let s = await getSettings();
  const state = initial ? { ...initial } : { provider: s.provider, model: s.model };
  el.classList.add("picker");

  async function models(provider, force = false) {
    if (provider === "manual") return [];
    const c = s.modelCache[provider];
    if (!force && c && Date.now() - c.at < DAY && c.models.length) return c.models;
    try {
      const list = await listModels(provider, s.keys[provider]);
      s = await saveSettings({ modelCache: { ...s.modelCache, [provider]: { at: Date.now(), models: list } } });
      return list;
    } catch { return c?.models || []; }
  }

  async function render(force = false) {
    const live = await models(state.provider, force);
    const favs = s.favorites.filter(f => f.startsWith(state.provider + ":")).map(f => f.split(":").slice(1).join(":"));
    const all = [...new Set([...favs, ...PROVIDERS[state.provider].presets, ...live, ...(state.model ? [state.model] : [])])];
    const cur = `${state.provider}:${state.model}`;
    const isFav = s.favorites.includes(cur);
    el.innerHTML = `
      <div class="seg-ctl p-provider">${Object.entries(PROVIDERS).map(([k, v]) => `<button data-p="${k}" class="${k === state.provider ? "on" : ""}">${v.label}</button>`).join("")}</div>
      ${state.provider === "manual" ? "" : `
      <div class="row nowrap">
        <select class="p-model" title="Model">
          ${all.map(m => `<option value="${esc(m)}" ${m === state.model ? "selected" : ""}>${favs.includes(m) ? "★ " : ""}${esc(m)}</option>`).join("")}
          <option value="__custom">Custom model id…</option>
        </select>
        <button class="icon p-star" title="${isFav ? "Unstar" : "Star"}">${icon(isFav ? "star.fill" : "star")}</button>
        <button class="icon p-refresh" title="Refresh model list">${icon("arrow.clockwise")}</button>
      </div>`}
      ${!compact && s.favorites.length ? `<div class="p-favs">${s.favorites.map(f => `<button class="chip p-fav ${f === cur ? "on" : ""}" data-f="${esc(f)}" title="${esc(f)}">${esc(shortModel(f.split(":").slice(1).join(":")))}</button>`).join("")}</div>` : ""}`;
    el.querySelectorAll(".p-provider button").forEach(b => b.onclick = async () => {
      state.provider = b.dataset.p;
      const list = state.provider === "manual" ? [] : [...PROVIDERS[state.provider].presets, ...(await models(state.provider))];
      const fav = s.favorites.find(f => f.startsWith(state.provider + ":"));
      state.model = fav ? fav.split(":").slice(1).join(":") : (list[0] || "");
      await commit();
    });
    el.querySelector(".p-model")?.addEventListener("change", async e => {
      if (e.target.value === "__custom") {
        const id = prompt("Model id", state.model);
        if (id) state.model = id.trim();
      } else state.model = e.target.value;
      await commit();
    });
    el.querySelector(".p-star")?.addEventListener("click", async () => {
      const f = s.favorites.includes(cur) ? s.favorites.filter(x => x !== cur) : [...s.favorites, cur];
      s = await saveSettings({ favorites: f });
      render();
    });
    el.querySelector(".p-refresh")?.addEventListener("click", () => render(true));
    el.querySelectorAll(".p-fav").forEach(b => b.onclick = async () => {
      const [p, ...m] = b.dataset.f.split(":");
      state.provider = p; state.model = m.join(":");
      await commit();
    });
  }

  async function commit() {
    if (persist) s = await saveSettings({ provider: state.provider, model: state.model });
    onChange?.({ ...state });
    render();
  }

  await render();
  return {
    get: () => ({ ...state }),
    set: async st => { Object.assign(state, st); await commit(); },
    refresh: async () => { s = await getSettings(); render(); },
  };
}
