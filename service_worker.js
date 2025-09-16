// service_worker.js — CatBlocker background/service worker

const DEFAULT_SETTINGS = {
    enabled: true,
    intensity: "balanced",
    whitelist: [],
    customCatUrls: []
};

/* ================================
   Helpers
================================ */

/* ================================
   Installation / Updates
================================ */
chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === "install") {
        await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, counter: 0 });
    } else if (details.reason === "update") {
        // Merge defaults with existing settings
        const current = await chrome.storage.sync.get(null);
        const merged = { ...DEFAULT_SETTINGS, ...current };
        if (current.counter == null) merged.counter = 0;
        await chrome.storage.sync.set(merged);
    }
});

/* ================================
   Messaging
================================ */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        if (msg?.type === "CATBLOCKER_GET_SETTINGS") {
            const data = await chrome.storage.sync.get(null);
            const settings = { ...DEFAULT_SETTINGS, ...data };
            sendResponse({ ok: true, settings });
        }

        else if (msg?.type === "CATBLOCKER_SET_ENABLED") {
            await chrome.storage.sync.set({ enabled: !!msg.enabled });
            sendResponse({ ok: true });
        }

    })();

    // Required: keep channel open for async
    return true;
});

/* ================================
   Context menu
================================ */
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "catblocker-scan",
        title: "Replace ads with cats on this page",
        contexts: ["action", "page"]
    });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "catblocker-scan" && tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_FORCE_SCAN" }).catch(() => {});
    }
});

/* ================================
   Commands (Keyboard Shortcuts)
================================ */
chrome.commands?.onCommand.addListener(async (command) => {
    if (command !== "replace-now") return;
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
            chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_FORCE_SCAN" }).catch(() => {});
        }
    } catch {
        // ignore
    }
});
