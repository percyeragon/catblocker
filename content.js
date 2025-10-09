// content.js — CatBlocker content script (no imports/exports)
// Requires common.js to be loaded first (globals: hostnameOf, chooseSelectors, pickCatSrc,
// buildDomainRegexFromSettings, buildIframeSelectorFromSettings)

/* ================================
   State & constants
================================ */
let settings = {
    enabled: true,
    intensity: "aggressive",
    whitelist: [],
    cmpBypassSourcepoint: true,
    customBlocklistDomains: []
};

let observer = null;              // MutationObserver for DOM changes
let io = null;                    // IntersectionObserver for visible candidates
let scanBusy = false;             // simple re-entrancy guard
let pendingNodes = new Set();     // candidates waiting for IO
let totalReplaced = 0;

const MAX_PER_PAGE  = 500;        // safety upper bound (avoid over-replacing)
const MAX_PER_TICK  = 30;         // batch size per frame
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
    } catch { return Promise.resolve(); }
}

/* ================================
   Helpers (safe observe, DOM ready)
================================ */
function isNode(x) { return !!(x && typeof x === "object" && typeof x.nodeType === "number"); }
function safeObserve(mo, target, options) { if (mo && isNode(target)) { try { mo.observe(target, options); } catch {} } }
function onReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
    else fn();
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
   CSS for our own containers (warnings/overflow)
================================ */
function injectCatblockerStylesOnce() {
    if (document.getElementById("catblocker-style")) return;
    const style = document.createElement("style");
    style.id = "catblocker-style";
    style.textContent = `
    /* Isolate our replacements from View Transitions & overflow issues */
    .catblocker-container, .catblocker-container * { view-transition-name: none !important; }
    .catblocker-container img, .catblocker-container video, .catblocker-container canvas {
      display: block !important; width: 100% !important; height: 100% !important;
      object-fit: cover !important; overflow: clip !important; overflow-clip-margin: content-box; contain: paint;
    }
    .catblocker-container { contain: layout paint style !important; isolation: isolate !important; will-change: contents; }
  `;
    document.documentElement.appendChild(style);
}

/* ================================
   YouTube guards
================================ */
function isYouTubeSite() {
    const h = location.hostname.replace(/^www\./, "");
    return h === "youtube.com" || h.endsWith(".youtube.com") || h === "m.youtube.com";
}
const YT_UI_BLOCKLIST = [
    "ytd-masthead","tp-yt-app-header","#masthead","#masthead-container",
    "#page-manager","#content","#columns",
    "#guide","ytd-mini-guide-renderer","#guide-content",
    "ytd-feed-filter-chip-bar-renderer","#chips",
    "ytd-rich-grid-renderer","ytd-rich-item-renderer","ytd-video-renderer",
    "ytd-watch-flexy","#primary","#secondary",
    "#player",".html5-video-player","#movie_player","ytd-player",
    "#related","#comments","ytd-comments"
];
function isInYouTubeUi(el){ return isYouTubeSite() && YT_UI_BLOCKLIST.some(sel => !!el.closest(sel)); }
function isYouTubePlayerSubtree(el){ return !!el.closest('#movie_player, .html5-video-player, ytd-player'); }
function isInComments(el){ return !!el.closest('#comments, ytd-comments, ytd-comment-thread-renderer, ytd-comment-view-model, ytd-item-section-renderer[section-identifier="comments-entry-point"], .comment, .comments, [role="comments"]'); }

/* ================================
   Interstitial heuristics
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
   CMP / Sourcepoint soft bypass
================================ */
function isSourcepointNode(el) {
    if (!el) return false;
    const id = (typeof el.id === "string") ? el.id : (el.id?.baseVal || "");  // <-- Fix hier
    if (id && (id.startsWith("sp_message_container_") || id.startsWith("sp_message_iframe_") || id === "sp_veil")) return true;

    if (el.classList && (el.classList.contains("sp_veil") || el.classList.contains("sp_message") || el.classList.contains("sp_message_container"))) return true;

    const src = (el.tagName === "IFRAME") ? (el.getAttribute("src") || "") : "";
    return /sourcepoint\./i.test(src);
}

