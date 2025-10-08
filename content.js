// content.js — CatBlocker content script (no imports/exports)

/* ================================
   State & constants
================================ */
let settings = {
    enabled: true,
    intensity: "aggressive",
    whitelist: [],
    // WICHTIG: Banner in Ruhe lassen
    cmpBypassSourcepoint: false,
    customBlocklistDomains: []
};

let observer = null;
let io = null;
let alive = true;
let scanBusy = false;
let pendingNodes = new Set();
let totalReplaced = 0;

// CMP-Guard
let CMP_WAIT_ACTIVE = false;

const MAX_PER_PAGE  = 500;
const MAX_PER_TICK  = 30;
const MIN_WIDTH     = 80;
const MIN_HEIGHT    = 50;

/* ================================
   Lifecycle
================================ */
function teardown() {
    alive = false;
    try { observer && observer.disconnect(); } catch {}
    try { io && io.disconnect && io.disconnect(); } catch {}
    try { pendingNodes && pendingNodes.clear && pendingNodes.clear(); } catch {}
}
addEventListener("pagehide", teardown, { once: true });
addEventListener("beforeunload", teardown, { once: true });

function safeSendMessage(msg) {
    try {
        if (!alive || !chrome?.runtime?.id) return Promise.resolve();
        return chrome.runtime.sendMessage(msg).catch(() => {});
    } catch { return Promise.resolve(); }
}

/* ================================
   Helpers
================================ */
function isNode(x) { return !!(x && typeof x === "object" && typeof x.nodeType === "number"); }
function safeObserve(mo, target, options) { if (mo && isNode(target)) { try { mo.observe(target, options); } catch {} } }
function onReady(fn){ if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once:true }); else fn(); }

/* ================================
   Loop-Guard
================================ */
function loopGuardArm(originKey = location.origin) {
    try {
        const key = "__catblocker_loopguard__" + originKey;
        const now = Date.now();
        const raw = sessionStorage.getItem(key);
        let bucket = raw ? JSON.parse(raw) : { count: 0, ts: now };
        if (now - bucket.ts > 30000) bucket = { count: 0, ts: now };
        bucket.count++;
        sessionStorage.setItem(key, JSON.stringify(bucket));
        return bucket.count;
    } catch { return 1; }
}

