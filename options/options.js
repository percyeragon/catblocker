// options.js — CatBlocker Options wired to settings object

// DEFAULT_SETTINGS kommt aus common.js (global)

function toast(msg){
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 1400);
}
function setStatus(msg){
    const s = document.getElementById("status");
    s.textContent = msg;
    setTimeout(()=> s.textContent="", 1600);
}

function normalizeDomain(v){
    if (!v) return "";
    v = v.trim();
    v = v.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
    return v.split(/[\/?#]/)[0].toLowerCase();
}

async function getSettings(){
    return new Promise((resolve) => {
        chrome.storage.sync.get({ settings: DEFAULT_SETTINGS }, ({ settings }) => {
            resolve({ ...DEFAULT_SETTINGS, ...(settings || {}) });
        });
    });
}
async function setSettings(patch){
    const cur = await getSettings();
    const next = { ...cur, ...patch };
    return new Promise((resolve)=>chrome.storage.sync.set({ settings: next }, resolve));
}

function renderChips(containerId, list, onRemove){
    const wrap = document.getElementById(containerId);
    wrap.innerHTML = "";
    list.forEach((item, i) => {
        const chip = document.createElement("div");
        chip.className = "chip";
        chip.innerHTML = `<span>${item}</span>`;
        const btn = document.createElement("button");
        btn.className = "remove";
        btn.title = "Remove";
        btn.textContent = "×";
        btn.addEventListener("click", () => onRemove(i));
        chip.appendChild(btn);
        wrap.appendChild(chip);
    });
}


function syncSeg(value){
    document.querySelectorAll(".segmented .seg").forEach(btn => {
        const selected = btn.dataset.value === value;
        btn.setAttribute("aria-selected", String(selected));
    });
    const sel = document.getElementById("intensity");
    if (sel) sel.value = value;
}

function applyTheme(theme){
    const root = document.documentElement;
    if (theme === "dark") root.setAttribute("data-theme", "dark");
    else if (theme === "light") root.setAttribute("data-theme", "light");
    else root.removeAttribute("data-theme"); // system
}

/* ------------------------------ Storage helpers ------------------------------ */
/* ------------------------------ Load & Bind ------------------------------ */
async function load(){
    const s = await getSettings();

    // Theme
    applyTheme(s.theme || "light");
    const dm = document.getElementById("darkMode");
    if (dm) dm.checked = (s.theme || "light") === "dark";

    // Enabled + Intensity
    document.getElementById("enabled").checked = !!s.enabled;
    syncSeg(s.intensity || "balanced");

    // Categories
    const cats = s.categories || DEFAULT_SETTINGS.categories;
    document.getElementById("cat-ads").checked = !!cats.ads;
    document.getElementById("cat-analytics").checked = !!cats.analytics;
    document.getElementById("cat-social").checked = !!cats.social;
    document.getElementById("cat-error").checked = !!cats.errorTrackers;
    document.getElementById("cat-oems").checked = !!cats.oems;
    document.getElementById("cat-mix").checked = !!cats.mix;

    // Custom ad domains
    renderChips("customDomainChips", s.customBlocklistDomains || [], async (idx) => {
        const cur = await getSettings();
        const list = [...(cur.customBlocklistDomains || [])];
        list.splice(idx, 1);
        await setSettings({ customBlocklistDomains: list });
        renderChips("customDomainChips", list, arguments.callee);
        toast("Removed domain");
    });

    // Whitelist
    renderChips("domainChips", s.whitelist || [], async (idx) => {
        const cur = await getSettings();
        const list = [...(cur.whitelist || [])];
        list.splice(idx, 1);
        await setSettings({ whitelist: list });
        renderChips("domainChips", list, arguments.callee);
        toast("Removed from whitelist");
    });

    // Overrides
    renderChips("allowChips", s.allowDomains || [], async (idx) => {
        const cur = await getSettings();
        const list = [...(cur.allowDomains || [])];
        list.splice(idx, 1);
        await setSettings({ allowDomains: list });
        renderChips("allowChips", list, arguments.callee);
        toast("Removed allow");
    });
    renderChips("blockChips", s.blockDomains || [], async (idx) => {
        const cur = await getSettings();
        const list = [...(cur.blockDomains || [])];
        list.splice(idx, 1);
        await setSettings({ blockDomains: list });
        renderChips("blockChips", list, arguments.callee);
        toast("Removed block");
    });

}

function bind(){
    // Back link
    document.getElementById("backToPopup").addEventListener("click", (e) => {
        e.preventDefault();
        chrome.action.openPopup?.();
    });

    // Enabled toggle
    document.getElementById("enabled").addEventListener("change", async (e) => {
        await setSettings({ enabled: e.target.checked });
        setStatus("Saved ✓");
    });

    // Dark mode toggle
    const dm = document.getElementById("darkMode");
    dm?.addEventListener("change", async (e) => {
        const theme = e.target.checked ? "dark" : "light";
        await setSettings({ theme });
        applyTheme(theme);
        setStatus("Theme saved ✓");
    });

    // Intensity segmented + hidden select
    document.querySelectorAll(".segmented .seg").forEach(btn => {
        btn.addEventListener("click", async () => {
            const v = btn.dataset.value;
            syncSeg(v);
            await setSettings({ intensity: v });
            setStatus("Saved ✓");
        });
    });
    document.getElementById("intensity").addEventListener("change", async (e) => {
        const v = e.target.value;
        syncSeg(v);
        await setSettings({ intensity: v });
        setStatus("Saved ✓");
    });

    // Add allow
    document.getElementById("addAllow").addEventListener("click", async () => {
        const input = document.getElementById("allowInput");
        const v = normalizeDomain(input.value);
        if (!v) { toast("Enter a domain"); return; }
        const s = await getSettings();
        const set = new Set([...(s.allowDomains || [])]);
        set.add(v);
        const list = [...set];
        await setSettings({ allowDomains: list });
        renderChips("allowChips", list, async (idx) => {
            const cur = await getSettings();
            const l2 = [...(cur.allowDomains || [])];
            l2.splice(idx, 1);
            await setSettings({ allowDomains: l2 });
            renderChips("allowChips", l2, arguments.callee);
            toast("Removed allow");
        });
        input.value = "";
        toast("Added allow");
    });

// Add block
    document.getElementById("addBlock").addEventListener("click", async () => {
        const input = document.getElementById("blockInput");
        const v = normalizeDomain(input.value);
        if (!v) { toast("Enter a domain"); return; }
        const s = await getSettings();
        // Wenn Domain in allow existiert, entfernen wir sie – Allow gewinnt sonst sowieso
        const allow = new Set([...(s.allowDomains || [])]);
        allow.delete(v);
        const block = new Set([...(s.blockDomains || [])]);
        block.add(v);
        const next = { allowDomains: [...allow], blockDomains: [...block] };
        await setSettings(next);
        renderChips("allowChips", next.allowDomains, async (idx) => {
            const cur = await getSettings();
            const l2 = [...(cur.allowDomains || [])];
            l2.splice(idx, 1);
            await setSettings({ allowDomains: l2 });
            renderChips("allowChips", l2, arguments.callee);
            toast("Removed allow");
        });
        renderChips("blockChips", next.blockDomains, async (idx) => {
            const cur = await getSettings();
            const l2 = [...(cur.blockDomains || [])];
            l2.splice(idx, 1);
            await setSettings({ blockDomains: l2 });
            renderChips("blockChips", l2, arguments.callee);
            toast("Removed block");
        });
        input.value = "";
        toast("Added block");
    });

// Clear
    document.getElementById("clearAllow").addEventListener("click", async () => {
        await setSettings({ allowDomains: [] });
        renderChips("allowChips", [], () => {});
        toast("Allow list cleared");
    });
    document.getElementById("clearBlock").addEventListener("click", async () => {
        await setSettings({ blockDomains: [] });
        renderChips("blockChips", [], () => {});
        toast("Block list cleared");
    });


    // Categories
    const catIds = [
        ["cat-ads","ads"],
        ["cat-analytics","analytics"],
        ["cat-social","social"],
        ["cat-error","errorTrackers"],
        ["cat-oems","oems"],
        ["cat-mix","mix"]
    ];
    catIds.forEach(([id, key]) => {
        document.getElementById(id).addEventListener("change", async (e) => {
            const s = await getSettings();
            const cats = { ...(s.categories || DEFAULT_SETTINGS.categories), [key]: e.target.checked };
            await setSettings({ categories: cats });
            setStatus("Saved ✓"); // service_worker reagiert via storage.onChanged → DNR-Update
        });
    });

    // Add custom domain
    document.getElementById("addCustomDomain").addEventListener("click", async () => {
        const input = document.getElementById("customDomainInput");
        const v = normalizeDomain(input.value);
        if (!v) { toast("Enter a domain"); return; }
        const s = await getSettings();
        const set = new Set([...(s.customBlocklistDomains || [])]);
        set.add(v);
        const list = [...set];
        await setSettings({ customBlocklistDomains: list });
        renderChips("customDomainChips", list, async (idx) => {
            const cur = await getSettings();
            const l2 = [...(cur.customBlocklistDomains || [])];
            l2.splice(idx, 1);
            await setSettings({ customBlocklistDomains: l2 });
            renderChips("customDomainChips", l2, arguments.callee);
            toast("Removed domain");
        });
        input.value = "";
        toast("Added domain");
    });

    // Clear custom domains
    document.getElementById("clearCustomDomains").addEventListener("click", async () => {
        await setSettings({ customBlocklistDomains: [] });
        renderChips("customDomainChips", [], () => {});
        toast("Custom domains cleared");
    });

    // Add whitelist domain
    document.getElementById("addDomain").addEventListener("click", async () => {
        const input = document.getElementById("domainInput");
        const v = normalizeDomain(input.value);
        if (!v) { toast("Enter a domain"); return; }
        const s = await getSettings();
        const set = new Set([...(s.whitelist || [])]);
        set.add(v);
        const list = [...set];
        await setSettings({ whitelist: list });
        renderChips("domainChips", list, async (idx) => {
            const cur = await getSettings();
            const l2 = [...(cur.whitelist || [])];
            l2.splice(idx, 1);
            await setSettings({ whitelist: l2 });
            renderChips("domainChips", l2, arguments.callee);
            toast("Removed from whitelist");
        });
        input.value = "";
        toast("Added to whitelist");
    });

    // Clear whitelist
    document.getElementById("clearWhitelist").addEventListener("click", async () => {
        await setSettings({ whitelist: [] });
        renderChips("domainChips", [], () => {});
        toast("Whitelist cleared");
    });

    // Export / Import / Reset
    document.getElementById("exportSettings").addEventListener("click", async () => {
        const settings = await getSettings();
        const blob = new Blob([JSON.stringify({ settings }, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "catblocker-settings.json";
        a.click();
        URL.revokeObjectURL(url);
        toast("Settings exported");
    });

    document.getElementById("importFile").addEventListener("change", async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try{
            const text = await file.text();
            const obj = JSON.parse(text);
            // Accept either {settings:{...}} or a flat payload resembling DEFAULT_SETTINGS
            const src = obj.settings ? obj.settings : obj;
            const next = {
                ...DEFAULT_SETTINGS,
                ...src,
                // sanitize collections
                whitelist: Array.isArray(src.whitelist) ? src.whitelist.map(normalizeDomain).filter(Boolean) : [],
                customBlocklistDomains: Array.isArray(src.customBlocklistDomains) ? src.customBlocklistDomains.map(normalizeDomain).filter(Boolean) : [],
                categories: { ...DEFAULT_SETTINGS.categories, ...(src.categories || {}) },
                intensity: ["gentle","balanced","aggressive"].includes(src.intensity) ? src.intensity : DEFAULT_SETTINGS.intensity,
                enabled: typeof src.enabled === "boolean" ? src.enabled : DEFAULT_SETTINGS.enabled,
                theme: ["light","dark","system"].includes(src.theme) ? src.theme : (src.theme ? src.theme : "light")
            };
            await setSettings(next);
            await load();
            toast("Settings imported");
        } catch {
            toast("Invalid settings file");
        } finally {
            e.target.value = "";
        }
    });

    document.getElementById("resetDefaults").addEventListener("click", async () => {
        await new Promise((resolve)=>chrome.storage.sync.set({ settings: DEFAULT_SETTINGS }, resolve));
        await load();
        toast("Reset to defaults");
    });
}

document.addEventListener("DOMContentLoaded", () => { bind(); load(); });
