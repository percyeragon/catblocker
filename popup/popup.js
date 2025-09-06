// popup.js
async function getSettings() {
    const resp = await chrome.runtime.sendMessage({ type: "CATBLOCKER_GET_SETTINGS" }).catch(() => null);
    return resp?.settings || {};
}

function getHostname(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

async function init() {
    const settings = await getSettings();

    const toggle = document.getElementById("toggleEnabled");
    const enabledLabel = document.getElementById("enabledLabel");
    const intensity = document.getElementById("intensity");
    const sessionCount = document.getElementById("sessionCount");
    const globalCount = document.getElementById("globalCount");
    const replaceNow = document.getElementById("replaceNow");
    const openOptions = document.getElementById("openOptions");
    const hostnameEl = document.getElementById("hostname");
    const toggleWhitelist = document.getElementById("toggleWhitelist");

    toggle.checked = !!settings.enabled;
    enabledLabel.textContent = settings.enabled ? "Enabled" : "Disabled";
    intensity.value = settings.intensity || "aggressive";

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const hostname = getHostname(tab?.url || "");
    hostnameEl.value = hostname;

    // load global counter
    const data = await chrome.storage.sync.get(["counter"]);
    globalCount.textContent = data.counter || 0;

    // session count (ask content script if present)
    sessionCount.textContent = "—";
    try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_FORCE_SCAN" });
        // We don't track session per tab here; leave as trigger-based
        sessionCount.textContent = "↻";
    } catch {
        sessionCount.textContent = "0";
    }

    toggle.addEventListener("change", async () => {
        const enabled = toggle.checked;
        enabledLabel.textContent = enabled ? "Enabled" : "Disabled";
        await chrome.runtime.sendMessage({ type: "CATBLOCKER_SET_ENABLED", enabled });
        // Optionally re-scan
        if (enabled && tab?.id) chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_FORCE_SCAN" }).catch(() => {});
    });

    intensity.addEventListener("change", async () => {
        await chrome.storage.sync.set({ intensity: intensity.value });
        if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_FORCE_SCAN" }).catch(() => {});
    });

    replaceNow.addEventListener("click", async () => {
        if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_FORCE_SCAN" }).catch(() => {});
    });

    openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());

    toggleWhitelist.addEventListener("click", async () => {
        const s = await getSettings();
        const wl = new Set(s.whitelist || []);
        if (wl.has(hostname)) wl.delete(hostname); else wl.add(hostname);
        await chrome.storage.sync.set({ whitelist: Array.from(wl) });
        toggleWhitelist.textContent = wl.has(hostname) ? "Whitelisted" : "Whitelist domain";
    });

    // Button label state
    const s2 = await getSettings();
    const wl2 = new Set(s2.whitelist || []);
    toggleWhitelist.textContent = wl2.has(hostname) ? "Whitelisted" : "Whitelist domain";
}

init();
