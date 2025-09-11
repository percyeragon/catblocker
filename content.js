// content.js — CatBlocker content script (no imports/exports)
// Relies on globals from common.js: hostnameOf, chooseSelectors, pickCatSrc

/* ================================
   State & constants
================================ */
let settings = { enabled: true, intensity: "aggressive", whitelist: [] };
let observer = null;              // MutationObserver
let io = null;                    // IntersectionObserver for visible candidates
let scanBusy = false;             // simple lock to avoid re-entrance
let pendingNodes = new Set();     // candidates awaiting IO observation
let totalReplaced = 0;

const MAX_PER_PAGE  = 500;        // hard upper bound for replacements per page
const MAX_PER_TICK  = 30;         // how many nodes to process per animation frame
const MIN_WIDTH     = 80;
const MIN_HEIGHT    = 50;

/* ================================
   CSS injection to avoid warnings
================================ */
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

/* ================================
   YouTube helpers & guards
================================ */
function isYouTubeSite() {
    const h = location.hostname.replace(/^www\./, "");
    return h === "youtube.com" || h.endsWith(".youtube.com") || h === "m.youtube.com";
}

// UI areas we must never touch on YT
const YT_UI_BLOCKLIST = [
    "ytd-masthead", "tp-yt-app-header", "#masthead", "#masthead-container",
    "#page-manager", "#content", "#columns",
    "#guide", "ytd-mini-guide-renderer", "#guide-content",
    "ytd-feed-filter-chip-bar-renderer", "#chips",
    "ytd-rich-grid-renderer", "ytd-rich-item-renderer", "ytd-video-renderer",
    "ytd-watch-flexy", "#primary", "#secondary",
    "#player", ".html5-video-player", "#movie_player", "ytd-player",
    "#related", "#comments", "ytd-comments"
];

function isInYouTubeUi(el) {
    if (!isYouTubeSite()) return false;
    return YT_UI_BLOCKLIST.some(sel => !!el.closest(sel));
}

// YT ad renderers (safe to replace/hide)
const YT_AD_SELECTORS = [
    "ytd-ad-slot-renderer",
    "ytd-display-ad-renderer",
    "ytd-in-feed-ad-layout-renderer",
    "ytd-promoted-video-renderer",
    "ytd-promoted-sparkles-web-renderer",
    "ytd-promoted-item-renderer",
    "ytd-ad-inline-playback-renderer",
    "ytd-player-legacy-desktop-watch-ads-renderer",
    // overlays/modules (we hide them, not replace):
    ".video-ads", ".ytp-ad-player-overlay", ".ytp-ad-text",
    ".ytp-ad-overlay-container", ".ytp-ad-image-overlay", ".ytp-ad-module"
];

function isYouTubePlayerSubtree(el) {
    return !!el.closest('#movie_player, .html5-video-player, ytd-player');
}

function isInComments(el) {
    return !!el.closest('#comments, ytd-comments, ytd-comment-thread-renderer, ytd-comment-view-model, ytd-item-section-renderer[section-identifier="comments-entry-point"], .comment, .comments, [role="comments"]');
}

/* ================================
   Init
================================ */
(async function init() {
    try {
        const resp = await chrome.runtime.sendMessage({ type: "CATBLOCKER_GET_SETTINGS" });
        if (resp?.ok && resp.settings) settings = resp.settings;
    } catch {}

    const host = hostnameOf(location.href);
    if (!settings.enabled || (settings.whitelist || []).includes(host)) {
        return; // disabled or whitelisted
    }

    injectCatblockerStylesOnce();
    startReplacement();
})();

/* ================================
   Core wiring
================================ */
function startReplacement() {
    scheduleScan();
    document.addEventListener("DOMContentLoaded", () => scheduleScan(), { once: true });

    observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if ((m.addedNodes && m.addedNodes.length) || m.type === "attributes") {
                scheduleScan();
                break;
            }
        }
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "class", "id", "src", "data-ad", "data-advertisement", "aria-label"]
    });

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type === "CATBLOCKER_FORCE_SCAN") scheduleScan();
    });
}

function scheduleScan() {
    if (scheduleScan._t) cancelAnimationFrame(scheduleScan._t);
    scheduleScan._t = requestAnimationFrame(() => scanAndReplace());
}

/* ================================
   Intersection + batching
================================ */
function ensureIO() {
    if (io) return;
    io = new IntersectionObserver((entries) => {
        const visible = [];
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            io.unobserve(e.target);
            visible.push(e.target);
        }
        if (visible.length) processBatch(visible);
    }, { root: null, rootMargin: "200px 0px", threshold: 0.01 });
}

