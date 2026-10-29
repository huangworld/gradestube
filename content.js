// YT Rubric Grader — content script (youtube.com)
(() => {
  // YouTube ships multiple transcript layouts; try each.
  const SEG_SELECTORS = [
    "ytd-transcript-segment-renderer",     // classic (ytd-transcript-search-panel-renderer)
    ".ytwTranscriptSegmentViewModelHost",  // newer view-model layout
    "transcript-segment-view-model",
  ];
  const TS_RE = /^\d{1,2}(:\d{2}){1,2}$/;
  const tsToSec = ts => ts.split(":").map(Number).reduce((a, b) => a * 60 + b, 0);

  function segmentEls() {
    for (const sel of SEG_SELECTORS) {
      const els = document.querySelectorAll(sel);
      if (els.length) return Array.from(els);
    }
    return [];
  }

  function extract() {
    const out = [];
    for (const el of segmentEls()) {
      let ts = el.querySelector(".segment-timestamp")?.innerText.trim();
      let text = el.querySelector(".segment-text")?.innerText.trim();
      if (!ts || !text) {
        const lines = el.innerText.split("\n").map(s => s.trim()).filter(Boolean);
        const i = lines.findIndex(l => TS_RE.test(l));
        if (i >= 0) { ts = lines[i]; text = lines.filter((_, j) => j !== i).join(" "); }
        else text = lines.join(" ");
      }
      if (!text) continue;
      ts = ts && TS_RE.test(ts) ? ts : (out.length ? out[out.length - 1].ts : "0:00");
      out.push({ t: tsToSec(ts), ts, text: text.replace(/\s+/g, " ") });
    }
    return out;
  }

  function videoInfo() {
    const u = new URL(location.href);
    let videoId = u.searchParams.get("v");
    if (!videoId) videoId = (u.pathname.match(/^\/(shorts|live)\/([\w-]+)/) || [])[2] || null;
    const title = document.querySelector("ytd-watch-metadata h1")?.innerText.trim()
      || document.title.replace(/^\(\d+\)\s*/, "").replace(/ - YouTube$/, "");
    const channel = document.querySelector("ytd-watch-metadata #channel-name a, #owner #channel-name a")?.innerText.trim() || "";
    return { videoId, title, channel, url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : location.href };
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function openTranscriptPanel() {
    const findBtn = () => document.querySelector(
      "ytd-video-description-transcript-section-renderer button, button[aria-label='Show transcript'], button[aria-label*='transcript' i]");
    let btn = findBtn();
    if (!btn) {
      document.querySelector("#description-inline-expander #expand, ytd-text-inline-expander #expand, #expand")?.click();
      await sleep(600);
      btn = findBtn();
    }
    if (btn) { btn.click(); return true; }
    const panel = document.querySelector("ytd-engagement-panel-section-list-renderer[target-id*='transcript']");
    if (panel) { panel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"); return true; }
    return false;
  }

  async function waitForSegments(timeout = 15000) {
    const end = Date.now() + timeout;
    let last = -1;
    while (Date.now() < end) {
      const n = segmentEls().length;
      if (n && n === last) return true; // stable count
      last = n;
      await sleep(500);
    }
    return segmentEls().length > 0;
  }

  // Wait until the watch page for the expected video has rendered.
  async function waitForWatchPage(timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (document.querySelector("ytd-watch-metadata h1, ytd-video-description-transcript-section-renderer")) return true;
      await sleep(400);
    }
    return false;
  }

  // ---------- toast ----------
  function toast(msg, ms = 4000) {
    let t = document.getElementById("ytrg-toast");
    if (!t) { t = document.createElement("div"); t.id = "ytrg-toast"; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove("show"), ms);
  }

  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };

  // ---------- in-panel toolbar ----------
  function findPanel() {
    const p = document.querySelector("ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-searchable-transcript']")
      || document.querySelector("ytd-engagement-panel-section-list-renderer[target-id*='transcript']");
    if (p && p.getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED") return p;
    const seg = segmentEls()[0];
    return seg?.closest("ytd-engagement-panel-section-list-renderer") || seg?.closest("ytd-transcript-search-panel-renderer") || null;
  }

  async function hwLabel() {
    if (!alive()) return "Extension reloaded — refresh page";
    const { activeHw, homeworks, settings } = await chrome.storage.local.get(["activeHw", "homeworks", "settings"]);
    const hw = homeworks?.[activeHw];
    if (!hw) return "No homework set up — open Settings";
    const model = settings?.provider === "manual" ? "manual" : (settings?.model || "claude-opus-5-5");
    return `${hw.name}${hw.rubric?.items?.length ? ` · ${hw.rubric.items.length} items` : " · ⚠ no rubric"} · ${model}`;
  }

  function buildToolbar() {
    const bar = document.createElement("div");
    bar.id = "ytrg-toolbar";
    bar.innerHTML = `
      <button class="ytrg-primary" data-a="grade">✓ Grade based on rubric</button>
      <button data-a="download" title="Download transcript (.txt)">⬇</button>
      <button data-a="copy" title="Copy transcript">⧉</button>
      <button data-a="settings" title="Homework & rubric settings">⚙</button>
      <div class="ytrg-label"></div>`;
    bar.addEventListener("click", e => {
      const a = e.target.closest("button")?.dataset.a;
      if (a) actions[a]();
    });
    return bar;
  }

  async function refreshLabel() {
    const l = document.querySelector("#ytrg-toolbar .ytrg-label");
    if (l) l.textContent = await hwLabel();
  }

  function ensureToolbar() {
    const panel = findPanel();
    if (!panel || panel.querySelector("#ytrg-toolbar")) return;
    document.getElementById("ytrg-toolbar")?.remove();
    const host = panel.querySelector("#content") || panel;
    host.prepend(buildToolbar());
    refreshLabel();
  }

  const transcriptLines = (info, segs) =>
    `${info.title}\n${info.url}\n\n` + segs.map(s => `[${s.ts}] ${s.text}`).join("\n") + "\n";

  const actions = {
    grade() {
      if (!alive()) return toast("Extension was reloaded. Refresh this page.");
      const transcript = extract();
      if (!transcript.length) return toast("No transcript segments found.");
      const info = videoInfo();
      // Must be sent synchronously from the click so the side panel can open (user gesture).
      chrome.runtime.sendMessage({ action: "openGrader", payload: { ...info, transcript } }, res => {
        if (chrome.runtime.lastError || !res?.ok)
          toast("Couldn't open side panel automatically. Right-click the extension icon → Open side panel.", 7000);
      });
    },
    download() {
      const segs = extract(), info = videoInfo();
      if (!segs.length) return toast("No transcript segments found.");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([transcriptLines(info, segs)], { type: "text/plain" }));
      a.download = `${(info.title || info.videoId).replace(/[^\w\-. ]+/g, "_").slice(0, 80)}.txt`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    async copy() {
      const segs = extract();
      if (!segs.length) return toast("No transcript segments found. Make sure the transcript panel is open.");
      await navigator.clipboard.writeText(segs.map(s => `${s.ts} ${s.text}`).join("\n"));
      toast(`Copied ${segs.length} transcript segments.`);
    },
    settings() {
      if (!alive()) return toast("Extension was reloaded. Refresh this page.");
      chrome.runtime.sendMessage({ action: "openOptions" });
    },
  };

  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; if (alive()) ensureToolbar(); }, 300);
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["visibility"] });
  document.addEventListener("yt-navigate-finish", () => setTimeout(ensureToolbar, 800));
  try { chrome.storage.onChanged.addListener(() => refreshLabel()); } catch {}

  // ---------- messages ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "copyTranscript") { actions.copy(); return; }
    if (msg.action === "seek") {
      const v = document.querySelector("video");
      if (v) { v.currentTime = msg.t; v.play?.(); }
      sendResponse({ ok: !!v });
      return;
    }
    if (msg.action === "getTranscript") {
      (async () => {
        try {
          if (msg.batch) {
            await waitForWatchPage();
            document.querySelector("video")?.pause();
          }
          if (!segmentEls().length && msg.open) {
            if (!(await openTranscriptPanel())) return sendResponse({ ok: false, error: "No transcript button (video may have no captions)." });
          }
          if (!(await waitForSegments(msg.open ? 15000 : 1000)))
            return sendResponse({ ok: false, error: "Transcript did not load (no captions, or tab was throttled — try foreground tabs)." });
          if (msg.batch) document.querySelector("video")?.pause();
          sendResponse({ ok: true, info: videoInfo(), transcript: extract() });
        } catch (e) { sendResponse({ ok: false, error: String(e) }); }
      })();
      return true;
    }
    if (msg.action === "ping") { sendResponse({ ok: true, info: videoInfo() }); return; }
  });
})();
