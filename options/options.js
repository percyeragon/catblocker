// options.js — polished options page logic

const DEFAULTS = {
    enabled: true,
    intensity: "balanced",
    whitelist: [],
    customCatUrls: [],
    theme: "light" // 'light' | 'dark' | 'system'
};

function toast(msg){
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 1400);
}
function setStatus(msg){ const s = document.getElementById("status"); s.textContent = msg; setTimeout(()=> s.textContent="", 1600); }

function normalizeDomain(v){
    if (!v) return "";
    v = v.trim();
    v = v.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
    // remove path/query/hash
    const cut = v.split("/")[0].split("?")[0].split("#")[0];
    return cut.toLowerCase();
}
function isValidUrl(str){
    try { new URL(str); return true; } catch { return false; }
}

/* ------------------------------ Rendering ------------------------------ */
function renderWhitelist(list){
    const wrap = document.getElementById("domainChips");
    wrap.innerHTML = "";
    list.forEach((domain, i) => {
        const chip = document.createElement("div");
        chip.className = "chip";
        chip.innerHTML = `<span>${domain}</span>`;
        const btn = document.createElement("button");
        btn.className = "remove";
        btn.title = "Remove";
        btn.textContent = "×";
        btn.addEventListener("click", async () => {
            const data = await chrome.storage.sync.get("whitelist");
            const arr = Array.isArray(data.whitelist) ? data.whitelist : [];
            arr.splice(i, 1);
            await chrome.storage.sync.set({ whitelist: arr });
            renderWhitelist(arr);
            toast("Removed from whitelist");
        });
        chip.appendChild(btn);
        wrap.appendChild(chip);
    });
}

function renderGallery(urls){
    const list = document.getElementById("catList");
    list.innerHTML = "";
    urls.forEach((url, i) => {
        const tile = document.createElement("div");
        tile.className = "tile";
        const thumb = document.createElement("div");
        thumb.className = "thumb";
        const img = document.createElement("img");
        img.loading = "lazy";
        img.src = url;
        img.alt = "Cat image";
        img.onerror = () => { img.style.opacity = ".3"; img.title = "Failed to load"; };
        thumb.appendChild(img);

        const urlEl = document.createElement("div");
        urlEl.className = "url";
        urlEl.textContent = url;

        const row = document.createElement("div");
        row.className = "row";
        const openBtn = document.createElement("a");
        openBtn.className = "btn subtle";
        openBtn.textContent = "Open";
        openBtn.href = url;
        openBtn.target = "_blank";
        const removeBtn = document.createElement("button");
        removeBtn.className = "btn";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", async () => {
            const data = await chrome.storage.sync.get("customCatUrls");
            const arr = Array.isArray(data.customCatUrls) ? data.customCatUrls : [];
            arr.splice(i, 1);
            await chrome.storage.sync.set({ customCatUrls: arr });
            renderGallery(arr);
            toast("Removed URL");
        });

        row.append(openBtn, removeBtn);
        tile.append(thumb, urlEl, row);
        list.appendChild(tile);
    });
}

/* ------------------------------ Load & Bind ------------------------------ */
async function load(){
    const data = await chrome.storage.sync.get(null);
    const s = { ...DEFAULTS, ...data };

    // Theme
    applyTheme(s.theme);
    const dm = document.getElementById("darkMode");
    if (dm) dm.checked = s.theme === "dark";

    // Toggle + Intensity
    document.getElementById("enabled").checked = !!s.enabled;
    document.getElementById("intensity").value = s.intensity || "balanced";
    syncSeg(s.intensity || "balanced");

    renderWhitelist(s.whitelist || []);
    renderGallery(s.customCatUrls || []);
}

function syncSeg(value){
    document.querySelectorAll(".segmented .seg").forEach(btn => {
        const selected = btn.dataset.value === value;
        btn.setAttribute("aria-selected", String(selected));
    });
    const sel = document.getElementById("intensity");
    if (sel) sel.value = value;
}