function neutralizeSourcepointNode(el) {
    try {
        el.__catblockerProcessed = true;
        el.setAttribute("aria-hidden", "true");
        el.removeAttribute("aria-modal");
        // soft: make it non-interactive and (practically) invisible without display:none:
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

    safeObserve(mo, document.documentElement, {
        subtree: true, childList: true, attributes: true,
        attributeFilter: ["id","class","style","aria-modal","aria-hidden"]
    });
}

/* ================================
   Neutralize ONLY ad-iframe interstitials
================================ */
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

function detectAndHideInterstitials(DOMAIN_RE, adIframeSelector) {
    if (window.__CATBLOCKER_SAFE_MODE__) return;

    const candidates = Array.from(document.querySelectorAll(
        `[role="dialog"], [aria-modal="true"], .modal, .overlay, .interstitial, .popup, .lightbox, .backdrop, .modal-backdrop`
    ));

    let touched = 0;

    for (const el of candidates) {
        if (el.__catblockerProcessed) continue;
        if (!isLikelyInterstitial(el)) continue;

        // If this interstitial itself (or its iframe) is ad-related → neutralize
        const hasAdIframe = !!el.querySelector(adIframeSelector);
        const text = (el.textContent || "").toLowerCase();
        const isConsentText = /\bcookie|consent|preferences|privacy|gdpr\b/i.test(text);

        if (hasAdIframe && !isConsentText) {
            neutralizeOverlay(el);
            touched++;
            continue;
        }

        // Sourcepoint-specific containers (soft bypass already handles most)
        if (settings.cmpBypassSourcepoint && isSourcepointNode(el)) {
            neutralizeSourcepointNode(el);
            touched++;
        }
    }

    if (touched > 0 && !window.__CATBLOCKER_SAFE_MODE__) startUnlockDaemon(4000);
}

/* ================================
   Targeted Unlock (preserve scroll)
================================ */
let unlockTimer = null;
let unblockerActive = false;
const SCROLL_KEYS = new Set(["ArrowUp","ArrowDown","PageUp","PageDown","Home","End","Space"," "]);

// Merke, welche Container wir wirklich verändert haben, um sie später sauber zurückzusetzen
let _unlockTouched = [];

function getCandidateScrollContainers() {
    // häufige App-Wrapper + Dokument
    const list = [
        document.scrollingElement || document.documentElement,
        document.body,
        ...document.querySelectorAll("main, #app, #root, #page, #content, #container, #wrap, #wrapper, #__next, [data-scroll-lock], [data-scroll-blocked]")
    ];
    // eindeutige Elements (ohne null/undefined)
    return Array.from(new Set(list.filter(Boolean)));
}

function captureScrollPos() {
    const docEl = document.scrollingElement || document.documentElement;
    return {
        winX: window.scrollX,
        winY: window.scrollY,
        perEl: getCandidateScrollContainers().map(el => ({ el, x: el.scrollLeft, y: el.scrollTop }))
    };
}

function restoreScrollPos(state) {
    if (!state) return;
    // erst Elemente, dann Fenster (rahmen rAF, damit Layout stabil ist)
    for (const it of state.perEl) {
        try { it.el.scrollLeft = it.x; it.el.scrollTop = it.y; } catch {}
    }
    requestAnimationFrame(() => { window.scrollTo(state.winX, state.winY); });
}

function applyTargetedUnlock() {
    const touched = [];
    const cands = getCandidateScrollContainers();

    for (const el of cands) {
        try {
            const cs = getComputedStyle(el);
            // nur anfassen, wenn wirklich blockiert
            if (cs.overflowY === "hidden" || cs.overflowY === "clip" || cs.touchAction === "none") {
                const prev = {
                    el,
                    style: {
                        overflowY: el.style.overflowY,
                        overscrollBehavior: el.style.overscrollBehavior,
                        touchAction: el.style.touchAction
                    }
                };
                el.style.setProperty("overflow-y", "auto", "important");
                el.style.setProperty("overscroll-behavior", "auto", "important");
                el.style.setProperty("touch-action", "auto", "important");
                touched.push(prev);
            }
        } catch {}
    }
    _unlockTouched = touched;
}

function revertTargetedUnlock() {
    for (const t of _unlockTouched) {
        try {
            t.el.style.overflowY = t.style.overflowY || "";
            t.el.style.overscrollBehavior = t.style.overscrollBehavior || "";
            t.el.style.touchAction = t.style.touchAction || "";
        } catch {}
    }
    _unlockTouched = [];
}

function addScrollCaptureUnblockers() {
    if (unblockerActive) return;
    unblockerActive = true;
    const allowScroll = (e) => { e.stopImmediatePropagation(); };
    const allowKeyScroll = (e) => { if (SCROLL_KEYS.has(e.key)) e.stopImmediatePropagation(); };
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
    const snapshot = captureScrollPos();
    applyTargetedUnlock();
    addScrollCaptureUnblockers();
    // Nach dem Stilwechsel die Scrollpos sofort wiederherstellen
    requestAnimationFrame(() => restoreScrollPos(snapshot));
    unlockTimer = setTimeout(stopUnlockDaemon, durationMs);
}

function stopUnlockDaemon() {
    if (unlockTimer) { clearTimeout(unlockTimer); unlockTimer = null; }
    removeScrollCaptureUnblockers();
    revertTargetedUnlock();
}


/* ================================
   Init
================================ */
(async function init() {
    // Loop guard (enable safe-mode if too many loads)
    const hits = loopGuardArm();
    if (hits > 3) window.__CATBLOCKER_SAFE_MODE__ = true;

    try {
        const resp = await safeSendMessage({ type: "CATBLOCKER_GET_SETTINGS" });
        if (resp?.ok && resp.settings) settings = { ...settings, ...resp.settings };
    } catch {}

    const host = hostnameOf(location.href);
    if (!settings.enabled || (settings.whitelist || []).includes(host)) return;

    injectCatblockerStylesOnce();
    setupSourcepointBypass();
    startReplacement();
})();

/* ================================
   Core wiring (scan + observe)
================================ */
function startReplacement() {
    scheduleScan();
    document.addEventListener("DOMContentLoaded", () => scheduleScan(), { once: true });

    observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if ((m.addedNodes && m.addedNodes.length) || m.type === "attributes") { scheduleScan(); break; }
        }
    });

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

