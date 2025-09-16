// content.js — CatBlocker content script (no imports/exports)
// Relies on globals from common.js: hostnameOf, chooseSelectors, pickCatSrc

/* ================================
   State & constants
================================ */
let settings = { enabled: true, intensity: "aggressive", whitelist: [], cmpBypassSourcepoint: true };
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
   Lifecycle & safe messaging
================================ */
let alive = true;

function teardown() {
    alive = false;
    try { observer && observer.disconnect(); } catch {}
    try { io && io.disconnect && io.disconnect(); } catch {}
    try { pendingNodes && pendingNodes.clear && pendingNodes.clear(); } catch {}
}

addEventListener("pagehide", teardown, { once: true });
addEventListener("beforeunload", teardown, { once: true });
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "unloaded") teardown();
});

function safeSendMessage(msg) {
    try {
        if (!alive || !chrome?.runtime?.id) return Promise.resolve();
        return chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
        return Promise.resolve();
    }
}

/* ================================
   Safe observer helpers
================================ */
function isNode(x) {
    return !!(x && typeof x === "object" && typeof x.nodeType === "number");
}
function safeObserve(mo, target, options) {
    if (mo && isNode(target)) {
        try { mo.observe(target, options); } catch {}
    }
}
function onReady(fn) {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
        fn();
    }
}

/* ================================
   Loop-Guard (avoid reload ping-pong)
================================ */
function loopGuardArm(originKey = location.origin) {
    try {
        const key = "__catblocker_loopguard__" + originKey;
        const now = Date.now();
        const raw = sessionStorage.getItem(key);
        let bucket = raw ? JSON.parse(raw) : { count: 0, ts: now };
        if (now - bucket.ts > 30000) bucket = { count: 0, ts: now }; // 30s window
        bucket.count++;
        sessionStorage.setItem(key, JSON.stringify(bucket));
        return bucket.count;
    } catch { return 1; }
}

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

function isYouTubePlayerSubtree(el) {
    return !!el.closest('#movie_player, .html5-video-player, ytd-player');
}

function isInComments(el) {
    return !!el.closest('#comments, ytd-comments, ytd-comment-thread-renderer, ytd-comment-view-model, ytd-item-section-renderer[section-identifier="comments-entry-point"], .comment, .comments, [role="comments"]');
}

/* ================================
   Interstitial heuristics & helpers
================================ */
function isLikelyInterstitial(el) {
    try {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const fixedish = cs.position === "fixed" || cs.position === "sticky" || cs.position === "absolute";
        const big = (r.width >= window.innerWidth * 0.5 && r.height >= window.innerHeight * 0.4) || (r.width >= 320 && r.height >= 200);
        return fixedish && big;
    } catch { return false; }
}

/* ================================
   CMP / Sourcepoint soft bypass (optional)
================================ */
function isSourcepointNode(el) {
    if (!el) return false;
    if (el.id && (el.id.startsWith("sp_message_container_") || el.id.startsWith("sp_message_iframe_") || el.id === "sp_veil")) return true;
    if (el.classList && (el.classList.contains("sp_veil") || el.classList.contains("sp_message") || el.classList.contains("sp_message_container"))) return true;
    const src = (el.tagName === "IFRAME") ? (el.getAttribute("src") || "") : "";
    return /sourcepoint\./i.test(src);
}

function neutralizeSourcepointNode(el) {
    try {
        el.__catblockerProcessed = true;
        el.setAttribute("aria-hidden", "true");
        el.removeAttribute("aria-modal");
        // weich: durchklickbar & unsichtbar, aber kein display:none (vermeidet Reload-Triggers)
        el.style.setProperty("pointer-events", "none", "important");
        el.style.setProperty("opacity", "0.001", "important");
        el.style.setProperty("visibility", "hidden", "important");
        el.style.setProperty("z-index", "-1", "important");
    } catch {}
}

function setupSourcepointBypass() {
    if (!settings.cmpBypassSourcepoint) return;

    const neutralizeAll = (root) => {
        root.querySelectorAll?.(
            '[id^="sp_message_container_"], [id^="sp_message_iframe_"], #sp_veil, .sp_veil, .sp_message, .sp_message_container'
        ).forEach(el => { if (!el.__catblockerProcessed) neutralizeSourcepointNode(el); });
    };

    neutralizeAll(document);

    const mo = new MutationObserver((muts) => {
        for (const m of muts) {
            m.addedNodes && m.addedNodes.forEach(n => {
                if (!(n instanceof Element)) return;
                if (isSourcepointNode(n)) neutralizeSourcepointNode(n);
                neutralizeAll(n);
            });
            if (m.type === "attributes" && m.target instanceof Element && isSourcepointNode(m.target)) {
                neutralizeSourcepointNode(m.target);
            }
        }
    });

    // Beobachte nur documentElement (stabil), nicht dauernd html/body Styles
    safeObserve(mo, document.documentElement, {
        subtree: true, childList: true, attributes: true,
        attributeFilter: ["id","class","style","aria-modal","aria-hidden"]
    });
}

