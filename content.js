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
    cmpBypassSourcepoint: false,
    customBlocklistDomains: [],
    allowDomains: [],
    blockDomains: [],
    showDismiss: true,
    theme: "light"
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
    try { clearInterval(startYouTubeAdBlocking._t); } catch {}
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
const COMMON_AD_SIZES = [
    [300,250], [336,280], [320,50], [728,90], [160,600], [300,600], [970,250], [970,90]
];
function isCommonAdSize(rect, tol = 8) {
    const w = Math.round(rect.width), h = Math.round(rect.height);
    return COMMON_AD_SIZES.some(([W,H]) =>
        Math.abs(W - w) <= tol && Math.abs(H - h) <= tol
    );
}

// Helper: hat der Anchor außer dem Ad-Knoten noch nennenswerten Inhalt?
function anchorOnlyWraps(node, anchor) {
    try {
        const kids = Array.from(anchor.childNodes).filter(n => !(n.nodeType === 3 && !n.nodeValue.trim()));
        if (kids.length === 1 && kids[0] === node) return true;
        // Edge: Mini-Deko-Knoten erlaubt (z.B. leeres <div> oder <span> ohne Größe)
        const other = kids.filter(k => k !== node);
        if (other.length === 0) return true;
        if (other.every(k => k.nodeType === 1 && k.getBoundingClientRect &&
            (k.getBoundingClientRect().width < 4 && k.getBoundingClientRect().height < 4))) {
            return true;
        }
    } catch {}
    return false;
}

function rectsOverlap(a, b, tol = 1) {
    return !(a.right < b.left - tol || a.left > b.right + tol || a.bottom < b.top - tol || a.top > b.bottom + tol);
}

