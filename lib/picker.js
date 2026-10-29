// Provider + model picker with live model lists, favorites, custom ids.
import { getSettings, saveSettings } from "./store.js";
import { PROVIDERS, listModels } from "./llm.js";

const DAY = 864e5;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// state: {provider, model}. onChange called with new state. persist=true saves as default.
export async function mountPicker(el, { onChange, persist = true, initial } = {}) {
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
    const isFav = s.favorites.includes(`${state.provider}:${state.model}`);
    const allFavs = s.favorites;
    el.innerHTML = `
      <select class="p-provider" title="Provider">
        ${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}" ${k === state.provider ? "selected" : ""}>${v.label}</option>`).join("")}
      </select>
      ${state.provider === "manual" ? "" : `
      <select class="p-model" title="Model">
        ${all.map(m => `<option value="${esc(m)}" ${m === state.model ? "selected" : ""}>${favs.includes(m) ? "★ " : ""}${esc(m)}</option>`).join("")}
        <option value="__custom">Custom model id…</option>
      </select>
      <button class="p-star icon" title="${isFav ? "Unstar" : "Star"} model">${isFav ? "★" : "☆"}</button>
      <button class="p-refresh icon" title="Refresh model list">↻</button>`}
      ${allFavs.length > 1 ? `<span class="p-favs">${allFavs.map(f => `<button class="chip p-fav ${f === `${state.provider}:${state.model}` ? "on" : ""}" data-f="${esc(f)}" title="${esc(f)}">${esc(f.split(":").slice(1).join(":").replace(/^claude-/, ""))}</button>`).join("")}</span>` : ""}`;
    el.querySelector(".p-provider").onchange = async e => {
      state.provider = e.target.value;
      const list = state.provider === "manual" ? [] : [...PROVIDERS[state.provider].presets, ...(await models(state.provider))];
      const fav = s.favorites.find(f => f.startsWith(state.provider + ":"));
      state.model = fav ? fav.split(":").slice(1).join(":") : (list[0] || "");
      await commit();
    };
    el.querySelector(".p-model")?.addEventListener("change", async e => {
      if (e.target.value === "__custom") {
        const id = prompt("Model id", state.model);
        if (id) state.model = id.trim();
      } else state.model = e.target.value;
      await commit();
    });
    el.querySelector(".p-star")?.addEventListener("click", async () => {
      const k = `${state.provider}:${state.model}`;
      const f = s.favorites.includes(k) ? s.favorites.filter(x => x !== k) : [...s.favorites, k];
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
  return { get: () => ({ ...state }), refresh: async () => { s = await getSettings(); render(); } };
}
