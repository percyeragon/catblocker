// content.js — CatBlocker content script
// Uses globals from common.js (no imports/exports).

let settings = { enabled: true, intensity: "aggressive", whitelist: [] };
let observer = null;
let replacedOnThisPage = 0;

/* ---------------------------------------------------------
   Injects CSS rules once to avoid overflow warnings
--------------------------------------------------------- */
function injectCatblockerStylesOnce() {
    if (document.getElementById("catblocker-style")) return;
    const style = document.createElement("style");
    style.id = "catblocker-style";
    style.textContent = `
    /* Opt-out of View Transitions for our nodes */
    .catblocker-container, .catblocker-container * {
      view-transition-name: none !important;
    }

    /* Ensure media never paint outside their box */
    .catblocker-container img,
    .catblocker-container video,
    .catblocker-container canvas {
      display: block !important;
      width: 100% !important;
      height: 100% !important;
      object-fit: cover !important;
      overflow: clip !important;
      overflow-clip-margin: content-box;
      contain: paint;
    }

    .catblocker-container {
      contain: layout paint style !important;
      isolation: isolate !important;
      will-change: contents;
    }
  `;
    document.documentElement.appendChild(style);
}

/* ---------------------------------------------------------
   Initialization
--------------------------------------------------------- */
(async function init() {
    try {
        const resp = await chrome.runtime.sendMessage({ type: "CATBLOCKER_GET_SETTINGS" });
        if (resp?.ok && resp.settings) settings = resp.settings;
    } catch {}

    const host = hostnameOf(location.href);
    if (!settings.enabled || (settings.whitelist || []).includes(host)) {
        return; // disabled or whitelisted
    }

    startReplacement();
})();

/* ---------------------------------------------------------
   Start replacement logic
--------------------------------------------------------- */
function startReplacement() {
    injectCatblockerStylesOnce();

    // First scans
    scanAndReplace();
    document.addEventListener("DOMContentLoaded", () => scanAndReplace(), { once: true });

    // YouTube SPA navigations: hook into YT custom events when present
    window.addEventListener('yt-navigate-finish', () => scanAndReplace());
    window.addEventListener('yt-page-data-updated', () => scanAndReplace());

    // Observe DOM mutations
    observer = new MutationObserver(() => {
        if (scanAndReplace._t) cancelAnimationFrame(scanAndReplace._t);
        scanAndReplace._t = requestAnimationFrame(() => scanAndReplace());
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "class", "id", "src", "data-ad", "data-advertisement", "aria-label", "role", "data-testid"]
    });

    // Manual trigger from popup/context menu
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type === "CATBLOCKER_FORCE_SCAN") scanAndReplace();
    });
}

/* ---------------------------------------------------------
   Scan & Replace
--------------------------------------------------------- */
async function scanAndReplace() {
    const selectors = chooseSelectors(settings.intensity);
    const tasks = [];

    // Heuristic: detect blocks labeled 'Sponsored'/'Anzeige' and replace their nearest container
    try {
        const labelCandidates = Array.from(document.querySelectorAll("*[aria-label], [data-testid], span, div, a"));
        labelCandidates.forEach(el => {
            if (el.__catblockerProcessed) return;
            const txt = (el.textContent || "").trim().toLowerCase();
            if (!txt) return;
            if (["sponsored","promoted","anzeige","werbung","ad"].some(w => txt === w || txt.startsWith(w+" "))) {
                const container = el.closest("article, li, ytd-rich-item-renderer, ytd-video-renderer, .feed-item, .card, .result, section, div");
                if (container && !container.__catblockerProcessed) {
                    tasks.push(replaceNodeWithCat(container));
                }
            }
        });
    } catch {}

    // Replace ad iframes
    document.querySelectorAll("iframe[src*='ad'], iframe[id*='ad'], iframe[name*='ad']")
        .forEach(el => tasks.push(replaceNodeWithCat(el)));

    // YouTube specific: overlay and in-feed ads
    try {
        // In-feed and sidebar ad renderers
        document.querySelectorAll("ytd-ad-slot-renderer, ytd-action-companion-ad-renderer, ytd-display-ad-renderer, ytd-promoted-sparkles-web-renderer, ytd-in-feed-ad-layout-renderer, ytd-promoted-video-renderer").forEach(node => {
            if (!node.__catblockerProcessed) tasks.push(replaceNodeWithCat(node));
        });
        // Video ad containers and overlays in the player
        document.querySelectorAll(".video-ads, .ytp-ad-player-overlay, .ytp-ad-text, .ytp-ad-overlay-container, .ytp-ad-image-overlay, .ytp-ad-module").forEach(node => {
            if (!node.__catblockerProcessed) tasks.push(replaceNodeWithCat(node));
        });
        // Ad countdown and skip button areas sometimes isolated
        const skipParent = document.querySelector('.ytp-ad-skip-button-container, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
        if (skipParent && !skipParent.__catblockerProcessed) tasks.push(replaceNodeWithCat(skipParent));
    } catch {}

    // Replace ad containers
    document.querySelectorAll(selectors.join(",")).forEach(node => {
        if (node.__catblockerProcessed) return;
        if (node.closest('.catblocker-container')) return;
        const r = node.getBoundingClientRect();
        if (r.width < 80 || r.height < 50) return; // skip tiny
        tasks.push(replaceNodeWithCat(node));
    });

    const count = tasks.length;
    if (!count) return;

    await Promise.allSettled(tasks);
    replacedOnThisPage += count;

    chrome.runtime.sendMessage({ type: "CATBLOCKER_ADD_COUNT", amount: count }).catch(() => {});
}

/* ---------------------------------------------------------
   Replace node with cat container
--------------------------------------------------------- */
async function replaceNodeWithCat(node) {
    node.__catblockerProcessed = true;

    const catUrl = await pickCatSrc();
    const rect = node.getBoundingClientRect();
    const w = Math.max(100, Math.floor(rect.width)) || 300;
    const h = Math.max(80, Math.floor(rect.height)) || 250;

    const container = document.createElement("div");
    container.className = "catblocker-container";
    container.style.cssText = `
    all: initial;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    overflow: hidden !important;
    width: ${w}px !important;
    height: ${h}px !important;
    max-width: 100% !important;
    border-radius: 8px !important;
    background: #0003 !important;
    position: relative !important;
  `;

    const img = document.createElement("img");
    img.src = catUrl;
    img.alt = "Ad replaced by a cat 😺";

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

    container.append(img, badge);

    try {
        // Preserve layout by copying computed min sizes if present
        const cs = getComputedStyle(node);
        if (cs.minWidth && cs.minWidth !== "auto") container.style.minWidth = cs.minWidth;
        if (cs.minHeight && cs.minHeight !== "auto") container.style.minHeight = cs.minHeight;
        node.replaceWith(container);
    } catch {
        node.innerHTML = "";
        node.appendChild(container);
    }
}