/* ================================
   Neutralize ONLY ad-iframe interstitials
================================ */
function detectAndHideInterstitials() {
    if (window.__CATBLOCKER_SAFE_MODE__) return;

    const candidates = Array.from(document.querySelectorAll(
        `[role="dialog"], [aria-modal="true"], .modal, .overlay, .interstitial, .popup, .lightbox, .backdrop, .modal-backdrop`
    ));

    const adIframeSelector =
        `iframe[src*="doubleclick"],` +
        `iframe[src*="googlesyndication"],` +
        `iframe[src*="adservice"],` +
        `iframe[src*="adnxs"],` +
        `iframe[src*="taboola"],` +
        `iframe[src*="outbrain"],` +
        `iframe[src*="revcontent"],` +
        `iframe[src*="criteo"],` +
        `iframe[src*="adroll"],` +
        `iframe[id*="ad"], iframe[name*="ad"]`;

    let touched = 0;

    for (const el of candidates) {
        if (el.__catblockerProcessed) continue;

        // Sourcepoint explizit weich neutralisieren
        if (settings.cmpBypassSourcepoint && (isSourcepointNode(el) || el.querySelector?.(adIframeSelector))) {
            if (!/\bcookie|consent|privacy|gdpr\b/i.test((el.textContent || "").toLowerCase())) {
                // Nur echte Werbe-Interstitials; Consent kann man optional auslassen
                if (isLikelyInterstitial(el)) { neutralizeOverlay(el); touched++; }
            }
            continue;
        }

        if (!isLikelyInterstitial(el)) continue;
        const adIframe = el.querySelector(adIframeSelector);
        if (!adIframe) continue;

        const txt = (el.textContent || "").toLowerCase();
        if (/\bcookie|consent|preferences|privacy|gdpr\b/i.test(txt)) continue;

        neutralizeOverlay(el);
        touched++;
    }

    if (touched > 0) {
        // Sanfter CSS-only Unlock (kein Klassenstrippen)
        if (!window.__CATBLOCKER_SAFE_MODE__) startUnlockDaemon(4000);
    }
}

function neutralizeOverlay(node) {
    try {
        node.__catblockerProcessed = true;
        node.setAttribute("inert", "");
        node.setAttribute("aria-hidden", "true");
        node.removeAttribute("aria-modal");
        node.style.setProperty("pointer-events", "none", "important");
        node.style.setProperty("opacity", "0", "important");
        node.style.setProperty("visibility", "hidden", "important");
        node.style.setProperty("z-index", "-1", "important");
    } catch {}
}

/* ================================
   Unlock Daemon — CSS-only + optional capture-unblocker
================================ */
let unlockCssActive = false;
let unlockTimer = null;
let unblockerActive = false;
const SCROLL_KEYS = new Set(["ArrowUp","ArrowDown","PageUp","PageDown","Home","End","Space"," "]);

function injectUnlockStyles() {
    if (unlockCssActive) return;
    unlockCssActive = true;
    const style = document.createElement("style");
    style.id = "catblocker-unlock-style";
    style.textContent = `
    html { scrollbar-gutter: stable both-edges; }
    html, body {
      overflow-y: auto !important;
      overscroll-behavior: auto !important;
      touch-action: auto !important;
    }
    main, #app, #root, #page, #content, #container, #wrap, #wrapper, #__next,
    [data-scroll-lock], [data-scroll-blocked] {
      overflow-y: auto !important;
      overscroll-behavior: auto !important;
      touch-action: auto !important;
    }
  `;
    document.documentElement.appendChild(style);
}

function removeUnlockStyles() {
    const s = document.getElementById("catblocker-unlock-style");
    if (s) s.remove();
    unlockCssActive = false;
}

function addScrollCaptureUnblockers() {
    if (unblockerActive) return;
    unblockerActive = true;

    const allowScroll = (e) => { e.stopImmediatePropagation(); };
    const allowKeyScroll = (e) => {
        if (!SCROLL_KEYS.has(e.key)) return;
        e.stopImmediatePropagation();
    };

    window.addEventListener("wheel", allowScroll, { capture: true, passive: false });
    window.addEventListener("touchmove", allowScroll, { capture: true, passive: false });
    window.addEventListener("keydown", allowKeyScroll, { capture: true });

    addScrollCaptureUnblockers._handlers = { allowScroll, allowKeyScroll };
}