function scrubSiblingAnchors(container, DOMAIN_RE) {
    try {
        const slot = container.parentElement || container;
        const rC = container.getBoundingClientRect();
        const anchors = Array.from(slot.querySelectorAll('a[href]'));

        for (const a of anchors) {
            if (a.contains(container) || container.contains(a)) continue;

            const rA = a.getBoundingClientRect();
            const touchy =
                rectsOverlap(rA, rC, 8) ||                    // überlappt optisch
                Math.abs(rA.top - rC.top) < 10 ||             // gleiche Reihe
                Math.abs(rA.left - rC.left) < 10;

            // Domain-Hinweis (falls bekannt) verstärkt die Entscheidung:
            const href = (a.getAttribute('href') || '').toLowerCase();
            const trackerish = /click|track|redirect|adserver|pxl|tsyndicate/.test(href) || (DOMAIN_RE && DOMAIN_RE.test(href));

            if (touchy || trackerish) {
                a.removeAttribute('href');
                a.removeAttribute('target');
                a.setAttribute('tabindex', '-1');
                a.style.setProperty('pointer-events','none','important');
                a.style.setProperty('cursor','default','important');
                a.setAttribute('rel','noopener noreferrer');
            }
        }
    } catch {}
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
/* ================================
   YouTube ad blocking (uBlock-style)
   - cosmetic CSS hides feed/sidebar/search ads
   - skipper fast-forwards any video ad that still plays
   - youtube/yt_main.js (MAIN world) strips ad data from player responses
================================ */
const YT_HIDE_SELECTORS = [
    // desktop feed / sidebar / search
    "ytd-ad-slot-renderer",
    "ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer)",
    "ytd-rich-section-renderer:has(ytd-ad-slot-renderer)",
    "ytd-item-section-renderer:has(> #contents > ytd-ad-slot-renderer:only-child)",
    "ytd-in-feed-ad-layout-renderer",
    "ytd-display-ad-renderer",
    "ytd-promoted-sparkles-web-renderer",
    "ytd-promoted-video-renderer",
    "ytd-promoted-item-renderer",
    "ytd-search-pyv-renderer",
    "ytd-banner-promo-renderer",
    "ytd-statement-banner-renderer",
    "ytd-companion-slot-renderer",
    "ytd-action-companion-ad-renderer",
    "ytd-player-legacy-desktop-watch-ads-renderer",
    "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-ads']",
    "#masthead-ad",
    "#player-ads",
    // in-player overlays
    ".ytp-ad-overlay-container",
    ".ytp-ad-image-overlay",
    ".ytp-ad-overlay-slot",
    ".ytp-featured-product",
    // mobile (m.youtube.com)
    "ad-slot-renderer",
    "ytm-promoted-sparkles-web-renderer",
    "ytm-companion-ad-renderer",
    "ytm-rich-item-renderer:has(ad-slot-renderer)"
];

/* Site-specific cosmetic filters (uBlock-style "##" rules): hidden, not replaced.
   Only YouTube — on all other sites ads are replaced with cats. */
function siteCosmeticSelectors() {
    if (isYouTubeSite()) return YT_HIDE_SELECTORS;
    return null;
}

function injectSiteCosmeticCssOnce() {
    const selectors = siteCosmeticSelectors();
    if (!selectors || document.getElementById("catblocker-site-style")) return;
    const style = document.createElement("style");
    style.id = "catblocker-site-style";
    // One rule per selector: an unsupported selector must not invalidate the others
    style.textContent = selectors.map(s => `${s} { display: none !important; }`).join("\n");
    (document.head || document.documentElement).appendChild(style);
}

/* Count newly hidden elements for the badge (each element only once) */
function countSiteCosmeticHits() {
    const selectors = siteCosmeticSelectors();
    if (!selectors) return;
    // Only the selectors this browser understands (one bad selector would break a joined list)
    const valid = countSiteCosmeticHits._valid ||= selectors.filter(s => {
        try { document.querySelector(s); return true; } catch { return false; }
    });
    const joined = valid.join(",");
    let n = 0;
    for (const sel of valid) {
        document.querySelectorAll(sel).forEach(el => {
            if (el.__catblockerCounted) return;
            el.__catblockerCounted = true;
            // count only the outermost match (e.g. article, not also its shreddit-ad-post)
            if (el.parentElement?.closest(joined)) return;
            n++;
        });
    }
    if (n) safeSendMessage({ type: "CATBLOCKER_ADD_COUNT", amount: n });
}

const YT_SKIP_BUTTONS = ".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-slot button";
let ytAdState = null;   // { video, muted, rate } while we are fast-forwarding an ad

function ytSkipVideoAd() {
    if (!alive) return;
    const player = document.querySelector("#movie_player, .html5-video-player");
    const adShowing = !!player && (player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting"));

    if (!adShowing) {
        // Ad over: restore what we changed on the (shared) <video> element
        if (ytAdState) {
            const { video, muted, rate } = ytAdState;
            ytAdState = null;
            try { video.muted = muted; video.playbackRate = rate; } catch {}
        }
        return;
    }

    const video = player.querySelector("video.html5-main-video, video");
    if (!video) return;

    if (!ytAdState || ytAdState.video !== video) {
        ytAdState = { video, muted: video.muted, rate: video.playbackRate || 1 };
        safeSendMessage({ type: "CATBLOCKER_ADD_COUNT", amount: 1 });
    }
    try {
        video.muted = true;
        video.playbackRate = 16;
        if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.2) {
            video.currentTime = video.duration - 0.1;
        }
    } catch {}
    document.querySelectorAll(YT_SKIP_BUTTONS).forEach(btn => { try { btn.click(); } catch {} });
}

function startYouTubeAdBlocking() {
    if (startYouTubeAdBlocking._t) return;
    startYouTubeAdBlocking._t = setInterval(ytSkipVideoAd, 250);

    // Counter for ads pruned by youtube/yt_main.js
    window.addEventListener("message", (e) => {
        if (e.source !== window || e.data?.source !== "catblocker-yt") return;
        if (e.data.type === "ads-pruned") safeSendMessage({ type: "CATBLOCKER_ADD_COUNT", amount: 1 });
    });
}

/* ================================
   Reddit: known ad elements → replaced with cats
   (new reddit "shreddit" web components + old.reddit.com)
================================ */
const REDDIT_AD_SELECTORS = [
    // new reddit: feed (article wraps the ad post → replace the whole article)
    "article:has(> shreddit-ad-post)",
    "shreddit-ad-post",
    // comments page / sidebar
    "shreddit-comments-page-ad",
    "shreddit-comment-tree-ad",
    "shreddit-sidebar-ad",
    "shreddit-dynamic-ad-link",
    "shreddit-post[promoted]",
    "[data-testid='ad-unit']",
    // old reddit
    ".promotedlink",
    ".ad-container",
    "#ad_main",
    ".sponsorshipbox"
];

function isRedditSite() {
    const h = location.hostname.replace(/^www\./, "");
    return h === "reddit.com" || h.endsWith(".reddit.com");
}

function redditAdSelectorJoined() {
    // filter out selectors this browser can't parse (one bad one would break the list)
    return redditAdSelectorJoined._s ||= REDDIT_AD_SELECTORS.filter(s => {
        try { document.querySelector(s); return true; } catch { return false; }
    }).join(",");
}

function isInRedditAd(el) {
    if (!isRedditSite()) return false;
    const joined = redditAdSelectorJoined();
    return !!(joined && el.closest(joined));
}

/* Queue the outermost known ad elements for cat replacement (no score gate) */
function queueRedditAds() {
    const joined = redditAdSelectorJoined();
    if (!joined) return;
    document.querySelectorAll(joined).forEach(el => {
        if (el.__catblockerProcessed || el.__cbGateSeen) return;
        if (el.closest(".catblocker-container")) return;
        if (el.parentElement?.closest(joined)) return;   // an ancestor is the ad slot
        el.__cbGateSeen = true;
        el.__cbExactTarget = true;                       // replace exactly this element
        pendingNodes.add(el);
    });
}

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
        // DO NOT touch cookie / consent elements at all — skip them entirely
        try {
            const txt = (el.textContent || "").toLowerCase();
            if (/\b(cookie|consent|preferences|privacy|gdpr|opt-in|optout|opt-out)\b/i.test(txt)) {
                // leave consent nodes alone
                continue;
            }
        } catch {}
        if (!isLikelyInterstitial(el)) continue;

        // existing logic follows, but note: do NOT neutralize sourcepoint/consent now
        const hasAdIframe = !!el.querySelector(adIframeSelector);
        // we only neutralize non-consent interstitials that contain ad-iframes
        if (hasAdIframe) {
            neutralizeOverlay(el);
            touched++;
            continue;
        }

        // other cases previously touching sourcepoint are removed
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
   Toast helper
================================ */
function showToast(text, duration=1400) {
    try {
        const id = "catblocker-toast";
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement("div");
            el.id = id;
            Object.assign(el.style, {
                position: "fixed",
                zIndex: 2147483647,
                left: "50%",
                bottom: "24px",
                transform: "translateX(-50%)",
                background: "rgba(0,0,0,0.8)",
                color: "#fff",
                padding: "8px 12px",
                borderRadius: "8px",
                fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
                fontSize: "12px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
                opacity: "0",
                transition: "opacity .18s ease"
            });
            document.documentElement.appendChild(el);
        }
        el.textContent = text;
        el.style.opacity = "1";
        clearTimeout(showToast._t);
        showToast._t = setTimeout(() => { el.style.opacity = "0"; }, duration);
    } catch {}
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
    injectSiteCosmeticCssOnce();
    if (isYouTubeSite()) startYouTubeAdBlocking();
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
        attributeFilter: ["style","class","id","src","href","srcdoc","sandbox","data-ad","data-advertisement","aria-label"]
    });

    chrome.runtime.onMessage.addListener((msg) => {
        if (!alive) return;
        if (msg?.type === "CATBLOCKER_FORCE_SCAN") scheduleScan();
        if (msg?.type === "CATBLOCKER_TOAST" && msg.text) showToast(msg.text);
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

    // YOUTUBE: feed/sidebar ads are hidden via CSS (startYouTubeAdBlocking), video ads are
    // pruned/skipped. Here we only check the skipper on DOM changes for a faster reaction.
    if (isYouTubeSite()) {
        try { ytSkipVideoAd(); } catch {}
    }
    // YouTube: ads are hidden via CSS → count them for the badge
    try { countSiteCosmeticHits(); } catch {}

    // REDDIT: known ad elements are replaced with cats
    if (isRedditSite()) {
        try { queueRedditAds(); } catch {}
    }

    // 1) iframe-based ads (dynamic selector)
    try {
        document.querySelectorAll(adIframeSelector).forEach(el => {
            if (el.__catblockerProcessed) return;
            if (el.closest('.catblocker-container, .catblocker-dismissed')) return;
            if (inHeaderArea(el) || inGenericUiArea(el)) return;
            if (isYouTubePlayerSubtree(el)) return;
            if (isYouTubeSite() && isInYouTubeUi(el)) return;
            if (isLikelyInterstitial(el)) { neutralizeOverlay(el); return; }
            markCandidate(el);
        });
    } catch {}

    try {
        document.querySelectorAll('iframe:not([src]), iframe[src=""], iframe[src^="about:blank"], iframe[srcdoc]')
            .forEach(el => {
                if (el.__catblockerProcessed) return;
                if (el.closest('.catblocker-container, .catblocker-dismissed')) return;
                if (inHeaderArea(el) || inGenericUiArea(el)) return;
                if (isYouTubePlayerSubtree(el)) return;
                if (isYouTubeSite() && isInYouTubeUi(el)) return;

                const r = el.getBoundingClientRect();
                if (r.width < MIN_WIDTH || r.height < MIN_HEIGHT) return;

                const sbox = (el.getAttribute("sandbox") || "").toLowerCase();
                const suspiciousSandbox = /allow-scripts|allow-popups|allow-forms/.test(sbox);

                // Heuristik: typische IAB-Größe ODER „gefährliche“ Sandbox-Rechte
                if (isCommonAdSize(r) || suspiciousSandbox) {
                    if (isLikelyInterstitial(el)) { neutralizeOverlay(el); return; }
                    markCandidate(el);
                }
            });
    } catch {}


    // 2) background-image ads (use DOMAIN_RE)
    try {
        const bgCandidates = document.querySelectorAll("div, section, aside, a");
        for (const el of bgCandidates) {
            if (el.__catblockerProcessed) continue;
            if (el.closest('.catblocker-container, .catblocker-dismissed')) continue;
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
// --- Phase 1: scoring-based candidate gating (EN/US aggressive) ---
function __cb_getIntensityThreshold(intensity){
    // lower thresholds for aggressive preference
    if (intensity === "aggressive") return 2;
    if (intensity === "gentle" || intensity === "conservative") return 4;
    return 3; // balanced
}

function __cb_hasSafeExclusion(el){
    try {
        // avoid critical UI containers and controls
        if (el.closest('nav, header, footer, form, dialog, [role="dialog"], [role="search"], [data-consent], #cookie, #consent')) return true;
        if (el.closest('main article') && el.closest('figure, .media, .article-media')) return true;
        if (el.closest('video, audio')) return true;
        // obvious site UI widgets
        if (el.closest('.search, .site-header, .site-footer, .newsletter, .subscribe, .login, .signup')) return true;
    } catch {}
    return false;
}

function __cb_texty(s){ return (s||"").toLowerCase(); }

function __cb_collectAttrStrings(el){
    const acc = [];
    try {
        const attrs = ['src','href','data-src','data-href','srcset','data-ad','data-adslot','data-ad-unit','aria-label','title'];
        for (const a of attrs) { const v = el.getAttribute && el.getAttribute(a); if (v) acc.push(String(v)); }
        // also class and id
        if (el.className) acc.push(String(el.className));
        if (el.id) acc.push(String(el.id));
        // include immediate child <img>/<source> src/srcset
        const img = el.querySelector && el.querySelector('img, source');
        if (img) {
            ['src','srcset','data-src'].forEach(a=>{ const v = img.getAttribute(a); if (v) acc.push(String(v)); });
        }
    } catch {}
    return __cb_texty(acc.join(' '));
}

function __cb_computeAdScore(el, DOMAIN_RE){
    let score = 0;
    try {
        const tag = (el.tagName||'').toLowerCase();
        const cls = __cb_texty(el.className||'');
        const id  = __cb_texty(el.id||'');

        // 1) Selector-ish hints
        if (/(^|\s)ad(s)?(\s|$|[-_])/.test(cls) || /(advert|advertisement|ad-slot|ad__slot|ad-container|ad-unit|ad-wrapper)/.test(cls)) score += 2;
        if (/sponsor|sponsored|promoted|ad-marker/.test(cls)) score += 2;
        if (/ad|advert/.test(id) || /sponsor|promo/.test(id)) score += 1;

        // 2) Attribute hints (aria/data/title/text)
        const attrs = __cb_collectAttrStrings(el);
        if (/advertisement|sponsored|promoted|partner content|paid/.test(attrs)) score += 2;
        if (/data-google-query-id|gpt|dfp/.test(attrs)) score += 2;

        // 3) Size heuristic
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : {width:0,height:0};
        if (r.width >= MIN_WIDTH && r.height >= MIN_HEIGHT && isCommonAdSize(r)) score += 1;

        // 4) Vendor/domain hints from attributes
        if (DOMAIN_RE && DOMAIN_RE.test(attrs)) score += 3; // strong signal

        // 5) iFrame special
        if (tag === 'iframe'){
            const nameAttr = __cb_texty(el.getAttribute('name')||'');
            if (/ad/.test(nameAttr) || /ad/.test(id)) score += 1;
            if (el.hasAttribute && (el.hasAttribute('srcdoc') || !el.getAttribute('src'))) score += 1;
        }

        // cap score to avoid runaway
        if (score > 10) score = 10;
    } catch {}
    return score;
}

function markCandidate(el) {
    if (totalReplaced >= MAX_PER_PAGE) return;
    if (!el || el.__catblockerProcessed) return;
    if (el.__cbGateSeen) return; // avoid repeated scoring of the same node
    // inside a known Reddit ad: the whole slot is replaced by queueRedditAds()
    if (isInRedditAd(el)) { el.__cbGateSeen = true; return; }

    // Safe exclusions first
    if (__cb_hasSafeExclusion(el)) { el.__cbGateSeen = true; return; }

    // Compute score (use last built DOMAIN_RE if available via closure in scan)
    // If not available, fall back to a generic one
    const DOMAIN_RE = (typeof buildDomainRegexFromSettings === 'function')
        ? buildDomainRegexFromSettings(settings)
        : /(doubleclick|googlesyndication|adservice|adnxs|taboola|outbrain|revcontent|adsystem|adroll|criteo|adtng|trafficjunky)/i;

    const score = __cb_computeAdScore(el, DOMAIN_RE);
    const threshold = __cb_getIntensityThreshold(settings.intensity || 'balanced');

    let pass = score >= threshold;

    if (pass) {
        pendingNodes.add(el);
    }
    // mark as seen to avoid rework; replacement will flip __catblockerProcessed
    el.__cbGateSeen = true;
}

/* ================================
   Replacement: replace node with cat
================================ */

function chooseReplacementTarget(node) {
    // 1) Site-/Slot-Container (generisch + häufige Muster)
    const genericSlot = node.closest([
        '[data-ad]','[data-sponsored]','[data-advertisement]',
        '.ad','.ads','.advert','.advertisement',
        '.ad-container','.ad-slot','.ad-unit','.ad__slot',
        '[id^="ad_"]','[id*="-ad"]','[class*=" ad-"]',
        // häufige Thumb/Teaser-Wrapper
        '.mn-thumb','.thumb','.teaser','.card','.result'
    ].join(','));

    if (genericSlot) return genericSlot;

    // 2) Falls im Link verschachtelt → nimm den <a>
    const a = node.closest('a[href]');
    if (a) return a;

    // 3) Sonst: Parent, der "a[href]" enthält und ähnlich groß ist (Slot-Heuristik)
    let p = node.parentElement, best = node, r0 = node.getBoundingClientRect();
    while (p && p !== document.body) {
        const ra = p.getBoundingClientRect();
        const c = p.querySelector('a[href]');
        const areaFits = (ra.width * ra.height) <= (r0.width * r0.height) * 4; // nicht zu groß
        if (c && areaFits) { best = p; break; }
        p = p.parentElement;
    }
    return best;
}


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

        const target = node.__cbExactTarget ? node : chooseReplacementTarget(node);
        const rect = target.getBoundingClientRect(); // statt node
        const vw = window.innerWidth, vh = window.innerHeight;

        // extra guard: if gigantic, neutralize instead of replacing
        if (!force && (rect.width > vw * 0.8 || rect.height > vh * 0.7)) {
            neutralizeOverlay(target);
            if (!window.__CATBLOCKER_SAFE_MODE__) startUnlockDaemon(3000);
            return;
        }

        const minW = isYouTubeSite() ? 200 : 100;
        const minH = isYouTubeSite() ? 120 : 80;
        const w = Math.max(minW, Math.floor(rect.width))  || (isYouTubeSite() ? 300 : 300);
        const h = Math.max(minH, Math.floor(rect.height)) || (isYouTubeSite() ? 180 : 250);

        const cs = getComputedStyle(node);
        const origDisplay = cs.display;          // z.B. "inline", "inline-block", "block", "contents", "grid", "flex"
        const isInlineish = origDisplay === "inline" || origDisplay === "inline-block" || origDisplay === "inline-flex";


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
      contain: paint !important;
      isolation: isolate !important;
      view-transition-name: none !important;
    `;
        container.setAttribute("tabindex", "0");

        const img = document.createElement("img");
        img.src = catUrl;
        img.alt = "Ad replaced by a cat 😺";
        img.loading = "lazy";
        img.decoding = "async";
        img.style.cssText = `
      display: block !important;
      width: 100% !important;
      height: 100% !important;
      object-fit: cover !important;
      object-position: center center !important;
      overflow: clip !important;
      overflow-clip-margin: content-box;
      contain: paint !important;
      view-transition-name: none !important;
      transition: opacity .18s ease !important;
      opacity: 1 !important;
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

        // Optional dismiss button (×)
        if (settings && settings.showDismiss !== false) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "cb-dismiss";
            btn.setAttribute("aria-label", "Dismiss cat");
            btn.title = "Dismiss";
            // SVG cross instead of the "×" glyph: glyph position depends on font metrics,
            // the SVG is centered exactly via flexbox
            const SVG_NS = "http://www.w3.org/2000/svg";
            const svg = document.createElementNS(SVG_NS, "svg");
            svg.setAttribute("viewBox", "0 0 10 10");
            svg.setAttribute("width", "10");
            svg.setAttribute("height", "10");
            svg.setAttribute("aria-hidden", "true");
            // absolutely centered + hardened against page CSS (svg/button margins, vertical-align, transforms)
            svg.style.cssText = `
        all: initial;
        display: block !important;
        position: absolute !important;
        top: 0 !important; right: 0 !important; bottom: 0 !important; left: 0 !important;
        width: 10px !important;
        height: 10px !important;
        margin: auto !important;
        padding: 0 !important;
        transform: rotate(0deg) !important;
        transition: transform .2s ease !important;
        vertical-align: top !important;
        overflow: visible !important;
        pointer-events: none !important;
      `;
            const path = document.createElementNS(SVG_NS, "path");
            path.setAttribute("d", "M1 1 L9 9 M9 1 L1 9");
            path.setAttribute("stroke", "#fff");
            path.setAttribute("stroke-width", "1.8");
            path.setAttribute("stroke-linecap", "round");
            path.style.cssText = "fill:none !important; stroke:#fff !important; stroke-width:1.8px !important; stroke-linecap:round !important;";
            svg.appendChild(path);
            btn.appendChild(svg);
            btn.style.cssText = `
        all: initial;
        position: absolute !important;
        top: 6px !important;
        right: 6px !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        box-sizing: border-box !important;
        width: 22px !important;
        height: 22px !important;
        padding: 0 !important;
        margin: 0 !important;
        border: 0 !important;
        background: #000a !important;
        border-radius: 50% !important;
        cursor: pointer !important;
        z-index: 2 !important;
        pointer-events: auto !important;
        transform: scale(1) !important;
        transition: transform .15s ease, background-color .15s ease !important;
      `;

            // Hover/focus animation (inline styles, since our inline !important beats any :hover rule)
            const reduceMotion = (() => {
                try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
            })();
            const setActive = (on) => {
                btn.style.setProperty("background", on ? "#000d" : "#000a", "important");
                if (reduceMotion) return;
                btn.style.setProperty("transform", on ? "scale(1.12)" : "scale(1)", "important");
                svg.style.setProperty("transform", on ? "rotate(90deg)" : "rotate(0deg)", "important");
            };
            btn.addEventListener("mouseenter", () => setActive(true));
            btn.addEventListener("mouseleave", () => setActive(false));
            btn.addEventListener("focus", () => setActive(true));
            btn.addEventListener("blur", () => setActive(false));
            const dismiss = (ev) => {
                try { ev && (ev.stopPropagation(), ev.preventDefault()); } catch {}
                if (container.__cbDismissing) return;
                container.__cbDismissing = true;
                const parent = container.parentElement;
                if (parent) parent.classList.add("catblocker-dismissed");
                if (reduceMotion) { try { container.remove(); } catch {} return; }
                // fade + shrink out, then remove
                container.style.setProperty("transition", "opacity .2s ease, transform .2s ease", "important");
                container.style.setProperty("opacity", "0", "important");
                container.style.setProperty("transform", "scale(.96)", "important");
                container.style.setProperty("pointer-events", "none", "important");
                setTimeout(() => { try { container.remove(); } catch {} }, 220);
            };
            btn.addEventListener("click", dismiss);
            btn.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " " || e.key === "Escape") dismiss(e);
            });
            container.appendChild(btn);
        }

        container.append(img, badge);

        container.style.removeProperty("display"); // Display zunächst freimachen
        if (isInlineish || node.tagName === "IFRAME" || node.tagName === "IMG" || node.tagName === "VIDEO") {
            container.style.setProperty("display", "inline-flex", "important");
            container.style.setProperty("vertical-align", cs.verticalAlign || "top", "important");
        } else if (origDisplay.includes("grid")) {
            container.style.setProperty("display", "grid", "important");
        } else if (origDisplay.includes("flex")) {
            container.style.setProperty("display", "flex", "important");
        } else {
            container.style.setProperty("display", origDisplay || "block", "important");
        }

