// service_worker.js
// Handles context menu, dynamic rules (optional), and message hub.

const DEFAULT_SETTINGS = {
    enabled: true,
    intensity: "aggressive", // 'gentle' | 'balanced' | 'aggressive'
    whitelist: [],           // hostnames to skip
    counter: 0,              // global replaced count
    theme: "light"         // 'light' | 'dark' | 'system'
};

chrome.runtime.onInstalled.addListener(async () => {
    // Initialize defaults if not set
    const current = await chrome.storage.sync.get(null);
    if (!current || Object.keys(current).length === 0) {
        await chrome.storage.sync.set(DEFAULT_SETTINGS);
    }

    // Create context menu
    chrome.contextMenus.create({
        id: "replace-ads-now",
        title: "CatBlocker: Replace ads on this page",
        contexts: ["action", "page"]
    });

    // Optional: preload a small baseline set of DNR rules (empty here; keep permission for future)
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "replace-ads-now" && tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_FORCE_SCAN" }).catch(() => {});
    }
});

// Message bridge (e.g., for counter updates)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        if (msg?.type === "CATBLOCKER_ADD_COUNT") {
            const { amount = 1 } = msg;
            const data = await chrome.storage.sync.get(["counter"]);
            const counter = (data.counter || 0) + amount;
            await chrome.storage.sync.set({ counter });
            sendResponse({ ok: true, counter });
        } else if (msg?.type === "CATBLOCKER_GET_SETTINGS") {
            const data = await chrome.storage.sync.get(null);
            sendResponse({ ok: true, settings: { ...DEFAULT_SETTINGS, ...data } });
        } else if (msg?.type === "CATBLOCKER_SET_ENABLED") {
            await chrome.storage.sync.set({ enabled: !!msg.enabled });
            sendResponse({ ok: true });
        } else {
            sendResponse({ ok: false });
        }
    })();
    return true; // async
});
