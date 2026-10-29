// Toolbar icon: copy transcript (original behavior).
chrome.action.onClicked.addListener(tab => {
  chrome.tabs.sendMessage(tab.id, { action: "copyTranscript" }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "openGrader") {
    // Call sidePanel.open first, synchronously, to keep the user gesture.
    const opening = chrome.sidePanel.open({ windowId: sender.tab.windowId });
    const stash = chrome.storage.session.set({
      pendingGrade: { ...msg.payload, tabId: sender.tab.id, at: Date.now() },
    });
    Promise.all([opening, stash])
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.action === "openOptions") { chrome.runtime.openOptionsPage(); return; }
});

// Let extension pages (side panel) read session storage.
chrome.storage.session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
