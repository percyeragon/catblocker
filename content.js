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

function teardown(ev) {
    cbLog("teardown by", ev?.type, "trusted=", ev?.isTrusted);
    alive = false;
    try { observer && observer.disconnect(); } catch {}
    try { io && io.disconnect && io.disconnect(); } catch {}
    try { pendingNodes && pendingNodes.clear && pendingNodes.clear(); } catch {}
    try { clearInterval(startYouTubeAdBlocking._t); } catch {}
    if (CB_PERF) cbPerfSummary(cbPerf, "final (since load)");
}

addEventListener("pagehide", teardown, { once: true });
addEventListener("beforeunload", teardown, { once: true });
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "unloaded") teardown();
});

/* Debug logging: enable per site with  localStorage.setItem("catblocker-debug", "1")  and reload */
const CB_DEBUG = (() => { try { return localStorage.getItem("catblocker-debug") === "1"; } catch { return false; } })();
function cbLog(...args) { if (CB_DEBUG) try { console.log("[CatBlocker]", ...args); } catch {} }
function cbDesc(el) {
    try {
        const r = el.getBoundingClientRect();
        return `${el.tagName}#${el.id || ""}.${String(el.className || "").slice(0, 40)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    } catch { return String(el); }
}

/* ================================
   Performance instrumentation (off by default, zero cost when off)
   Enable per site (no verbose debug logs):  localStorage.setItem("catblocker-perf", "1")  and reload
   (also active with catblocker-debug, but the debug logs themselves cost time → skews numbers)
   - per scan: duration per phase + element counts; scans > CB_LONG_SCAN_MS are logged immediately
   - what requested scans: page mutations, our own DOM writes ("self"), timers, …
   - summary every CB_PERF_INTERVAL_MS in the console
   - DevTools Performance panel: "CatBlocker scan" / "CatBlocker replace" in the Timings track
   - full report: pick the CatBlocker context in the console dropdown and run  cbPerfReport()
   Note: localStorage is per origin → cross-origin iframes only report if the flag is set there too.
================================ */
const CB_PERF = CB_DEBUG || (() => { try { return localStorage.getItem("catblocker-perf") === "1"; } catch { return false; } })();
const CB_PERF_INTERVAL_MS = 10000;
const CB_LONG_SCAN_MS = 16;

function cbPerfNew() {
    return {
        since: performance.now(),
        scans: 0, scanMs: 0, scanMax: 0, longScans: 0,
        phases: {},          // name → { ms, max, n, inScan }
        counts: {},          // name → summed element counts
        requests: {},        // scheduleScan reason → n
        mutationBatches: 0, mutationRecords: 0, selfRecords: 0,
        replaced: 0
    };
}
let cbPerf = CB_PERF ? cbPerfNew() : null;      // since page load
let cbPerfWin = CB_PERF ? cbPerfNew() : null;   // current summary window
let cbCurScan = {};                             // breakdown of the running scan

function cbEach(fn) { if (cbPerf) { fn(cbPerf); fn(cbPerfWin); } }
function cbT() { return cbPerf ? performance.now() : 0; }
function cbFrameDesc() {
    try { return (window === window.top ? "top " : "iframe ") + location.hostname; } catch { return "?"; }
}

/* add the time since t0 to a phase; returns "now" so phases can be chained */
function cbPhase(name, t0, inScan = true) {
    if (!cbPerf) return 0;
    const now = performance.now(), ms = now - t0;
    cbEach(p => {
        const ph = p.phases[name] ||= { ms: 0, max: 0, n: 0, inScan };
        ph.ms += ms; ph.n++;
        if (ms > ph.max) ph.max = ms;
    });
    if (inScan) cbCurScan[name] = +ms.toFixed(2);
    return now;
}
function cbCount(name, n, inScan = true) {
    if (!cbPerf) return;
    cbEach(p => { p.counts[name] = (p.counts[name] || 0) + n; });
    if (inScan) cbCurScan["#" + name] = n;
}
function cbRequest(reason) { cbEach(p => { p.requests[reason] = (p.requests[reason] || 0) + 1; }); }

function cbScanDone(t0) {
    if (!cbPerf) return;
    const now = performance.now(), ms = now - t0;
    cbEach(p => {
        p.scans++; p.scanMs += ms;
        if (ms > p.scanMax) p.scanMax = ms;
        if (ms > CB_LONG_SCAN_MS) p.longScans++;
    });
    try { performance.measure("CatBlocker scan", { start: t0, end: now }); } catch {}
    if (ms > CB_LONG_SCAN_MS) {
        // plain text (not an object) so it survives copy/paste and log scrapers
        try { console.log(`[CatBlocker perf] long scan ${ms.toFixed(1)} ms (${cbFrameDesc()}) ${JSON.stringify(cbCurScan)}`); } catch {}
    }
    cbCurScan = {};
}

/* Our own DOM writes (styles, replacements, unlock daemon …) also hit the MutationObserver.
   Pull those records out right after we wrote, so they are counted as "self" — and still
   request a scan exactly like the observer would have (behaviour unchanged).
   Page mutations made in the same task would be counted as "self" too (rare). */
function cbFlushSelf() {
    if (!cbPerf || !observer) return;
    let recs;
    try { recs = observer.takeRecords(); } catch { return; }
    if (!recs.length) return;
    cbEach(p => { p.selfRecords += recs.length; });
    for (const m of recs) if (m.type === "attributes" && m.target.__cbBgChecked) m.target.__cbBgChecked = false;
    if (recs.some(mutationTriggersScan)) scheduleScan("self");
}

function cbPerfSummary(p, label) {
    if (!p) return;
    try {
        const span = performance.now() - p.since;
        const pct = span ? (p.scanMs / span) * 100 : 0;
        console.groupCollapsed(
            `[CatBlocker perf] ${label} · ${cbFrameDesc()} · ${(span / 1000).toFixed(1)} s: ` +
            `${p.scans} scans, ${p.scanMs.toFixed(0)} ms (${pct.toFixed(1)} % of wall time), ` +
            `max ${p.scanMax.toFixed(1)} ms, ${p.longScans} > ${CB_LONG_SCAN_MS} ms, ${p.replaced} cats`
        );
        console.log("scan requests by trigger:", p.requests);
        console.log(`mutations: page ${p.mutationBatches} batches / ${p.mutationRecords} records · own ${p.selfRecords} records`);
        const rows = Object.entries(p.phases)
            .sort((a, b) => b[1].ms - a[1].ms)
            .map(([name, ph]) => ({
                phase: ph.inScan ? name : name + " (outside scan)",
                "total ms": +ph.ms.toFixed(1),
                calls: ph.n,
                "avg ms": +(ph.ms / Math.max(1, ph.n)).toFixed(2),
                "max ms": +ph.max.toFixed(1),
                "% of scan time": ph.inScan && p.scanMs ? +((ph.ms / p.scanMs) * 100).toFixed(1) : ""
            }));
        console.table(rows);
        const avgCounts = {};
        for (const [k, v] of Object.entries(p.counts)) avgCounts[k] = Math.round(v / Math.max(1, p.scans));
        console.log("elements checked per scan (avg):", avgCounts);
        console.groupEnd();
        // one plain-text line with everything (copy/paste friendly; groups/tables don't survive that)
        const isWait = (r) => r.phase.startsWith("wait:");
        const top = rows.filter(r => !isWait(r)).slice(0, 6).map(r => `${r.phase}=${r["total ms"]}ms`).join(", ");
        const w = rows.find(isWait);
        const wait = w ? ` · wait request→scan avg ${w["avg ms"]} / max ${w["max ms"]} ms` : "";
        console.log(`[CatBlocker perf] ${label} detail · ${cbFrameDesc()} · phases: ${top}${wait} · triggers: ${JSON.stringify(p.requests)}` +
            ` · mutations page/own: ${p.mutationRecords}/${p.selfRecords} · elements/scan: ${JSON.stringify(avgCounts)}`);
    } catch {}
}

if (CB_PERF) {
    globalThis.cbPerfReport = () => cbPerfSummary(cbPerf, "since load");
    globalThis.cbPerfReset = () => { cbPerf = cbPerfNew(); cbPerfWin = cbPerfNew(); };
    setInterval(() => {
        if (!alive) return;
        if (cbPerfWin.scans || cbPerfWin.replaced) cbPerfSummary(cbPerfWin, `last ${CB_PERF_INTERVAL_MS / 1000} s`);
        cbPerfWin = cbPerfNew();
        try { performance.clearMeasures("CatBlocker scan"); performance.clearMeasures("CatBlocker replace"); } catch {}
    }, CB_PERF_INTERVAL_MS);
}

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
    /* filled/collapsed ad slots: hide placeholder boxes drawn via pseudo-elements */
    .catblocker-slot::before, .catblocker-slot::after { display: none !important; }

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

/* ================================
   Known ad slots on other sites → replaced with cats
   Network rules usually block the ad itself, so these slots stay EMPTY. To still show a
   cat (instead of an empty or site-hidden box), empty slots get a cat in the slot's
   intended ad size once the page has settled.
   - slot:    the element that is replaced once an ad was rendered into it
   - content: where the ad is rendered inside the slot (default: the slot itself)
   - size:    slot → [w, h] intended ad size, or null (not fillable → collapsed while empty)
   - fillInto: slot → element that receives the cat (default: content, else the slot)
   - wrapper: layout boxes that reserve space for the slot (collapsed if empty and not fillable)
   - hide:    leftovers next to the slot (e.g. "Ad Feedback" links)
   - hosts:   restrict to these sites (default: all)
================================ */
const KNOWN_AD_SLOTS = [
    // G+J / RTL network (n-tv.de, stern.de, rtl.de …): slot type is in the wrapper class
    {
        slot: ".gujAd",
        wrapper: '[class*="Ada_wrapper"]',
        fillInto: (s) => s.closest('[class*="Ada_wrapper"]'),   // empty .gujAd itself is display:none
        size: (s) => {
            const c = String(s.closest('[class*="Ada_wrapper"]')?.className || "");
            if (/Ada_superbanner/.test(c)) return [728, 90];
            if (/Ada_rectangle/.test(c)) return [300, 250];
            if (/Ada_skyscraper/.test(c)) return [300, 600];
            return null;   // teaser / mobile / footer: no fixed size
        }
    },
    // CNN: .ad-slot > .ad#ad_<type>_*, inside header / zone / stack wrappers
    {
        hosts: ["cnn.com"],
        slot: ".ad-slot",
        content: ".ad",
        wrapper: ".ad-slot-header__wrapper, .zone__ads, .container__ads",
        hide: ".ad-slot__feedback, .ad-feedback-link-container",
        size: (s) => {
            const id = s.querySelector(".ad")?.id || "";
            if (/^ad_bnr_/.test(id)) return [728, 90];
            if (/^ad_rect_/.test(id)) return [300, 250];
            return null;   // native slots
        }
    },
    // Fox News: .ad-container.ad-w-300.ad-h-250 > .ad
    // (desktop / desktop-sm variants of the same slot: the site hides the unused one → skipped)
    {
        hosts: ["foxnews.com"],
        slot: ".ad-container",
        content: ".ad",
        size: (s) => {
            const w = +(String(s.className).match(/\bad-w-(\d+)/) || [])[1];
            const h = +(String(s.className).match(/\bad-h-(\d+)/) || [])[1];
            return w && h ? [w, h] : null;
        }
    },
    // BILD: own ad delivery (not blocked by the network rules) → ads render into about:blank
    // iframes inside .ad-wrapper, incl. the fixed left/right "doubleSitebar" (441×911).
    // Replace each rendered iframe, so wrapper labels and sitebar positioning stay intact.
    // Empty wrappers are unused on purpose here (e.g. superbanner during a sitebar) → no fill.
    {
        hosts: ["bild.de"],
        slot: ".ad-wrapper",
        content: "iframe",
        replaceContent: true
    }
];

const SLOT_FILL_DELAY_MS = 2000;   // after window load: give real ads a chance to render first
let slotFillReady = false;

function armSlotFill() {
    if (!knownAdSlotConfigs().length) return;
    const go = () => setTimeout(() => { slotFillReady = true; scheduleScan("slotfill"); }, SLOT_FILL_DELAY_MS);
    if (document.readyState === "complete") go();
    else addEventListener("load", go, { once: true });
}

function knownAdSlotConfigs() {
    const h = location.hostname.replace(/^www\./, "");
    return KNOWN_AD_SLOTS.filter(c => !c.hosts || c.hosts.some(d => h === d || h.endsWith("." + d)));
}

function renderedAdContent(slot, cfg) {
    const els = cfg.content ? Array.from(slot.querySelectorAll(cfg.content)) : [slot];
    return els.filter(e => {
        const r = e.getBoundingClientRect();
        return r.width >= MIN_WIDTH && r.height >= MIN_HEIGHT;
    });
}

function adSlotFilled(slot, cfg) {
    return renderedAdContent(slot, cfg).length > 0;
}

function slotFillSize(slot, cfg) {
    try {
        const s = cfg.size && cfg.size(slot);
        return s && s[0] >= MIN_WIDTH && s[1] >= MIN_HEIGHT ? s : null;
    } catch { return null; }
}

/* A rendered ad → replace the whole slot */
function queueKnownAdSlots() {
    for (const cfg of knownAdSlotConfigs()) {
        document.querySelectorAll(cfg.slot).forEach(el => {
            if (cfg.replaceContent) {
                // replace each rendered ad element, keep the slot (more ads may render later)
                renderedAdContent(el, cfg).forEach(c => {
                    if (c.__catblockerProcessed || c.__cbGateSeen || c.closest(".catblocker-container")) return;
                    c.__cbGateSeen = true;
                    c.__cbExactTarget = true;
                    pendingNodes.add(c);
                });
                return;
            }
            if (el.__catblockerProcessed || el.__cbGateSeen || el.__cbFilled) return;
            if (el.closest(".catblocker-container")) return;
            // slots stay empty until an ad is rendered → only queue once the ad has a size
            if (!adSlotFilled(el, cfg)) return;
            el.__cbGateSeen = true;
            el.__cbExactTarget = true;
            pendingNodes.add(el);
        });
    }
}

/* Still empty after the page settled → put a cat of the intended ad size into the slot */
function fillEmptyAdSlots() {
    if (!slotFillReady) return;
    for (const cfg of knownAdSlotConfigs()) {
        document.querySelectorAll(cfg.slot).forEach(slot => {
            // (__cbGateSeen is not checked: a slot that failed the generic score gate is still a known slot)
            if (slot.__cbFilled || slot.__catblockerProcessed) return;
            if (slot.closest(".catblocker-container")) return;
            if (adSlotFilled(slot, cfg)) return;               // a real ad → queueKnownAdSlots()
            const size = slotFillSize(slot, cfg);
            if (!size) return;
            const into = cfg.fillInto ? cfg.fillInto(slot) : (cfg.content ? slot.querySelector(cfg.content) : slot);
            if (!into) return;

            // hidden slot/wrapper = not meant for this viewport (mobile/tablet variant) → leave it alone
            const host = (cfg.wrapper && slot.closest(cfg.wrapper)) || slot.parentElement || slot;
            if (cfg.wrapper && host.__cbFilledHost) return;    // one cat per wrapper
            if (host.getBoundingClientRect().width < MIN_WIDTH || getComputedStyle(host).display === "none") return;
            if (!cfg.fillInto && getComputedStyle(slot).display === "none") return;
            if (getComputedStyle(into).display === "none") into.style.setProperty("display", "block", "important");

            host.__cbFilledHost = true;
            slot.__cbFilled = true;
            slot.__cbGateSeen = true;
            slot.classList.add("catblocker-slot");             // hides ::before/::after placeholder boxes
            if (cfg.hide) host.querySelectorAll(cfg.hide).forEach(x => setImportant(x, "display", "none"));

            // placeholder in ad size → replaced by a cat through the normal pipeline (IO, badge count)
            const ph = document.createElement("div");
            ph.style.cssText = `display:block !important; width:${size[0]}px !important; max-width:100% !important;` +
                ` height:${size[1]}px !important; margin:0 auto !important;`;
            ph.__cbGateSeen = true;
            ph.__cbExactTarget = true;
            ph.__cbSlotFill = true;
            into.appendChild(ph);
            pendingNodes.add(ph);
        });
    }
}

/* Empty, non-fillable ad slot wrappers reserve space (min-height/padding) → collapse them.
   If an ad still renders later, the slot grows again and is replaced by queueKnownAdSlots(). */
/* Set an inline !important style only if it isn't set already. collapseEmptyAdSlots() runs on
   every scan; re-setting identical styles still produces "style" mutations → our own observer
   requested the next scan → endless self-triggered scans while the page is idle. */
function setImportant(el, prop, value) {
    if (el.style.getPropertyValue(prop) === value && el.style.getPropertyPriority(prop) === "important") return;
    el.style.setProperty(prop, value, "important");
}

function collapseBox(e) {
    if (!e.classList.contains("catblocker-slot")) e.classList.add("catblocker-slot");   // also hides ::before/::after placeholders (see catblocker-style)
    setImportant(e, "min-height", "0px");
    setImportant(e, "padding-top", "0px");
    setImportant(e, "padding-bottom", "0px");
}

function collapseEmptyAdSlots() {
    for (const cfg of knownAdSlotConfigs()) {
        if (!cfg.wrapper) continue;
        document.querySelectorAll(cfg.wrapper).forEach(w => {
            if (w.querySelector(".catblocker-container")) return;
            const slots = Array.from(w.querySelectorAll(cfg.slot));
            // fillable slots get a cat instead (fillEmptyAdSlots)
            if (slots.some(s => s.__cbFilled || adSlotFilled(s, cfg) || slotFillSize(s, cfg))) return;
            collapseBox(w);
            for (const s of slots) {
                for (let e = s; e && e !== w; e = e.parentElement) collapseBox(e);
            }
            if (cfg.hide) w.querySelectorAll(cfg.hide).forEach(x => setImportant(x, "display", "none"));
        });
    }
}

/* Labels inside a video player ("Ad 1 of 1 · 0:15" during a pre-roll) must not
   turn the whole video teaser into an ad unit */
function isInVideoPlayer(el) {
    try {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        for (const v of document.querySelectorAll("video")) {
            const vr = v.getBoundingClientRect();
            if (vr.width && vr.height && x >= vr.left && x <= vr.right && y >= vr.top && y <= vr.bottom) return true;
        }
    } catch {}
    return false;
}

/* "Anzeige"/"Sponsored" label → the ad unit it labels.
   Prefers the enclosing teaser (article/li/card); otherwise walks up until the
   container is clearly bigger than the label, without swallowing whole page sections. */
const AD_LABEL_WORDS = ["sponsored", "promoted", "anzeige", "werbung", "ad", "advertisement", "gesponsert"];
const AD_LABEL_PREFIXES = ["sponsored", "promoted", "anzeige", "werbung", "ad"];   // "Anzeige · …"
const LABEL_CANDIDATE_SEL = "*[aria-label], [data-testid], span, div, a";
const LABEL_TEXT_LIMIT = 24;   // > 20 (max exact label length) and > longest "prefix + space"
const LABEL_SKIP_PARENTS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
// first letters of all label words (s, p, a, w, g) → cheap pre-filter per text node
const LABEL_FIRST_CHARS = new Set(AD_LABEL_WORDS.map(w => w.charCodeAt(0)));

function isLabelText(txt) {
    return (txt.length <= 20 && AD_LABEL_WORDS.includes(txt)) ||
        AD_LABEL_PREFIXES.some(w => txt.startsWith(w + " "));
}

/* Start of el.textContent (trimmed, lowercased), without building the whole string:
   walks the text nodes until LABEL_TEXT_LIMIT non-whitespace-led chars are collected.
   → { txt, complete, first }  (complete: txt is the whole trimmed text; first: first non-empty text node) */
function textStart(el) {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let s = "", first = null;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
        let d = n.data;
        if (!s) { d = d.trimStart(); if (!d) continue; first = n; }
        // cap only against huge nodes (inline scripts …); a short cap could cut off text that
        // follows a run of whitespace ("Anzeige⏎    …    Partner") and fake an exact label
        s += d.length > 4096 ? d.slice(0, 4096) : d;
        // trailing whitespace doesn't count: "Anzeige\n      " is still the complete text "anzeige"
        if (s.length > LABEL_TEXT_LIMIT && s.trimEnd().length > LABEL_TEXT_LIMIT) {
            return { txt: s.toLowerCase(), complete: false, first };
        }
    }
    return { txt: s.trimEnd().toLowerCase(), complete: true, first };
}

/* Label pass: all elements (matching LABEL_CANDIDATE_SEL) whose trimmed textContent is an ad label
   ("Anzeige") or starts with one ("Anzeige · Partner"). Same result as reading textContent of every
   span/div/a, but without the quadratic cost (each wrapper's textContent is its whole subtree's text):
   we look for text nodes that start like a label and only check their ancestors. An ancestor's text
   can only start with the label if the label node is its first non-empty text node; as soon as that
   is not the case any more, no higher ancestor qualifies either. */
function findAdLabelCandidates() {
    const out = [];
    const root = document.body || document.documentElement;
    if (!root) return out;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
        const parent = n.parentElement;
        if (!parent || LABEL_SKIP_PARENTS.has(parent.tagName)) continue;
        const d = n.data;
        // cheap pre-filter: first non-whitespace char (same whitespace as trim()) must start a label word
        const i = d.search(/\S/);
        if (i < 0 || !LABEL_FIRST_CHARS.has(d.charCodeAt(i) | 32)) continue;
        const head = d.slice(i, i + LABEL_TEXT_LIMIT + 1).toLowerCase();
        // the node must start like a label: the bare word (may be continued by the next
        // text node, e.g. <b>Anzeige</b> <span>Partner</span>) or "word …"
        const headTrim = head.trimEnd();
        if (!AD_LABEL_WORDS.some(wd => headTrim === wd || head.startsWith(wd + " "))) continue;

        for (let el = parent; el && el !== root && el !== document.documentElement; el = el.parentElement) {
            const st = textStart(el);
            if (st.first !== n) break;               // an earlier text node leads → no ancestor qualifies
            if (!el.matches(LABEL_CANDIDATE_SEL)) continue;
            // an incomplete start is > 20 chars → only the "word …" prefix rule can match
            if (isLabelText(st.txt)) out.push({ el, txt: st.txt });
        }
    }
    return out;
}

function findLabeledAdContainer(label) {
    const lr = label.getBoundingClientRect();
    if (lr.width === 0 || lr.height === 0 || lr.height > 40) return null;

    const sizeOk = (r) => r.width >= MIN_WIDTH && r.height >= MIN_HEIGHT &&
        r.height <= Math.max(1000, window.innerHeight) && r.width <= window.innerWidth * 0.95;
    // a container holding several teasers is a list/section, not the ad unit
    const multiUnit = (c) => c.querySelectorAll("article").length > 1 ||
        (c.tagName !== "ARTICLE" && c.querySelectorAll("article").length === 1 && !c.querySelector("article").contains(label));

    const unit = label.closest("article, li, .card, .teaser, [class*='Teaser_teaser'], .feed-item, .result");
    if (unit && unit !== label) {
        const r = unit.getBoundingClientRect();
        if (sizeOk(r) && !multiUnit(unit)) return unit;
    }

    let p = label.parentElement;
    for (let depth = 0; p && p !== document.body && depth < 6; depth++, p = p.parentElement) {
        const r = p.getBoundingClientRect();
        if (r.height > Math.max(1000, window.innerHeight) || multiUnit(p)) return null;
        if (sizeOk(r) && r.height >= lr.height * 3) return p;
    }
    return null;
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
    const t = cbT();
    const snapshot = captureScrollPos();
    applyTargetedUnlock();
    addScrollCaptureUnblockers();
    cbPhase("unlock daemon start", t, false);
    // Nach dem Stilwechsel die Scrollpos sofort wiederherstellen
    requestAnimationFrame(() => restoreScrollPos(snapshot));
    unlockTimer = setTimeout(stopUnlockDaemon, durationMs);
}

function stopUnlockDaemon() {
    if (unlockTimer) { clearTimeout(unlockTimer); unlockTimer = null; }
    removeScrollCaptureUnblockers();
    revertTargetedUnlock();
    cbFlushSelf();
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

    // version marker: shows which build is actually running on a page (DevTools: <html data-catblocker>)
    try { if (window === window.top) document.documentElement.setAttribute("data-catblocker", chrome.runtime.getManifest().version); } catch {}

    injectCatblockerStylesOnce();
    injectSiteCosmeticCssOnce();
    if (isYouTubeSite()) startYouTubeAdBlocking();
    startReplacement();
})();

/* ================================
   Core wiring (scan + observe)
================================ */
function mutationTriggersScan(m) {
    return (m.addedNodes && m.addedNodes.length) || m.type === "attributes";
}

function startReplacement() {
    scheduleScan("init");
    armSlotFill();
    document.addEventListener("DOMContentLoaded", () => scheduleScan("domcontentloaded"), { once: true });

    // stylesheets/lazy content are in place now → per-element caches start here (see __cbBgChecked)
    if (document.readyState !== "complete") addEventListener("load", () => scheduleScan("load"), { once: true });

    observer = new MutationObserver((mutations) => {
        cbEach(p => { p.mutationBatches++; p.mutationRecords += mutations.length; });
        let trigger = false;
        for (const m of mutations) {
            // a style/class change may add a background image → check that element again
            if (m.type === "attributes" && m.target.__cbBgChecked) m.target.__cbBgChecked = false;
            if (!trigger && mutationTriggersScan(m)) trigger = true;
        }
        if (trigger) scheduleScan("mutation");
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style","class","id","src","href","srcdoc","sandbox","data-ad","data-advertisement","aria-label"]
    });

    chrome.runtime.onMessage.addListener((msg) => {
        if (!alive) return;
        if (msg?.type === "CATBLOCKER_FORCE_SCAN") scheduleScan("message");
        if (msg?.type === "CATBLOCKER_TOAST" && msg.text) showToast(msg.text);
    });
}

/* Throttled scheduling (avoid scan storms), with a guaranteed trailing scan:
   - at most one scan is pending; further requests are coalesced into it (it sees their changes)
   - a pending scan is never cancelled
   - scans run at least SCAN_MIN_INTERVAL_MS apart (measured from when a scan actually ran)
   The previous version stamped lastScanAt when *scheduling* and cancelled the queued scan on every
   request within 250 ms → on pages that mutate the DOM continuously the scan kept being pushed back
   (amazon.de: 277 requests, 3 scans in 10 s) and it spun a requestAnimationFrame retry every frame. */
const SCAN_MIN_INTERVAL_MS = 250;
let lastScanAt = -Infinity;      // start of the last scan that ran
let scanPendingSince = 0;        // 0 = nothing pending, else time of the first coalesced request

function scheduleScan(reason) {
    if (cbPerf) cbRequest(reason || "?");
    if (scanPendingSince) return;                // coalesced into the pending scan
    const now = performance.now();
    scanPendingSince = now;
    const wait = Math.max(0, lastScanAt + SCAN_MIN_INTERVAL_MS - now);
    // rAF: run right before a frame (layout reads are fresh, no extra forced layout); the timer
    // only enforces the minimum interval
    const go = () => requestAnimationFrame(runScheduledScan);
    if (wait > 0) setTimeout(go, wait); else go();
}

function runScheduledScan() {
    const requestedAt = scanPendingSince;
    scanPendingSince = 0;                        // requests from now on schedule the next scan
    lastScanAt = performance.now();
    cbPhase("wait: request → scan", requestedAt, false);
    scanAndReplace();
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
        if (CB_DEBUG) cbLog("io:", entries.length, "entries,", visible.length, "visible", visible.map(cbDesc));
        cbCount("io entries (outside scan)", entries.length, false);
        if (visible.length) processBatch(visible);
    }, { root: null, rootMargin: "200px 0px", threshold: 0.01 });
}

function processBatch(nodes) {
    cbLog("processBatch", nodes?.length, "alive=", alive, "totalReplaced=", totalReplaced);
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
/* Ad/tracker domain RegExp, rebuilt only when the settings object changes (not per candidate) */
let _domainRe = null, _domainReFor = null;
function currentDomainRe() {
    if (_domainRe && _domainReFor === settings) return _domainRe;
    _domainReFor = settings;
    _domainRe = (typeof buildDomainRegexFromSettings === "function")
        ? buildDomainRegexFromSettings(settings)
        : /(doubleclick|googlesyndication|adservice|adnxs|taboola|outbrain|revcontent|adsystem|adroll|criteo|adtng|trafficjunky)/i;
    return _domainRe;
}

async function scanAndReplace() {
    if (scanBusy) return;
    scanBusy = true;
    if (!alive) { scanBusy = false; return; }
    ensureIO();
    const tScan = cbT();
    let t = tScan;
    cbCurScan = {};

    // Build dynamic domain tools from settings (provided by common.js)
    const DOMAIN_RE = currentDomainRe();

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
    t = cbPhase("setup", t);

    try { detectAndHideInterstitials(DOMAIN_RE, adIframeSelector); } catch {}
    t = cbPhase("interstitials", t);

    // YOUTUBE: feed/sidebar ads are hidden via CSS (startYouTubeAdBlocking), video ads are
    // pruned/skipped. Here we only check the skipper on DOM changes for a faster reaction.
    if (isYouTubeSite()) {
        try { ytSkipVideoAd(); } catch {}
    }
    // YouTube: ads are hidden via CSS → count them for the badge
    try { countSiteCosmeticHits(); } catch {}
    t = cbPhase("youtube + cosmetic count", t);

    // REDDIT: known ad elements are replaced with cats
    if (isRedditSite()) {
        try { queueRedditAds(); } catch {}
        t = cbPhase("reddit", t);
    }

    // Known ad slots (G+J / RTL …): replace filled slots, collapse empty ones
    if (!isYouTubeSite()) {
        try { queueKnownAdSlots(); } catch {}
        try { fillEmptyAdSlots(); } catch {}
        try { collapseEmptyAdSlots(); } catch {}
        t = cbPhase("known ad slots", t);
    }

    // 1) iframe-based ads (dynamic selector)
    try {
        const adIframes = document.querySelectorAll(adIframeSelector);
        cbCount("iframes (ad src)", adIframes.length);
        adIframes.forEach(el => {
            if (el.__catblockerProcessed || el.__cbGateSeen) return;   // already scored
            if (el.closest('.catblocker-container, .catblocker-dismissed')) return;
            if (inExcludedArea(el)) return;
            // invisible/tiny iframes (sync/tracking frames, not yet rendered slots) would become
            // a min-size 100×80 cat → skip; they are re-checked on later scans once they grow
            const r = el.getBoundingClientRect();
            if (r.width < MIN_WIDTH || r.height < MIN_HEIGHT) return;
            if (isLikelyInterstitial(el)) { neutralizeOverlay(el); return; }
            markCandidate(el);
        });
    } catch {}
    t = cbPhase("iframes (ad src)", t);

    try {
        const blankIframes = document.querySelectorAll('iframe:not([src]), iframe[src=""], iframe[src^="about:blank"], iframe[srcdoc]');
        cbCount("iframes (blank/srcdoc)", blankIframes.length);
        blankIframes.forEach(el => {
                if (el.__catblockerProcessed || el.__cbGateSeen) return;   // already scored
                if (el.closest('.catblocker-container, .catblocker-dismissed')) return;
                if (inExcludedArea(el)) return;

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
    t = cbPhase("iframes (blank/srcdoc)", t);


    // 2) background-image ads (use DOMAIN_RE)
    try {
        // Checked elements are remembered (__cbBgChecked) once the page has loaded (before that,
        // stylesheets may still be missing). Style/class changes reset the mark (MutationObserver).
        const settled = document.readyState === "complete";
        const bgCandidates = document.querySelectorAll("div, section, aside, a");
        cbCount("background images", bgCandidates.length);
        for (const el of bgCandidates) {
            if (el.__catblockerProcessed || el.__cbBgChecked) continue;

            // cheap test first: almost all elements have no background image
            const bgImg = getComputedStyle(el).backgroundImage || "";
            if (!bgImg || bgImg === 'none' || !DOMAIN_RE.test(bgImg.toLowerCase())) {
                if (settled) el.__cbBgChecked = true;
                continue;
            }
            if (el.closest('.catblocker-container, .catblocker-dismissed') ||
                inHeaderArea(el) || inGenericUiArea(el) || isYouTubePlayerSubtree(el) ||
                (isYouTubeSite() && isInYouTubeUi(el))) {
                if (settled) el.__cbBgChecked = true;
                continue;
            }
            const r = el.getBoundingClientRect();
            if (r.width >= 160 && r.height >= 90) {        // smaller ones: re-checked once they grow
                if (settled) el.__cbBgChecked = true;
                if (isLikelyInterstitial(el)) { neutralizeOverlay(el); continue; }
                markCandidate(el);
            }
        }
    } catch {}
    t = cbPhase("background images", t);

    // 3) sponsored / advert labels → replace container (not YT UI/core)
    try {
        const labelCandidates = findAdLabelCandidates();
        cbCount("labels (text)", labelCandidates.length);
        // A label is "done" (__cbLabelDone = its text) once its outcome is final: excluded area, or
        // its ad unit was found (queued or already scored). Labels without a unit yet (not rendered,
        // overlapping a video) are re-checked on later scans. Only cached after load (layout settled).
        const settled = document.readyState === "complete";
        const done = (el, txt) => { if (settled) el.__cbLabelDone = txt; };
        labelCandidates.forEach(({ el, txt }) => {
            if (el.__catblockerProcessed || el.__cbLabelDone === txt) return;
            if (inHeaderArea(el) || inGenericUiArea(el) || isInComments(el) ||
                (isYouTubeSite() && isInYouTubeUi(el))) { done(el, txt); return; }

            // Exact label ("Anzeige", "Sponsored", …): the label itself is the signal →
            // replace the labelled unit directly, without the score gate
            if (txt.length <= 20 && AD_LABEL_WORDS.includes(txt)) {
                if (isRedditSite() && isInRedditAd(el)) { done(el, txt); return; }
                if (isInVideoPlayer(el)) return;
                const unit = findLabeledAdContainer(el);
                if (!unit) return;
                done(el, txt);
                if (!unit.__catblockerProcessed && !unit.__cbGateSeen &&
                    !unit.closest(".catblocker-container") &&
                    !inHeaderArea(unit) && !inGenericUiArea(unit) && !__cb_hasSafeExclusion(unit)) {
                    unit.__cbGateSeen = true;
                    unit.__cbExactTarget = true;
                    pendingNodes.add(unit);
                }
                return;
            }

            if (AD_LABEL_PREFIXES.some(w => txt.startsWith(w + " "))) {
                if (isInVideoPlayer(el)) return;
                const container = el.closest("article, li, ytd-rich-item-renderer, ytd-video-renderer, .feed-item, .card, .result, section, div");
                if (!container) return;
                if (container.__catblockerProcessed || inHeaderArea(container) || inGenericUiArea(container) ||
                    (isYouTubeSite() && isInYouTubeUi(container))) { done(el, txt); return; }
                if (isLikelyInterstitial(container)) { neutralizeOverlay(container); done(el, txt); return; }
                markCandidate(container);
                // container got scored (markCandidate skips scoring once MAX_PER_PAGE is reached)
                if (container.__cbGateSeen) done(el, txt);
            }
        });
    } catch {}
    t = cbPhase("labels (text)", t);

    // 4) generic selectors (from settings intensity)
    try {
        const selectors = chooseSelectors(settings.intensity);
        if (selectors && selectors.length) {
            const genericNodes = document.querySelectorAll(selectors.join(","));
            cbCount("generic selectors", genericNodes.length);
            genericNodes.forEach(node => {
                if (node.__catblockerProcessed || node.__cbGateSeen) return;   // already scored
                if (node.closest('.catblocker-container')) return;
                if (inExcludedArea(node)) return;

                const r = node.getBoundingClientRect();
                if (r.width < MIN_WIDTH || r.height < MIN_HEIGHT) return;
                if (isLikelyInterstitial(node)) { neutralizeOverlay(node); return; }
                markCandidate(node);
            });
        }
    } catch {}
    t = cbPhase("generic selectors", t);

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
    t = cbPhase("videos", t);

    // 2.5) winzige Tracking-Pixel (<img>)
    try {
        const tinyImgs = document.querySelectorAll("img[src]");
        cbCount("tracking pixels", tinyImgs.length);
        for (const img of tinyImgs) {
            if (img.__catblockerProcessed) continue;
            const rawSrc = img.getAttribute("src") || "";
            if (img.__cbCleanSrc === rawSrc) continue;      // src already known as no tracker
            const src = rawSrc.toLowerCase();
            // URL test first (cheap, no layout); size only for tracker-like URLs
            if (!(DOMAIN_RE.test(src) || /pixel|beacon|track|deep_pixel/.test(src))) {
                img.__cbCleanSrc = rawSrc;
                continue;
            }
            const w = (img.width || img.naturalWidth || 0);
            const h = (img.height || img.naturalHeight || 0);
            if (w <= 2 && h <= 2) hideNode(img); // nicht ersetzen, nur unsichtbar machen
        }
    } catch {}
    t = cbPhase("tracking pixels", t);


    // send candidates to IO (visible-only processing)
    if (CB_DEBUG && pendingNodes.size) cbLog("scan: queue", pendingNodes.size, Array.from(pendingNodes).map(cbDesc));
    cbCount("queued candidates", pendingNodes.size);
    for (const el of pendingNodes) {
        try { io.observe(el); } catch (e) { cbLog("io.observe failed", cbDesc(el), e); }
    }
    pendingNodes.clear();
    cbPhase("queue → IO", t);
    cbScanDone(tScan);
    cbFlushSelf();

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
    // known ad slot that already got its cat (fillEmptyAdSlots) or was collapsed
    if (el.closest(".catblocker-slot") || el.querySelector(".catblocker-slot")) { el.__cbGateSeen = true; return; }

    // Safe exclusions first
    if (__cb_hasSafeExclusion(el)) { el.__cbGateSeen = true; return; }

    const DOMAIN_RE = currentDomainRe();
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
        if (!alive || node.__catblockerProcessed) { cbLog("replace: skip (alive/processed)", alive, cbDesc(node)); return; }
        // already removed, e.g. its ancestor was replaced with a cat first
        if (!node.isConnected) { node.__catblockerProcessed = true; cbLog("replace: skip (disconnected)", cbDesc(node)); return; }

        // never replace interstitials (we neutralize instead)
        if (!force && isLikelyInterstitial(node)) {
            neutralizeOverlay(node);
            if (!window.__CATBLOCKER_SAFE_MODE__) startUnlockDaemon(3000);
            return;
        }

        node.__catblockerProcessed = true;

        let catUrl = "";
        try { catUrl = await pickCatSrc(); } catch (e) { cbLog("replace: pickCatSrc failed", e); return; }
        if (!alive) { cbLog("replace: not alive after pickCatSrc"); return; }
        const tReplace = cbT();

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
        // cat in an empty ad slot: centered like the ad would be
        if (node.__cbSlotFill) container.style.setProperty("margin", "0 auto", "important");

        scrubSiblingAnchors(container, currentDomainRe());


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
        if (cbPerf) {
            cbPhase("replace (per cat)", tReplace, false);
            cbEach(p => { p.replaced++; });
            try { performance.measure("CatBlocker replace", { start: tReplace, end: performance.now() }); } catch {}
            cbFlushSelf();
        }
        if (CB_DEBUG) cbLog("replace: done", cbDesc(node));
    } catch (e) { cbLog("replace: error", cbDesc(node), e); /* swallow node errors */ }
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
/* Header/nav/UI/YouTube-UI exclusion, cached per element once the page has loaded
   (an element practically never moves into or out of the header later; before load it might). */
function inExcludedArea(el) {
    if (el.__cbExcluded !== undefined) return el.__cbExcluded;
    const v = inHeaderArea(el) || inGenericUiArea(el) || isYouTubePlayerSubtree(el) ||
        (isYouTubeSite() && isInYouTubeUi(el));
    if (document.readyState === "complete") el.__cbExcluded = v;
    return v;
}
function hideNode(node) {
    try {
        node.__catblockerProcessed = true;
        node.style.setProperty("display", "none", "important");
        node.style.setProperty("visibility", "hidden", "important");
        node.style.setProperty("opacity", "0", "important");
    } catch {}
}