/* Throttled scheduling (avoid scan storms) */
let lastScanAt = 0;
function scheduleScan() {
    const now = performance.now();
    if (now - lastScanAt < 250) {
        if (scheduleScan._t) cancelAnimationFrame(scheduleScan._t);
        scheduleScan._t = requestAnimationFrame(scheduleScan);
        return;
    }
    lastScanAt = now;
    if (scheduleScan._t) cancelAnimationFrame(scheduleScan._t);
    scheduleScan._t = requestAnimationFrame(scanAndReplace);
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
        Promise.allSettled(slice.map(n => replaceNodeWithCat(n))).then(() => {
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

    // Build dynamic domain tools from settings (provided by common.js)
    const DOMAIN_RE = (typeof buildDomainRegexFromSettings === "function")
        ? buildDomainRegexFromSettings(settings)
        : /(doubleclick|googlesyndication|adservice|adnxs|taboola|outbrain|revcontent|adsystem|adroll|criteo)/i;

    const adIframeSelector = (typeof buildIframeSelectorFromSettings === "function")
        ? buildIframeSelectorFromSettings(settings)
        : [
            `iframe[src*="doubleclick"]`,
            `iframe[src*="googlesyndication"]`,
            `iframe[src*="adservice"]`,
            `iframe[src*="adnxs"]`,
            `iframe[src*="taboola"]`,
            `iframe[src*="outbrain"]`,
            `iframe[src*="revcontent"]`,
            `iframe[src*="criteo"]`,
            `iframe[src*="adroll"]`,
            `iframe[id*="ad"]`,
            `iframe[name*="ad"]`
        ].join(",");

    try { detectAndHideInterstitials(DOMAIN_RE, adIframeSelector); } catch {}

    // YOUTUBE: only explicit ad renderers; never core UI
    if (isYouTubeSite()) {
        try {
            document.querySelectorAll(".video-ads, .ytp-ad-player-overlay, .ytp-ad-text, .ytp-ad-overlay-container, .ytp-ad-image-overlay, .ytp-ad-module")
                .forEach(node => { if (!node.__catblockerProcessed) hideNode(node); });
            const skipParent = document.querySelector(".ytp-ad-skip-button-container, .ytp-ad-skip-button, .ytp-ad-skip-button-modern");
            if (skipParent && !skipParent.__catblockerProcessed) hideNode(skipParent);

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
                if (isInYouTubeUi(el)) return;
                if (isLikelyInterstitial(el)) { neutralizeOverlay(el); return; }
                markCandidate(el);
            });
        } catch {}
    }

    // 1) iframe-based ads (dynamic selector)
    try {
        document.querySelectorAll(adIframeSelector).forEach(el => {
            if (el.__catblockerProcessed) return;
            if (inHeaderArea(el) || inGenericUiArea(el)) return;
            if (isYouTubePlayerSubtree(el)) return;
            if (isInComments(el)) return;
            if (isYouTubeSite() && isInYouTubeUi(el)) return;
            if (isLikelyInterstitial(el)) { neutralizeOverlay(el); return; }
            markCandidate(el);
        });
    } catch {}

    // 2) background-image ads (use DOMAIN_RE)
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
                    if (DOMAIN_RE.test(hint)) {
                        if (isLikelyInterstitial(el)) { neutralizeOverlay(el); continue; }
                        markCandidate(el);
                    }
                }
            }
        }
    } catch {}

    // 3) sponsored / advert labels → replace container (not YT UI/core)
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

    // 4) generic selectors (from settings intensity)
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

    // 5) video-based ads (video/source tags)
    try {
        const videos = document.querySelectorAll('video, source');
        for (const el of videos) {
            if (el.__catblockerProcessed) continue;
            if (isYouTubeSite() && isInYouTubeUi(el)) continue;

            // prefer attribute over property for <source>
            const src = (el.getAttribute('src') || el.src || '').toLowerCase();

            // Heuristics: ad-host OR common ad keywords in URL (vast, preroll, adserver, ads, doubleclick)
            if (src && (DOMAIN_RE.test(src) || /(?:^|[/?&._-])(vast|preroll|adserver|ads?|doubleclick)(?:[/?&._-]|$)/i.test(src))) {
                // Option A: neutralisieren (Standard – verhindert UI-Jumps/Scroll-Blocks)
                neutralizeOverlay(el);

                // Option B: stattdessen durch Katze ersetzen → die nächste Zeile aktivieren
                // markCandidate(el);
            } else {
                // Manche Player füttern Ads via blob: oder MSE – erkenne typische Hinweis-Attribute
                const cls = (el.className || "").toLowerCase();
                const ds = (el.dataset || {});
                const hintText = (el.closest('[data-ad],[data-advertisement],[data-preroll],[data-vast],[data-ads]') || null);

                if (/(?:^|\\b)(ad|preroll|vast)(?:\\b|_|-)/i.test(cls) ||
                    ds.ad === "true" || ds.ads === "true" || ds.preroll === "true" || ds.vast === "true" || hintText) {
                    if (isLikelyInterstitial(el)) {
                        neutralizeOverlay(el);
                    } else {
                        // siehe Option A/B oben
                        neutralizeOverlay(el);
                        // markCandidate(el);
                    }
                }
            }
        }
    } catch {}

    // 2.5) winzige Tracking-Pixel (<img>)
    try {
        const tinyImgs = document.querySelectorAll("img[src]");
        for (const img of tinyImgs) {
            if (img.__catblockerProcessed) continue;
            const w = (img.width || img.naturalWidth || 0);
            const h = (img.height || img.naturalHeight || 0);
            const src = (img.getAttribute("src") || "").toLowerCase();
            if ((w <= 2 && h <= 2) && (DOMAIN_RE.test(src) || /pixel|beacon|track|deep_pixel/.test(src))) {
                hideNode(img); // nicht ersetzen, nur unsichtbar machen
            }
        }
    } catch {}


    // send candidates to IO (visible-only processing)
    for (const el of pendingNodes) io.observe(el);
    pendingNodes.clear();

    if (!alive) { scanBusy = false; return; }
    scanBusy = false;
}

