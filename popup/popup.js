// popup.js — enhanced UI wiring while keeping existing IDs

function toast(msg){
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 1400);
}

async function getSettings(){
    const resp = await chrome.runtime.sendMessage({ type: "CATBLOCKER_GET_SETTINGS" }).catch(() => null);
    return resp?.settings || {};
}
function getHostname(url){ try{ return new URL(url).hostname.replace(/^www\./,""); }catch{ return ""; } }

function syncIntensitySeg(value){
    // Update segmented control state and hidden <select>
    document.querySelectorAll(".segmented .seg").forEach(btn => {
        const selected = btn.dataset.value === value;
        btn.setAttribute("aria-selected", String(selected));
    });
    const sel = document.getElementById("intensity");
    if (sel) sel.value = value;
}

async function init(){
    const settings = await getSettings();

    const toggle = document.getElementById("toggleEnabled");
    const enabledLabel = document.getElementById("enabledLabel");
    const sessionCount = document.getElementById("sessionCount");
    const globalCount = document.getElementById("globalCount");
    const replaceNow = document.getElementById("replaceNow");
    const openOptions = document.getElementById("openOptions");
    const hostnameEl = document.getElementById("hostname");
    const toggleWhitelist = document.getElementById("toggleWhitelist");

    // Intensity segmented
    const segButtons = Array.from(document.querySelectorAll(".segmented .seg"));
    const initialIntensity = settings.intensity || "balanced";
    syncIntensitySeg(initialIntensity);

    toggle.checked = !!settings.enabled;
    enabledLabel.textContent = settings.enabled ? "Enabled" : "Disabled";
    enabledLabel.classList.toggle("badge", true);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const hostname = getHostname(tab?.url || "");
    hostnameEl.value = hostname;

    // Counters
    const data = await chrome.storage.sync.get(["counter"]);
    globalCount.textContent = data.counter || 0;

    // Ping content script for quick rescan (also makes the session number meaningful)
    sessionCount.textContent = "—";
    try{
        await chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_FORCE_SCAN" });
        sessionCount.textContent = "↻";
    }catch{
        sessionCount.textContent = "0";
    }

    // Whitelist chip state
    const wl = new Set((settings.whitelist || []));
    toggleWhitelist.classList.toggle("active", wl.has(hostname));
    toggleWhitelist.textContent = wl.has(hostname) ? "Whitelisted" : "Whitelist";

    // Events
    toggle.addEventListener("change", async () => {
        const enabled = toggle.checked;
        enabledLabel.textContent = enabled ? "Enabled" : "Disabled";
        await chrome.runtime.sendMessage({ type: "CATBLOCKER_SET_ENABLED", enabled });
        toast(enabled ? "Enabled" : "Disabled");
        if (enabled && tab?.id){
            chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_FORCE_SCAN" }).catch(()=>{});
        }
    });

    segButtons.forEach(btn => {
        btn.addEventListener("click", async () => {
            const v = btn.dataset.value;
            syncIntensitySeg(v);
            await chrome.storage.sync.set({ intensity: v });
            toast(`Intensity: ${v}`);
            if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_FORCE_SCAN" }).catch(()=>{});
        });
    });

    // Keep hidden select in sync (fallback for keyboard/screen readers)
    const intensitySelect = document.getElementById("intensity");
    intensitySelect.addEventListener("change", async () => {
        syncIntensitySeg(intensitySelect.value);
        await chrome.storage.sync.set({ intensity: intensitySelect.value });
        if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_FORCE_SCAN" }).catch(()=>{});
    });

    replaceNow.addEventListener("click", async () => {
        if (tab?.id){
            await chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_FORCE_SCAN" }).catch(()=>{});
            toast("Scan triggered");
        }
    });

    openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());

    toggleWhitelist.addEventListener("click", async () => {
        const { whitelist = [] } = await chrome.storage.sync.get("whitelist");
        const set = new Set(whitelist);
        if (set.has(hostname)) set.delete(hostname); else set.add(hostname);
        await chrome.storage.sync.set({ whitelist: Array.from(set) });

        const active = set.has(hostname);
        toggleWhitelist.classList.toggle("active", active);
        toggleWhitelist.textContent = active ? "Whitelisted" : "Whitelist";
        toast(active ? "Domain whitelisted" : "Domain removed");
    });
}

init();
