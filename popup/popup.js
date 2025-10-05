// popup.js — fixed to use unified {settings} and worker messages

function toast(msg){
    const t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 1400);
}

async function getSettings(){
    try {
        const resp = await chrome.runtime.sendMessage({ type: "CATBLOCKER_GET_SETTINGS" });
        return resp?.settings || {};
    } catch { return {}; }
}

async function setSettings(patch){
    // patch is a partial { ... } merged into settings in the SW
    try {
        await chrome.runtime.sendMessage({ type: "CATBLOCKER_SET_SETTINGS", patch });
    } catch {}
}

function getHostname(url){
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch { return ""; }
}

function syncIntensitySeg(value){
    document.querySelectorAll(".segmented .seg").forEach(btn => {
        const sel = btn.dataset.value === value;
        btn.setAttribute("aria-selected", String(sel));
        btn.classList.toggle("active", sel);
    });
    const sel = document.getElementById("intensity");
    if (sel) sel.value = value;
}

function applyTheme(theme){
    const root = document.documentElement;
    if (theme === "dark") root.setAttribute("data-theme", "dark");
    else if (theme === "light") root.setAttribute("data-theme", "light");
    else root.removeAttribute("data-theme");
}

function setHostnameEl(hostname){
    const el = document.getElementById("hostname");
    if (!el) return;
    // funktioniert für <span>, <div>, <input>
    if ("value" in el) el.value = hostname;
    el.textContent = hostname;
}

async function init(){
    const settings = await getSettings();
    applyTheme(settings.theme);

    const toggle = document.getElementById("toggleEnabled");
    const enabledLabel = document.getElementById("enabledLabel");
    const sessionCountEl = document.getElementById("sessionCount");
    const globalCountEl = document.getElementById("globalCount");
    const replaceNow = document.getElementById("replaceNow");
    const openOptions = document.getElementById("openOptions");
    const toggleWhitelist = document.getElementById("toggleWhitelist");

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const hostname = getHostname(tab?.url || "");
    setHostnameEl(hostname);

    // Status
    toggle.checked = !!settings.enabled;
    enabledLabel.textContent = settings.enabled ? "Enabled" : "Disabled";
    enabledLabel.classList.toggle("badge", true);

    // Intensity
    const currentIntensity = settings.intensity || "balanced";
    syncIntensitySeg(currentIntensity);

    // --- COUNTS: über Service Worker abfragen (statt storage.sync) ---
    async function refreshCounts(){
        try {
            const resp = await chrome.runtime.sendMessage({
                type: "CATBLOCKER_GET_COUNTS",
                tabId: tab?.id
            });
            const sessionVal = Number(resp?.session ?? 0) || 0;
            const globalVal  = Number(resp?.global  ?? 0) || 0;
            if (sessionCountEl) sessionCountEl.textContent = String(sessionVal);
            if (globalCountEl)  globalCountEl.textContent  = String(globalVal);
        } catch {
            if (sessionCountEl) sessionCountEl.textContent = "0";
            if (globalCountEl)  globalCountEl.textContent  = "0";
        }
    }
    await refreshCounts();
    const countsTimer = setInterval(refreshCounts, 800);
    window.addEventListener("unload", () => clearInterval(countsTimer));
    // ---------------------------------------------------------------

    // Whitelist chip state
    const wl = new Set(settings.whitelist || []);
    const isWhitelisted = wl.has(hostname);
    toggleWhitelist.classList.toggle("active", isWhitelisted);
    toggleWhitelist.textContent = isWhitelisted ? "Whitelisted" : "Whitelist";

    // Events
    toggle.addEventListener("change", async () => {
        const enabled = toggle.checked;
        enabledLabel.textContent = enabled ? "Enabled" : "Disabled";
        await setSettings({ enabled });
        toast(enabled ? "Enabled" : "Disabled");
        if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_FORCE_SCAN" }).catch(()=>{});
        refreshCounts();
    });

    document.querySelectorAll(".segmented .seg").forEach(btn => {
        btn.addEventListener("click", async () => {
            const v = btn.dataset.value;
            syncIntensitySeg(v);
            await setSettings({ intensity: v });
            toast(`Intensity: ${v}`);
            if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_FORCE_SCAN" }).catch(()=>{});
            refreshCounts();
        });
    });

    // Hidden select for a11y
    const intensitySelect = document.getElementById("intensity");
    if (intensitySelect) {
        intensitySelect.addEventListener("change", async () => {
            const v = intensitySelect.value;
            syncIntensitySeg(v);
            await setSettings({ intensity: v });
            if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_FORCE_SCAN" }).catch(()=>{});
            refreshCounts();
        });
    }

    replaceNow.addEventListener("click", async () => {
        if (tab?.id) {
            await chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_FORCE_SCAN" }).catch(()=>{});
            toast("Scan triggered");
            refreshCounts();
        }
    });

    openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());

    toggleWhitelist.addEventListener("click", async () => {
        const cur = await getSettings();
        const set = new Set(cur.whitelist || []);
        const active = set.has(hostname);
        if (active) set.delete(hostname); else set.add(hostname);

        await setSettings({ whitelist: Array.from(set) });

        const nowActive = set.has(hostname);
        toggleWhitelist.classList.toggle("active", nowActive);
        toggleWhitelist.textContent = nowActive ? "Whitelisted" : "Whitelist";
        toast(nowActive ? "Domain whitelisted" : "Domain removed");

        // optional: sofortiger Rescan
        if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_FORCE_SCAN" }).catch(()=>{});
        refreshCounts();
    });
}

init();
