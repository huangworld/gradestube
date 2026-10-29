// chrome.storage.local wrapper. Keys:
//   settings, homeworks, activeHw, grades:<hwId>:<videoId>
const local = chrome.storage.local;

export const DEFAULT_SETTINGS = {
  provider: "anthropic",
  model: "claude-opus-5-5",
  keys: { anthropic: "", openai: "", gemini: "" },
  favorites: [],          // ["anthropic:claude-opus-5-5", ...]
  modelCache: {},         // { provider: { at, models: [] } }
  foregroundTabs: false,  // batch: open tabs active (more reliable, steals focus)
  concurrency: 2,
};

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export async function getSettings() {
  const { settings } = await local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}), keys: { ...DEFAULT_SETTINGS.keys, ...(settings?.keys || {}) } };
}
export async function saveSettings(patch) {
  const s = { ...(await getSettings()), ...patch };
  await local.set({ settings: s });
  return s;
}

// ---- homeworks ----
export async function getHomeworks() {
  const { homeworks } = await local.get("homeworks");
  return homeworks || {};
}
export async function saveHomework(hw) {
  const all = await getHomeworks();
  all[hw.id] = hw;
  await local.set({ homeworks: all });
  return hw;
}
export async function createHomework(name, rubric = null) {
  const hw = { id: uid(), name: name || "Untitled homework", rubric, createdAt: Date.now(), lastUsedAt: Date.now() };
  await saveHomework(hw);
  await setActiveHw(hw.id);
  return hw;
}
// Most recently used homework (fallback when none is active).
export const mostRecent = all => Object.values(all).sort((a, b) => (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0))[0] || null;
export async function deleteHomework(id) {
  const all = await getHomeworks();
  delete all[id];
  const keys = Object.keys(await local.get(null)).filter(k => k.startsWith(`grades:${id}:`));
  await local.remove(keys);
  await local.set({ homeworks: all });
  if ((await getActiveHwId()) === id) await setActiveHw(mostRecent(all)?.id || null);
}
export async function getActiveHwId() {
  const { activeHw, homeworks } = await local.get(["activeHw", "homeworks"]);
  if (activeHw && homeworks?.[activeHw]) return activeHw;
  const mr = mostRecent(homeworks || {});
  if (mr) await local.set({ activeHw: mr.id });
  return mr?.id || null;
}
export async function setActiveHw(id) {
  const all = await getHomeworks();
  if (id && all[id]) { all[id].lastUsedAt = Date.now(); await local.set({ homeworks: all }); }
  await local.set({ activeHw: id });
}
export async function getActiveHw() {
  const id = await getActiveHwId();
  if (!id) return null;
  return (await getHomeworks())[id] || null;
}

// ---- grades ----
export const gradeKey = (hwId, videoId) => `grades:${hwId}:${videoId}`;
export async function getGrade(hwId, videoId) {
  const k = gradeKey(hwId, videoId);
  return (await local.get(k))[k] || null;
}
export async function saveGrade(g) {
  g.updatedAt = Date.now();
  await local.set({ [gradeKey(g.hwId, g.videoId)]: g });
  return g;
}
export async function deleteGrade(hwId, videoId) { await local.remove(gradeKey(hwId, videoId)); }
export async function listGrades(hwId) {
  const all = await local.get(null);
  const prefix = `grades:${hwId}:`;
  return Object.entries(all).filter(([k]) => k.startsWith(prefix)).map(([, v]) => v)
    .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
}
export function newGrade(hwId, info) {
  return {
    hwId, videoId: info.videoId, url: info.url || `https://www.youtube.com/watch?v=${info.videoId}`,
    title: info.title || "", student: info.student || "", status: "pending", error: null,
    transcript: info.transcript || null,
    runs: [], activeRunId: null,
    overrides: {},        // itemId -> score
    manualSnippets: {},   // itemId -> [snippet]
    removed: {},          // snippetId -> true (hidden AI snippets)
    notes: {},            // itemId -> text
    overallOverride: null, comment: "",
    addedAt: Date.now(), updatedAt: Date.now(),
  };
}

// ---- video helpers ----
export function parseVideoId(url) {
  try {
    const u = new URL(url.trim());
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (u.hostname.endsWith("youtube.com")) {
      if (u.searchParams.get("v")) return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{6,})/);
      if (m) return m[2];
    }
  } catch {}
  return null;
}
export const videoLink = (videoId, t) =>
  `https://www.youtube.com/watch?v=${videoId}${t != null ? `&t=${Math.floor(t)}s` : ""}`;