/* ================================
   Mark candidate for replacement
================================ */
function markCandidate(el) {
    if (totalReplaced >= MAX_PER_PAGE) return;
    if (el.__catblockerProcessed) return;
    pendingNodes.add(el);
}

/* ================================
   Replacement: replace node with cat
================================ */
async function replaceNodeWithCat(node, opts = {}) {
    const force = true;
    try {
        if (!alive || node.__catblockerProcessed) return;

        // never replace interstitials (we neutralize instead)
        if (!force && isLikelyInterstitial(node)) {
            neutralizeOverlay(node);
            if (!window.__CATBLOCKER_SAFE_MODE__) startUnlockDaemon(3000);
            return;
        }

        node.__catblockerProcessed = true;

        let catUrl = "";
        try { catUrl = await pickCatSrc(); } catch { return; }
        if (!alive) return;

        const rect = node.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;

        // extra guard: if gigantic, neutralize instead of replacing
        if (!force && (rect.width > vw * 0.8 || rect.height > vh * 0.7)) {
            neutralizeOverlay(node);
            if (!window.__CATBLOCKER_SAFE_MODE__) startUnlockDaemon(3000);
            return;
        }

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

        try { node.replaceWith(container); }
        catch { node.innerHTML = ""; node.appendChild(container); }

        if (!window.__CATBLOCKER_SAFE_MODE__) startUnlockDaemon(3000);
    } catch { /* swallow node errors */ }
}

/* ================================
   Generic guards
================================ */
function inHeaderArea(el) {
    return !!el.closest("header, nav, footer, [role='banner'], [role='navigation'], [role='contentinfo'], .header, .navbar, .site-header, .site-nav, .footer, .sidebar, [data-testid='TopNavBar']");
}
function inGenericUiArea(el) {
    if (!!el.closest(".sidebar, .toolbar, .modal, .dialog, .cookie, .consent, [role='dialog'], [data-testid='sidebar'], [data-testid='toolbar']")) return true;
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