function removeScrollCaptureUnblockers() {
    if (!unblockerActive) return;
    unblockerActive = false;
    const h = addScrollCaptureUnblockers._handlers || {};
    try {
        window.removeEventListener("wheel", h.allowScroll, { capture: true });
        window.removeEventListener("touchmove", h.allowScroll, { capture: true });
        window.removeEventListener("keydown", h.allowKeyScroll, { capture: true });
    } catch {}
}

function startUnlockDaemon(durationMs = 4000) {
    stopUnlockDaemon();
    injectUnlockStyles();
    addScrollCaptureUnblockers();
    unlockTimer = setTimeout(stopUnlockDaemon, durationMs);
}

function stopUnlockDaemon() {
    if (unlockTimer) { clearTimeout(unlockTimer); unlockTimer = null; }
    removeUnlockStyles();
    removeScrollCaptureUnblockers();
}

/* ================================
   Init
================================ */
(async function init() {
    // Loop guard (safe mode if too many loads)
    const hits = loopGuardArm();
    if (hits > 3) {
        window.__CATBLOCKER_SAFE_MODE__ = true;
    }

    try {
        const resp = await safeSendMessage({ type: "CATBLOCKER_GET_SETTINGS" });
        if (resp?.ok && resp.settings) settings = { ...settings, ...resp.settings };
    } catch {}

    const host = hostnameOf(location.href);
    if (!settings.enabled || (settings.whitelist || []).includes(host)) {
        return; // disabled or whitelisted
    }

    injectCatblockerStylesOnce();
    setupSourcepointBypass();
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

    // documentElement exists immediately → safe
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "class", "id", "src", "data-ad", "data-advertisement", "aria-label"]
    });

    chrome.runtime.onMessage.addListener((msg) => {
        if (!alive) return;
        if (msg?.type === "CATBLOCKER_FORCE_SCAN") scheduleScan();
    });
}

/* Throttled scheduling to avoid scan storms */
let lastScanAt = 0;
function scheduleScan() {
    const now = performance.now();
    if (now - lastScanAt < 250) { // min 250ms spacing
        if (scheduleScan._t) cancelAnimationFrame(scheduleScan._t);
        scheduleScan._t = requestAnimationFrame(() => scheduleScan());
        return;
    }
    lastScanAt = now;
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
    if (!nodes || !nodes.length || !alive) return;
    const work = [...nodes];

    const step = () => {
        if (!alive || !work.length) return;
        const slice = work.splice(0, MAX_PER_TICK);
        Promise.allSettled(slice.map(n => replaceNodeWithCat(n)))
            .then(() => {
                totalReplaced += slice.length;
                safeSendMessage({ type: "CATBLOCKER_ADD_COUNT", amount: slice.length });
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
    if (!alive) { scanBusy = false; return; }
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
                if (isInYouTubeUi(el)) return;     // never header/player/comments/guide
                if (isLikelyInterstitial(el)) { neutralizeOverlay(el); return; }
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
                if (isLikelyInterstitial(el)) { neutralizeOverlay(el); return; }
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
                        if (isLikelyInterstitial(el)) { neutralizeOverlay(el); continue; }
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
                    if (isLikelyInterstitial(container)) { neutralizeOverlay(container); return; }
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
                if (isLikelyInterstitial(node)) { neutralizeOverlay(node); return; }
                markCandidate(node);
            });
        }
    } catch {}

    // Send candidates to IO (visible-only processing)
    for (const el of pendingNodes) io.observe(el);
    pendingNodes.clear();

    if (!alive) { scanBusy = false; return; }
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
        if (!alive || node.__catblockerProcessed) return;

        // Failsafe: Interstitials niemals durch Katze ersetzen
        if (isLikelyInterstitial(node)) { neutralizeOverlay(node); if (!window.__CATBLOCKER_SAFE_MODE__) startUnlockDaemon(3000); return; }

        node.__catblockerProcessed = true;

        let catUrl = "";
        try {
            catUrl = await pickCatSrc();
        } catch { return; }
        if (!alive) return;

        const rect = node.getBoundingClientRect();

        // Extra failsafe: wenn sehr groß, nicht ersetzen
        const vw = window.innerWidth, vh = window.innerHeight;
        if (rect.width > vw * 0.8 || rect.height > vh * 0.7) {
            neutralizeOverlay(node);
            if (!window.__CATBLOCKER_SAFE_MODE__) startUnlockDaemon(3000);
            return;
        }

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

        if (!window.__CATBLOCKER_SAFE_MODE__) startUnlockDaemon(3000);
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