/* ================================
   Styles
================================ */
function injectCatblockerStylesOnce() {
    if (document.getElementById("catblocker-style")) return;
    const style = document.createElement("style");
    style.id = "catblocker-style";
    style.textContent = `
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
   YouTube helpers
================================ */
function isYouTubeSite() {
    const h = location.hostname.replace(/^www\./, "");
    return h === "youtube.com" || h.endsWith(".youtube.com") || h === "m.youtube.com";
}
const YT_UI_BLOCKLIST = [
    "ytd-masthead","tp-yt-app-header","#masthead","#masthead-container",
    "#page-manager","#content","#columns","#guide","ytd-mini-guide-renderer","#guide-content",
    "ytd-feed-filter-chip-bar-renderer","#chips","ytd-rich-grid-renderer","ytd-rich-item-renderer",
    "ytd-video-renderer","ytd-watch-flexy","#primary","#secondary","#player",".html5-video-player","#movie_player","ytd-player",
    "#related","#comments","ytd-comments"
];
function isInYouTubeUi(el){ return isYouTubeSite() && YT_UI_BLOCKLIST.some(sel => !!el.closest(sel)); }
function isYouTubePlayerSubtree(el){ return !!el.closest('#movie_player, .html5-video-player, ytd-player'); }
function isInComments(el){ return !!el.closest('#comments, ytd-comments, ytd-comment-thread-renderer, ytd-comment-view-model, ytd-item-section-renderer[section-identifier="comments-entry-point"], .comment, .comments, [role="comments"]'); }

/* ================================
   CMP detection (hard skip)
================================ */
const CMP_VENDOR_RE = /(onetrust|usercentrics|didomi|quantcast|sourcepoint|consentmanager|iubenda|termly|trustarc|cookiebot)/i;
const CONSENT_KEYWORDS_RE = /\b(cookie|cookies|consent|gdpr|privacy|datenschutz|einwilligung|einstellungen|preferences|policy|cmp)\b/i;

function isSourcepointNode(el) {
    if (!el) return false;
    const id = (typeof el.id === "string") ? el.id : (el.id?.baseVal || "");
    if (id && (id.startsWith("sp_message_container_") || id.startsWith("sp_message_iframe_") || id === "sp_veil")) return true;
    if (el.classList && (el.classList.contains("sp_veil") || el.classList.contains("sp_message") || el.classList.contains("sp_message_container"))) return true;
    const src = (el.tagName === "IFRAME") ? (el.getAttribute("src") || "") : "";
    return /sourcepoint\./i.test(src);
}
function isConsentElement(el) {
    try {
        if (!el || !(el instanceof Element)) return false;
        if (isSourcepointNode(el)) return true;

        const attr = (el.id ? String(el.id) : "") + " " + (el.className ? String(el.className) : "");
        if (CONSENT_KEYWORDS_RE.test(attr)) return true;

        // iframe/vendor
        if (el.tagName === "IFRAME") {
            const src = (el.getAttribute("src") || "").toLowerCase();
            if (CMP_VENDOR_RE.test(src) || CONSENT_KEYWORDS_RE.test(src)) return true;
        }

        // visible text
        const text = (el.textContent || "").slice(0, 2000).toLowerCase();
        if (CONSENT_KEYWORDS_RE.test(text)) return true;

        return false;
    } catch { return false; }
}
function isCmpPresent() {
    try {
        if (document.querySelector(
            [
                // typische CMP-Strukturen
                "#onetrust-consent-sdk,#onetrust-banner-sdk,.onetrust-pc-dark-filter",
                "[id^='sp_message_container_'],#sp_veil,.sp_veil,.sp_message,.sp_message_container",
                "[class*='usercentrics'], [id*='usercentrics']",
                "iframe[src*='privacy-mgmt'],iframe[src*='consent'],iframe[src*='cookie']",
                "[role='dialog'][aria-modal='true']"
            ].join(",")
        )) return true;

        // Fallback: grob im Body nach CMP-Elementen suchen
        for (const el of document.querySelectorAll("div,section,dialog,iframe")) {
            if (isConsentElement(el)) return true;
        }
        return false;
    } catch { return false; }
}

/* ================================
   Interstitial heuristics (ads only)
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
   Targeted Unlock (disabled during CMP)
================================ */
let unlockTimer = null;
let unblockerActive = false;
const SCROLL_KEYS = new Set(["ArrowUp","ArrowDown","PageUp","PageDown","Home","End","Space"," "]);
let _unlockTouched = [];
function getCandidateScrollContainers() {
    const list = [
        document.scrollingElement || document.documentElement,
        document.body,
        ...document.querySelectorAll("main, #app, #root, #page, #content, #container, #wrap, #wrapper, #__next, [data-scroll-lock], [data-scroll-blocked]")
    ];
    return Array.from(new Set(list.filter(Boolean)));
}
function captureScrollPos() {
    const docEl = document.scrollingElement || document.documentElement;
    return { winX: window.scrollX, winY: window.scrollY,
        perEl: getCandidateScrollContainers().map(el => ({ el, x: el.scrollLeft, y: el.scrollTop })) };
}
function restoreScrollPos(state) {
    if (!state) return;
    for (const it of state.perEl) { try { it.el.scrollLeft = it.x; it.el.scrollTop = it.y; } catch {} }
    requestAnimationFrame(() => { window.scrollTo(state.winX, state.winY); });
}
function applyTargetedUnlock() {
    if (CMP_WAIT_ACTIVE) return; // HARTER STOP während CMP
    const touched = [];
    const cands = getCandidateScrollContainers();
    for (const el of cands) {
        try {
            const cs = getComputedStyle(el);
            if (cs.overflowY === "hidden" || cs.overflowY === "clip" || cs.touchAction === "none") {
                const prev = { el, style: { overflowY: el.style.overflowY, overscrollBehavior: el.style.overscrollBehavior, touchAction: el.style.touchAction } };
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
    if (CMP_WAIT_ACTIVE) return; // während CMP nichts anfassen
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
    if (CMP_WAIT_ACTIVE) return; // nicht während CMP
    stopUnlockDaemon();
    const snapshot = captureScrollPos();
    applyTargetedUnlock();
    addScrollCaptureUnblockers();
    requestAnimationFrame(() => restoreScrollPos(snapshot));
    unlockTimer = setTimeout(stopUnlockDaemon, durationMs);
}
function stopUnlockDaemon() {
    if (unlockTimer) { clearTimeout(unlockTimer); unlockTimer = null; }
    removeScrollCaptureUnblockers();
    revertTargetedUnlock();
}

/* ================================
   CMP-Wartemodus
================================ */
function shouldForceCmpWait(host) {
    // ZEIT: hart aktivieren
    if (/(^|\.)zeit\.de$/i.test(host)) return true;
    return false;
}
function armCmpWaitLoop() {
    CMP_WAIT_ACTIVE = true;
    // Während CMP aktiv ist: NICHTS TUN. Nur auf DOM-Änderungen warten.
    const mo = new MutationObserver(() => {
        if (!isCmpPresent()) {
            mo.disconnect();
            CMP_WAIT_ACTIVE = false;
            startReplacement();
        }
    });
    safeObserve(mo, document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class","style","aria-hidden","aria-modal","src","id"] });
}

/* ================================
   Init
================================ */
(async function init() {
    const hits = loopGuardArm();
    if (hits > 3) window.__CATBLOCKER_SAFE_MODE__ = true;

    try {
        const resp = await safeSendMessage({ type: "CATBLOCKER_GET_SETTINGS" });
        if (resp?.ok && resp.settings) settings = { ...settings, ...resp.settings };
    } catch {}

    const host = (location.hostname || "").replace(/^www\./, "");
    if (!settings.enabled || (settings.whitelist || []).includes(host)) return;

    injectCatblockerStylesOnce();

    // CMP bypass optional (Default: aus) – nur Sourcepoint weich neutralisieren, wenn EXPLIZIT eingeschaltet
    if (settings.cmpBypassSourcepoint === true) {
        // Soft-bypass aktivierst du wieder, indem du im Options-UI cmpBypassSourcepoint auf true setzt.
        // (Implementierung bewusst weggelassen, solange CMP_WAIT_ACTIVE = true)
    }

    // Harte Regel: wenn CMP sichtbar ODER Domain-Force aktiv → warten & nichts anfassen
    if (shouldForceCmpWait(host) || isCmpPresent()) {
        armCmpWaitLoop();
        return;
    }

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
        attributeFilter: ["style", "class", "id", "src", "data-ad", "data-advertisement", "aria-label", "aria-hidden", "aria-modal"]
    });

    chrome.runtime.onMessage.addListener((msg) => {
        if (!alive) return;
        if (msg?.type === "CATBLOCKER_FORCE_SCAN") scheduleScan();
    });
}

/* Throttled scheduling */
let lastScanAt = 0;
function scheduleScan() {
    if (CMP_WAIT_ACTIVE || isCmpPresent()) return; // während CMP: kein Scan
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
        if (!alive || !work.length || CMP_WAIT_ACTIVE) return;
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
    if (scanBusy || CMP_WAIT_ACTIVE) return;
    scanBusy = true;
    if (!alive) { scanBusy = false; return; }
    ensureIO();

    const DOMAIN_RE = (typeof buildDomainRegexFromSettings === "function")
        ? buildDomainRegexFromSettings(settings)
        : /(doubleclick|googlesyndication|adservice|adnxs|taboola|outbrain|revcontent|adsystem|adroll|criteo)/i;

    const adIframeSelector = (typeof buildIframeSelectorFromSettings === "function")
        ? buildIframeSelectorFromSettings(settings)
        : `iframe[src*="doubleclick"],iframe[src*="googlesyndication"],iframe[src*="adservice"],iframe[src*="adnxs"],iframe[src*="taboola"],iframe[src*="outbrain"],iframe[src*="revcontent"],iframe[src*="criteo"],iframe[src*="adroll"],iframe[id*="ad"],iframe[name*="ad"]`;

    // 0) Wenn CMP erscheint, sofort abbrechen und in den Wartemodus
    if (isCmpPresent()) { scanBusy = false; if (!CMP_WAIT_ACTIVE) armCmpWaitLoop(); return; }

    // 1) YouTube (nur Ads, nie UI/CMP)
    if (isYouTubeSite()) {
        try {
            document.querySelectorAll(".video-ads, .ytp-ad-player-overlay, .ytp-ad-text, .ytp-ad-overlay-container, .ytp-ad-image-overlay, .ytp-ad-module")
                .forEach(node => { if (!node.__catblockerProcessed) hideNode(node); });
            const skipParent = document.querySelector(".ytp-ad-skip-button-container, .ytp-ad-skip-button, .ytp-ad-skip-button-modern");
            if (skipParent && !skipParent.__catblockerProcessed) hideNode(skipParent);

            document.querySelectorAll([
                "ytd-ad-slot-renderer","ytd-display-ad-renderer","ytd-in-feed-ad-layout-renderer",
                "ytd-promoted-video-renderer","ytd-promoted-sparkles-web-renderer","ytd-promoted-item-renderer",
                "ytd-ad-inline-playback-renderer","ytd-player-legacy-desktop-watch-ads-renderer"
            ].join(",")).forEach(el => {
                if (el.__catblockerProcessed) return;
                if (isInYouTubeUi(el)) return;
                if (isConsentElement(el)) return;
                if (isLikelyInterstitial(el)) { neutralizeOverlay(el); return; }
                markCandidate(el);
            });
        } catch {}
    }

    // 2) iframe-basierte Ads
    try {
        document.querySelectorAll(adIframeSelector).forEach(el => {
            if (el.__catblockerProcessed) return;
            if (isConsentElement(el) || (el.closest('[role="dialog"], .modal, .overlay') && isConsentElement(el.closest('[role="dialog"], .modal, .overlay')))) return;
            if (inHeaderArea(el) || inGenericUiArea(el)) return;
            if (isYouTubePlayerSubtree(el)) return;
            if (isYouTubeSite() && isInYouTubeUi(el)) return;
            if (isLikelyInterstitial(el)) { neutralizeOverlay(el); return; }
            markCandidate(el);
        });
    } catch {}

    // 3) background-image Ads
    try {
        const bgCandidates = document.querySelectorAll("div, section, aside, a");
        for (const el of bgCandidates) {
            if (el.__catblockerProcessed) continue;
            if (el.closest('.catblocker-container')) continue;
            if (isConsentElement(el)) continue;
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

    // 4) Labels (Sponsored/Anzeige…)
    try {
        const labelCandidates = document.querySelectorAll("*[aria-label], [data-testid], span, div, a");
        labelCandidates.forEach(el => {
            if (el.__catblockerProcessed) return;
            if (isConsentElement(el)) return;
            if (inHeaderArea(el) || inGenericUiArea(el)) return;
            if (isInComments(el)) return;
            if (isYouTubeSite() && isInYouTubeUi(el)) return;

            const txt = (el.textContent || "").trim().toLowerCase();
            if (!txt) return;
            if (["sponsored","promoted","anzeige","werbung","ad"].some(w => txt === w || txt.startsWith(w + " "))) {
                const container = el.closest("article, li, ytd-rich-item-renderer, ytd-video-renderer, .feed-item, .card, .result, section, div");
                if (container && !container.__catblockerProcessed && !inHeaderArea(container) && !inGenericUiArea(container)) {
                    if (isYouTubeSite() && isInYouTubeUi(container)) return;
                    if (isConsentElement(container)) return;
                    if (isLikelyInterstitial(container)) { neutralizeOverlay(container); return; }
                    markCandidate(container);
                }
            }
        });
    } catch {}

    // 5) generische Selektoren
    try {
        const selectors = (typeof chooseSelectors === "function") ? chooseSelectors(settings.intensity) : [];
        if (selectors && selectors.length) {
            document.querySelectorAll(selectors.join(",")).forEach(node => {
                if (node.__catblockerProcessed) return;
                if (node.closest('.catblocker-container')) return;
                if (isConsentElement(node)) return; // NIE CMP anfassen
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

    for (const el of pendingNodes) io.observe(el);
    pendingNodes.clear();

    if (!alive) { scanBusy = false; return; }
    scanBusy = false;
}

/* ================================
   Mark + Replace
================================ */
function markCandidate(el) {
    if (totalReplaced >= MAX_PER_PAGE) return;
    if (el.__catblockerProcessed) return;
    if (isConsentElement(el)) return;
    pendingNodes.add(el);
}

async function replaceNodeWithCat(node) {
    try {
        if (!alive || node.__catblockerProcessed) return;
        if (isConsentElement(node)) return;

        if (isLikelyInterstitial(node)) {
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

        if (rect.width > vw * 0.8 || rect.height > vh * 0.7) {
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
    } catch {}
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