function processBatch(nodes) {
    if (!nodes || !nodes.length) return;
    const work = [...nodes];

    const step = () => {
        if (!work.length) return;
        const slice = work.splice(0, MAX_PER_TICK);
        Promise.allSettled(slice.map(n => replaceNodeWithCat(n)))
            .then(() => {
                totalReplaced += slice.length;
                chrome.runtime.sendMessage({ type: "CATBLOCKER_ADD_COUNT", amount: slice.length }).catch(()=>{});
                if (totalReplaced >= MAX_PER_PAGE) return;
                if (work.length) requestAnimationFrame(step);
            });
    };
    requestAnimationFrame(step);
}

/* ================================
   Scanning & heuristics
================================ */
async function scanAndReplace() {
    if (scanBusy) return;
    scanBusy = true;
    ensureIO();

    try { detectAndHideInterstitials(); } catch {}

    // --- YOUTUBE FIRST: explicit ad renderers only; never touch UI areas ---
    if (isYouTubeSite()) {
        try {
            // Hide overlays/modules (do not replace to avoid UI flicker)
            document.querySelectorAll(".video-ads, .ytp-ad-player-overlay, .ytp-ad-text, .ytp-ad-overlay-container, .ytp-ad-image-overlay, .ytp-ad-module")
                .forEach(node => { if (!node.__catblockerProcessed) hideNode(node); });

            // Hide skip buttons (optional)
            const skipParent = document.querySelector(".ytp-ad-skip-button-container, .ytp-ad-skip-button, .ytp-ad-skip-button-modern");
            if (skipParent && !skipParent.__catblockerProcessed) hideNode(skipParent);

            // Replace only explicit ad renderers, never core UI
            document.querySelectorAll([
                "ytd-ad-slot-renderer",
                "ytd-display-ad-renderer",
                "ytd-in-feed-ad-layout-renderer",
                "ytd-promoted-video-renderer",
                "ytd-promoted-sparkles-web-renderer",
                "ytd-promoted-item-renderer",
                "ytd-ad-inline-playback-renderer",
                "ytd-player-legacy-desktop-watch-ads-renderer"
            ].join(",")).forEach(el => {
                if (el.__catblockerProcessed) return;
                if (isInYouTubeUi(el)) return;     // safety: never header/player/comments/guide
                markCandidate(el);
            });
        } catch {}
    }

    // 1) iframe-based ads
    try {
        document.querySelectorAll("iframe[src*='ad'], iframe[id*='ad'], iframe[name*='ad']")
            .forEach(el => {
                if (el.__catblockerProcessed) return;
                if (inHeaderArea(el) || inGenericUiArea(el)) return;
                if (isYouTubePlayerSubtree(el)) return;
                if (isInComments(el)) return;
                if (isYouTubeSite() && isInYouTubeUi(el)) return;
                markCandidate(el);
            });
    } catch {}

    // 2) background-image ads (conservative)
    try {
        const bgCandidates = document.querySelectorAll("div, section, aside, a");
        for (const el of bgCandidates) {
            if (el.__catblockerProcessed) continue;
            if (el.closest('.catblocker-container')) continue;
            if (inHeaderArea(el) || inGenericUiArea(el)) continue;
            if (isYouTubePlayerSubtree(el)) continue;
            if (isYouTubeSite() && isInYouTubeUi(el)) continue;

            const cs = getComputedStyle(el);
            const bgImg = cs.backgroundImage || "";
            if (bgImg && bgImg !== 'none') {
                const r = el.getBoundingClientRect();
                if (r.width >= 160 && r.height >= 90) {
                    const hint = bgImg.toLowerCase();
                    if (/(doubleclick|googlesyndication|adservice|adnxs|taboola|outbrain|revcontent|adsystem|adroll|criteo)/.test(hint)) {
                        markCandidate(el);
                    }
                }
            }
        }
    } catch {}

    // 3) sponsored/advert labels → climb to container (not YT UI)
    try {
        const labelCandidates = document.querySelectorAll("*[aria-label], [data-testid], span, div, a");
        labelCandidates.forEach(el => {
            if (el.__catblockerProcessed) return;
            if (inHeaderArea(el) || inGenericUiArea(el)) return;
            if (isInComments(el)) return;
            if (isYouTubeSite() && isInYouTubeUi(el)) return;

            const txt = (el.textContent || "").trim().toLowerCase();
            if (!txt) return;
            if (["sponsored","promoted","anzeige","werbung","ad"].some(w => txt === w || txt.startsWith(w + " "))) {
                const container = el.closest("article, li, ytd-rich-item-renderer, ytd-video-renderer, .feed-item, .card, .result, section, div");
                if (container && !container.__catblockerProcessed && !inHeaderArea(container) && !inGenericUiArea(container)) {
                    if (isYouTubeSite() && isInYouTubeUi(container)) return;
                    markCandidate(container);
                }
            }
        });
    } catch {}

    // 4) generic selectors (from common.js)
    try {
        const selectors = chooseSelectors(settings.intensity);
        if (selectors && selectors.length) {
            document.querySelectorAll(selectors.join(",")).forEach(node => {
                if (node.__catblockerProcessed) return;
                if (node.closest('.catblocker-container')) return;
                if (isYouTubePlayerSubtree(node)) return;
                if (inHeaderArea(node) || inGenericUiArea(node)) return;
                if (isYouTubeSite() && isInYouTubeUi(node)) return;

                const r = node.getBoundingClientRect();
                if (r.width < MIN_WIDTH || r.height < MIN_HEIGHT) return;
                markCandidate(node);
            });
        }
    } catch {}

    // Send candidates to IO (visible-only processing)
    for (const el of pendingNodes) io.observe(el);
    pendingNodes.clear();

    scanBusy = false;
}

