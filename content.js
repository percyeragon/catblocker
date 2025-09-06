// content.js
// Replaces detected ad nodes with cat images; observes DOM mutations.

import { chooseSelectors, pickCatSrc, hostnameOf } from "./common.js";

let settings = {
    enabled: true,
    intensity: "aggressive",
    whitelist: []
};

let replacedOnThisPage = 0;
let observer = null;

// Load settings on start
(async function init() {
    try {
        const resp = await chrome.runtime.sendMessage({ type: "CATBLOCKER_GET_SETTINGS" });
        if (resp?.ok && resp.settings) {
            settings = resp.settings;
        }
    } catch {}

    const host = hostnameOf(location.href);
    if (!settings.enabled || settings.whitelist?.includes(host)) {
        return; // do nothing on whitelisted or disabled
    }

    startReplacement();
})();

function startReplacement() {
    // Early scan at document_start and repeat at DOMContentLoaded
    scanAndReplace({ reason: "initial" });
    document.addEventListener("DOMContentLoaded", () => scanAndReplace({ reason: "domcontentloaded" }), { once: true });

    // Observe dynamic changes
    observer = new MutationObserver((mutations) => {
        let shouldRescan = false;
        for (const m of mutations) {
            if (m.addedNodes && m.addedNodes.length) { shouldRescan = true; break; }
            if (m.type === "attributes") { shouldRescan = true; break; }
        }
        if (shouldRescan) {
            // Debounced
            if (scanAndReplace._t) cancelAnimationFrame(scanAndReplace._t);
            scanAndReplace._t = requestAnimationFrame(() => scanAndReplace({ reason: "mutation" }));
        }
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "class", "id", "src", "data-ad", "data-advertisement"]
    });

    // Listen for manual trigger
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type === "CATBLOCKER_FORCE_SCAN") {
            scanAndReplace({ reason: "manual" });
        }
    });
}

function scanAndReplace({ reason }) {
    const selectors = chooseSelectors(settings.intensity);
    let found = 0, replaced = 0;

    try {
        // iframes first: try to neutralize ad iframes (same-origin only for content, otherwise replace node)
        const iframeCandidates = document.querySelectorAll("iframe[src*='ad'], iframe[id*='ad'], iframe[name*='ad']");
        iframeCandidates.forEach(ifr => {
            found++;
            replaceNodeWithCat(ifr);
            replaced++;
        });

        // generic containers
        const nodes = document.querySelectorAll(selectors.join(","));
        nodes.forEach(node => {
            // Skip if already processed
            if (node.__catblockerProcessed) return;

            // Heuristic: visible and bigger than small icon
            const rect = node.getBoundingClientRect();
            if (rect.width < 80 || rect.height < 50) return;

            found++;
            replaceNodeWithCat(node);
            replaced++;
        });

        if (replaced > 0) {
            replacedOnThisPage += replaced;
            chrome.runtime.sendMessage({ type: "CATBLOCKER_ADD_COUNT", amount: replaced }).catch(() => {});
        }
    } catch (e) {
        // noop
    }
}

function replaceNodeWithCat(node) {
    const catUrl = pickCatSrc();

    // Create container preserving size
    const rect = node.getBoundingClientRect();
    const width = Math.max(100, Math.floor(rect.width)) || 300;
    const height = Math.max(80, Math.floor(rect.height)) || 250;

    const container = document.createElement("div");
    container.className = "catblocker-container";
    container.style.cssText = `
    all: initial;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    overflow: hidden !important;
    width: ${width}px !important;
    height: ${height}px !important;
    max-width: 100% !important;
    border-radius: 8px !important;
    background: #0003 !important;
    position: relative !important;
  `;

    const img = document.createElement("img");
    img.src = catUrl;
    img.alt = "Ad replaced by a cat 😺";
    img.style.cssText = `
    all: initial;
    display: block !important;
    width: 100% !important;
    height: 100% !important;
    object-fit: cover !important;
  `;

    const badge = document.createElement("div");
    badge.textContent = "CatBlocker";
    badge.style.cssText = `
    all: initial;
    position: absolute !important;
    right: 6px !important;
    bottom: 6px !important;
    padding: 3px 6px !important;
    font-family: system-ui, sans-serif !important;
    font-size: 10px !important;
    background: #000a !important;
    color: #fff !important;
    border-radius: 6px !important;
  `;

    container.appendChild(img);
    container.appendChild(badge);

    // Replace node
    node.__catblockerProcessed = true;
    try {
        node.replaceWith(container);
    } catch {
        // Fallback if replaceWith not allowed
        node.innerHTML = "";
        node.appendChild(container);
    }
}
