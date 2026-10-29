// Fetch a video's transcript by opening it in a tab and asking the content script.
const sleep = ms => new Promise(r => setTimeout(r, ms));

function waitComplete(tabId, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); reject(new Error("Page load timed out")); }, timeout);
    const fn = (id, info) => {
      if (id === tabId && info.status === "complete") { clearTimeout(to); chrome.tabs.onUpdated.removeListener(fn); resolve(); }
    };
    chrome.tabs.onUpdated.addListener(fn);
    chrome.tabs.get(tabId).then(t => { if (t.status === "complete") fn(tabId, { status: "complete" }); }).catch(() => {});
  });
}

export async function fetchTranscriptViaTab(url, { foreground = false } = {}) {
  const me = await chrome.tabs.getCurrent().catch(() => null);
  const tab = await chrome.tabs.create({ url, active: foreground });
  chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
  try {
    await waitComplete(tab.id);
    let res, lastErr;
    for (let i = 0; i < 12; i++) {
      try {
        res = await chrome.tabs.sendMessage(tab.id, { action: "getTranscript", open: true, batch: true });
        break;
      } catch (e) { lastErr = e; await sleep(1000); } // content script not ready yet
    }
    if (!res) throw new Error(lastErr?.message || "Content script did not respond");
    if (!res.ok) throw new Error(res.error);
    if (!res.transcript.length) throw new Error("Empty transcript");
    return res;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
    if (foreground && me) chrome.tabs.update(me.id, { active: true }).catch(() => {});
  }
}

// Simple worker pool. task(item) => Promise. Returns {stop()} and a done promise.
export function runPool(items, concurrency, task) {
  let i = 0, stopped = false;
  const worker = async () => {
    while (!stopped && i < items.length) {
      const it = items[i++];
      await task(it);
    }
  };
  const done = Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { done, stop: () => { stopped = true; } };
}