function markCandidate(el) {
    if (totalReplaced >= MAX_PER_PAGE) return;
    if (el.__catblockerProcessed) return;
    pendingNodes.add(el);
}

/* ================================
   Replacement
================================ */
async function replaceNodeWithCat(node) {
    try {
        if (node.__catblockerProcessed) return;
        node.__catblockerProcessed = true;

        const catUrl = await pickCatSrc();
        const rect = node.getBoundingClientRect();

        // On YouTube use a slightly larger minimal size to reduce layout jumps
        const minW = isYouTubeSite() ? 200 : 100;
        const minH = isYouTubeSite() ? 120 : 80;

        const w = Math.max(minW, Math.floor(rect.width))  || (isYouTubeSite() ? 300 : 300);
        const h = Math.max(minH, Math.floor(rect.height)) || (isYouTubeSite() ? 180 : 250);

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
            node.replaceWith(container);
        } catch {
            node.innerHTML = "";
            node.appendChild(container);
        }
    } catch {
        // swallow node errors
    }
}

/* ================================
   Generic guards & utilities
================================ */
function inHeaderArea(el) {
    // Avoid replacing site chrome: headers/nav/footers/sidebars
    return !!el.closest("header, nav, footer, [role='banner'], [role='navigation'], [role='contentinfo'], .header, .navbar, .site-header, .site-nav, .footer, .sidebar, [data-testid='TopNavBar']");
}

function inGenericUiArea(el) {
    // Avoid generic shells: app sidebars, toolbars, modals, cookie dialogs
    const generic = !!el.closest(".sidebar, .toolbar, .modal, .dialog, .cookie, .consent, [role='dialog'], [data-testid='sidebar'], [data-testid='toolbar']");
    if (generic) return true;
    // YouTube UI areas off-limits
    if (isYouTubeSite() && isInYouTubeUi(el)) return true;
    return false;
}

function hideNode(node) {
    try {
        node.__catblockerProcessed = true;
        node.style.setProperty("display", "none", "important");
        node.style.setProperty("visibility", "hidden", "important");
        node.style.setProperty("opacity", "0", "important");
    } catch {}
}

/* Hide interstitial overlays/popups that often carry ads (defensive) */
function detectAndHideInterstitials() {
    const candidates = document.querySelectorAll(
        '.ad, .ads, .advert, .advertisement, ' +
        '[aria-modal="true"], [role="dialog"], .modal, .overlay, .interstitial'
    );
    for (const n of candidates) {
        if (n.__catblockerProcessed) continue;
        const r = n.getBoundingClientRect();
        if ((r.width >= 300 && r.height >= 200) || (r.width >= window.innerWidth * 0.6 && r.height >= 200)) {
            const txt = (n.textContent || "").toLowerCase();
            if (/(advert|werbung|anzeige|sponsor|ad\b|ad-|ads)/.test(txt) || (r.width >= window.innerWidth * 0.6)) {
                hideNode(n);
            }
        }
    }
}