// Falls Parent ein Flex/Grid-Container ist: Basis/Area nicht verlieren
        container.style.setProperty("flex", cs.flex || "0 0 auto");
        container.style.setProperty("flex-basis", cs.flexBasis || "");
        container.style.setProperty("grid-area", cs.gridArea || "");
        container.style.setProperty("box-sizing", "border-box", "important");
// Für Inline-Layouts: kein 100%-Breitziehen erzwingen
        if (isInlineish) container.style.removeProperty("max-width");

        scrubSiblingAnchors(container, typeof buildDomainRegexFromSettings === "function"
            ? buildDomainRegexFromSettings(settings) : null);


        const anchor = target.closest('a[href]');
        if (anchor && anchorOnlyWraps(target, anchor)) {
            // 1) kompletten Anker ersetzen → kein clickthrough mehr
            try { anchor.replaceWith(container); }
            catch { anchor.innerHTML = ""; anchor.appendChild(container); }
        } else {
            // Fallback: nur Node ersetzen, aber jeden evtl. übergeordneten Anker entwaffnen
            try { target.replaceWith(container); }
            catch { target.innerHTML = ""; target.appendChild(container); }

            // Falls container in <a> steckt → Clicks killen
            const wrapA = container.closest('a[href]');
            if (wrapA) {
                wrapA.removeAttribute('href');
                wrapA.removeAttribute('target');
                wrapA.setAttribute('rel', 'noopener noreferrer');
                // Do NOT disable pointer-events globally to keep dismiss clickable
                wrapA.style.setProperty('cursor','default','important');
            }
        }
        // blockiere Bubble/Delegation auf Track-Wrappern – aber lasse den Dismiss-Button zu
        const blockIfNotDismiss = (e) => {
            const isDismiss = !!(e.target && e.target.closest('.cb-dismiss'));
            if (!isDismiss) {
                try { e.preventDefault(); } catch {}
                try { e.stopPropagation(); } catch {}
            }
        };
        container.addEventListener('click', blockIfNotDismiss, { capture: true });
        container.addEventListener('auxclick', blockIfNotDismiss, { capture: true });
        container.style.setProperty('pointer-events','auto','important');



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