/* ------------------------------ Events ------------------------------ */
function bind(){
    // Back link
    document.getElementById("backToPopup").addEventListener("click", (e) => {
        e.preventDefault();
        // Opens the popup UI (best-effort)
        chrome.action.openPopup?.();
    });

    // Enabled toggle
    document.getElementById("enabled").addEventListener("change", async (e) => {
        await chrome.storage.sync.set({ enabled: e.target.checked });
        setStatus("Saved ✓");
    });

    // Dark mode toggle (overrides system pref when ON)
    const dm = document.getElementById("darkMode");
    dm?.addEventListener("change", async (e) => {
        const theme = e.target.checked ? "dark" : "light";
        await chrome.storage.sync.set({ theme });
        applyTheme(theme);
        setStatus("Theme saved ✓");
    });

    // Intensity segmented + hidden select
    document.querySelectorAll(".segmented .seg").forEach(btn => {
        btn.addEventListener("click", async () => {
            const v = btn.dataset.value;
            syncSeg(v);
            await chrome.storage.sync.set({ intensity: v });
            setStatus("Saved ✓");
        });
    });
    document.getElementById("intensity").addEventListener("change", async (e) => {
        syncSeg(e.target.value);
        await chrome.storage.sync.set({ intensity: e.target.value });
        setStatus("Saved ✓");
    });

    // Add domain
    document.getElementById("addDomain").addEventListener("click", addDomain);
    document.getElementById("domainInput").addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); addDomain(); }
    });

    // Clear whitelist
    document.getElementById("clearWhitelist").addEventListener("click", async () => {
        await chrome.storage.sync.set({ whitelist: [] });
        renderWhitelist([]);
        toast("Whitelist cleared");
    });

    // Add cat URL
    document.getElementById("addCatUrl").addEventListener("click", addCatUrl);
    document.getElementById("catUrl").addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); addCatUrl(); }
    });

    // Clear custom URLs
    document.getElementById("clearCatUrls").addEventListener("click", async () => {
        await chrome.storage.sync.set({ customCatUrls: [] });
        renderGallery([]);
        toast("Custom URLs cleared");
    });

    // Export / Import / Reset
    document.getElementById("exportSettings").addEventListener("click", exportSettings);
    document.getElementById("importFile").addEventListener("change", importSettings);
    document.getElementById("resetDefaults").addEventListener("click", resetDefaults);
}

async function addDomain(){
    const input = document.getElementById("domainInput");
    let v = normalizeDomain(input.value);
    if (!v) { toast("Enter a domain"); return; }

    const data = await chrome.storage.sync.get("whitelist");
    const list = Array.isArray(data.whitelist) ? data.whitelist : [];
    if (!list.includes(v)) list.push(v);
    await chrome.storage.sync.set({ whitelist: list });
    renderWhitelist(list);
    input.value = "";
    toast("Added to whitelist");
}

async function addCatUrl(){
    const input = document.getElementById("catUrl");
    const v = input.value.trim();
    if (!v || !isValidUrl(v)) { toast("Enter a valid URL"); return; }

    const data = await chrome.storage.sync.get("customCatUrls");
    const list = Array.isArray(data.customCatUrls) ? data.customCatUrls : [];
    if (!list.includes(v)) list.push(v);
    await chrome.storage.sync.set({ customCatUrls: list });
    renderGallery(list);
    input.value = "";
    toast("URL added");
}

async function exportSettings(){
    const data = await chrome.storage.sync.get(null);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "catblocker-settings.json";
    a.click();
    URL.revokeObjectURL(url);
    toast("Settings exported");
}

async function importSettings(e){
    const file = e.target.files?.[0];
    if (!file) return;
    try{
        const text = await file.text();
        const obj = JSON.parse(text);
        // keep only known keys
        const next = {
            enabled: typeof obj.enabled === "boolean" ? obj.enabled : DEFAULTS.enabled,
            intensity: ["gentle","balanced","aggressive"].includes(obj.intensity) ? obj.intensity : DEFAULTS.intensity,
            whitelist: Array.isArray(obj.whitelist) ? obj.whitelist.map(normalizeDomain).filter(Boolean) : DEFAULTS.whitelist,
            customCatUrls: Array.isArray(obj.customCatUrls) ? obj.customCatUrls.filter(isValidUrl) : DEFAULTS.customCatUrls,
            theme: ["light","dark","system"].includes(obj.theme) ? obj.theme : DEFAULTS.theme
        };
        await chrome.storage.sync.set(next);
        await load();
        toast("Settings imported");
    } catch {
        toast("Invalid settings file");
    } finally {
        e.target.value = "";
    }
}

async function resetDefaults(){
    await chrome.storage.sync.set({ ...DEFAULTS });
    await load();
    toast("Reset to defaults");
}

function applyTheme(theme){
    const root = document.documentElement;
    if (theme === "dark") root.setAttribute("data-theme", "dark");
    else if (theme === "light") root.setAttribute("data-theme", "light");
    else root.removeAttribute("data-theme"); // system
}

document.addEventListener("DOMContentLoaded", () => { bind(); load(); });
