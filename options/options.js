const DEFAULTS = {
    enabled: true,
    intensity: "aggressive",
    whitelist: [],
    customCatUrls: []
};

async function load() {
    const data = await chrome.storage.sync.get(null);
    const s = { ...DEFAULTS, ...data };

    document.getElementById("enabled").checked = !!s.enabled;
    document.getElementById("intensity").value = s.intensity;

    renderList("domainList", s.whitelist, removeDomain);
    renderList("catList", s.customCatUrls, removeCatUrl, true);
}

function renderList(elId, arr, remover, isUrl = false) {
    const el = document.getElementById(elId);
    el.innerHTML = "";
    arr.forEach((item, i) => {
        const li = document.createElement("li");
        const left = document.createElement(isUrl ? "a" : "span");
        if (isUrl) { left.href = item; left.textContent = item; left.target = "_blank"; }
        else { left.textContent = item; }
        const btn = document.createElement("button");
        btn.textContent = "Remove";
        btn.addEventListener("click", () => remover(i));
        li.append(left, btn);
        el.appendChild(li);
    });
}

async function removeDomain(index) {
    const { whitelist = [] } = await chrome.storage.sync.get("whitelist");
    whitelist.splice(index, 1);
    await chrome.storage.sync.set({ whitelist });
    renderList("domainList", whitelist, removeDomain);
}

async function removeCatUrl(index) {
    const { customCatUrls = [] } = await chrome.storage.sync.get("customCatUrls");
    customCatUrls.splice(index, 1);
    await chrome.storage.sync.set({ customCatUrls });
    renderList("catList", customCatUrls, removeCatUrl, true);
}

document.getElementById("addDomain").addEventListener("click", async () => {
    const input = document.getElementById("domainInput");
    const v = input.value.trim().replace(/^https?:\/\//, "").replace(/^www\./, "");
    if (!v) return;
    const { whitelist = [] } = await chrome.storage.sync.get("whitelist");
    if (!whitelist.includes(v)) {
        whitelist.push(v);
        await chrome.storage.sync.set({ whitelist });
        renderList("domainList", whitelist, removeDomain);
    }
    input.value = "";
});

document.getElementById("addCatUrl").addEventListener("click", async () => {
    const input = document.getElementById("catUrl");
    const v = input.value.trim();
    if (!v) return;
    try { new URL(v); } catch { return; }
    const { customCatUrls = [] } = await chrome.storage.sync.get("customCatUrls");
    if (!customCatUrls.includes(v)) {
        customCatUrls.push(v);
        await chrome.storage.sync.set({ customCatUrls });
        renderList("catList", customCatUrls, removeCatUrl, true);
    }
    input.value = "";
});

document.getElementById("save").addEventListener("click", async () => {
    const enabled = document.getElementById("enabled").checked;
    const intensity = document.getElementById("intensity").value;
    await chrome.storage.sync.set({ enabled, intensity });
    const status = document.getElementById("status");
    status.textContent = "Saved ✓";
    setTimeout(() => status.textContent = "", 1500);
});

load();
