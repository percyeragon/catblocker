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
      pointer-events: none !important;
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

    // Block push notification permission prompts at the page level
    installNotificationBlockerOnce();

    // Clean possible background-image based page ads
    cleanseBackgroundAdsOnce();

    // First scans
    scanAndReplace();
    document.addEventListener("DOMContentLoaded", () => scanAndReplace(), { once: true });

    // SPA navigations: generic and YouTube-specific hooks
    window.addEventListener('yt-navigate-finish', () => scanAndReplace());
    window.addEventListener('yt-page-data-updated', () => scanAndReplace());
    hookHistoryNavigation();

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
   Helpers: protected areas and utilities
--------------------------------------------------------- */
function installNotificationBlockerOnce() {
    try {
        if (document.getElementById('catblocker-notif-shim')) return;
        const s = document.createElement('script');
        s.id = 'catblocker-notif-shim';
        s.textContent = `(()=>{
            try {
              const DENIED_STATUS = { state: 'denied', onchange: null, addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return false; } };
              // Patch Notification.requestPermission to immediately resolve denied
              if (window.Notification && typeof Notification.requestPermission === 'function') {
                const origReq = Notification.requestPermission.bind(Notification);
                Notification.requestPermission = function() {
                  try { const p = Promise.resolve('denied'); p.catch(()=>{}); return p; } catch(e) { return origReq(); }
                };
              }
              // Best-effort: report permission as denied via Permissions API
              if (navigator && navigator.permissions && typeof navigator.permissions.query === 'function') {
                const origQuery = navigator.permissions.query.bind(navigator.permissions);
                navigator.permissions.query = function(descriptor){
                  try {
                    if (descriptor && (descriptor.name === 'notifications' || descriptor.name === 'push')) {
                      return Promise.resolve(DENIED_STATUS);
                    }
                  } catch(e){}
                  return origQuery(descriptor);
                };
              }
            } catch(e){}
        })();`;
        (document.documentElement || document.head || document.body).appendChild(s);
      } catch {}
}
const YT_HEADER_AREAS = "#masthead-container, #masthead, ytd-masthead, tp-yt-app-header, ytd-app #header, ytd-app tp-yt-app-header";

function inHeaderArea(node) {
    try { return !!node.closest(YT_HEADER_AREAS); } catch { return false; }
}

function inGenericUiArea(node) {
    try { return !!node.closest('header, nav, footer, [role="banner"], [data-testid="TopNavBar"]'); } catch { return false; }
}

let __bgCleansed = false;
function cleanseBackgroundAdsOnce() {
    if (__bgCleansed) return;
    __bgCleansed = true;
    try {
        const targets = [document.documentElement, document.body].filter(Boolean);
        for (const t of targets) {
            const cs = getComputedStyle(t);
            const bg = cs.backgroundImage || '';
            if (bg && bg !== 'none') {
                const hint = bg.toLowerCase();
                if (/(?:doubleclick|googlesyndication|adservice|adnxs|taboola|outbrain|revcontent|adsystem|adroll|criteo)/.test(hint)) {
                    t.style.setProperty('background-image', 'none', 'important');
                }
            }
        }
    } catch {}
}

function hookHistoryNavigation() {
    try {
        const fire = () => {
            // Delay a tick to allow DOM to update
            requestAnimationFrame(() => scanAndReplace());
        };
        const origPush = history.pushState;
        const origReplace = history.replaceState;
        history.pushState = function() { const r = origPush.apply(this, arguments); fire(); return r; };
        history.replaceState = function() { const r = origReplace.apply(this, arguments); fire(); return r; };
        window.addEventListener('popstate', fire);
    } catch {}
}

/* ---------------------------------------------------------
   Interstitial (full-screen overlay) detection
--------------------------------------------------------- */
function detectAndHideInterstitials() {
    const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
    const vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
    if (!vw || !vh) return;

    const nodes = Array.from(document.querySelectorAll('div, section, aside, article, [role="dialog"], [role="alertdialog"], iframe'));
    for (const el of nodes) {
        if (!el || el.__catblockerProcessed) continue;
        if (el.closest('.catblocker-container')) continue;
        if (el.closest('#movie_player, .html5-video-player, ytd-player')) continue;
        if (inHeaderArea(el) || inGenericUiArea(el)) continue;
        if (el.closest('#comments, ytd-comments, ytd-comment-thread-renderer, ytd-comment-view-model, ytd-item-section-renderer[section-identifier="comments-entry-point"], .comment, .comments, [role="comments"]')) continue;

        let cs;
        try { cs = getComputedStyle(el); } catch { continue; }
        const pos = (cs.position || '').toLowerCase();
        if (pos !== 'fixed' && pos !== 'absolute') continue;

        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;

        const area = rect.width * rect.height;
        const vpArea = vw * vh;
        const coversViewport = (rect.width >= vw * 0.6 && rect.height >= vh * 0.6) || area >= vpArea * 0.5;
        if (!coversViewport) continue;

        // z-index heuristic
        let zi = parseInt(cs.zIndex, 10);
        if (Number.isNaN(zi)) zi = 0;
        const highZ = zi >= 999 || cs.backdropFilter !== 'none' || (cs.backgroundColor && /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\.(?:[2-9])/.test(cs.backgroundColor));
        if (!(highZ || pos === 'fixed')) continue;

        // Signal checks
        let strong = 0;
        let weak = 0;

        // 1) Iframe with ad-like hints
        try {
            const ifr = el.tagName === 'IFRAME' ? [el] : Array.from(el.querySelectorAll('iframe'));
            for (const f of ifr) {
                const src = (f.getAttribute('src') || '').toLowerCase();
                const idn = (f.getAttribute('id') || '').toLowerCase();
                const nm = (f.getAttribute('name') || '').toLowerCase();
                if (/ad|ads|doubleclick|googlesyndication|adservice|adnxs|taboola|outbrain|revcontent|criteo|adroll/.test(src + ' ' + idn + ' ' + nm)) {
                    strong++;
                    break;
                }
            }
        } catch {}

        // 2) Background image from ad CDN
        try {
            const bg = (cs.backgroundImage || '').toLowerCase();
            if (bg && bg !== 'none' && /(doubleclick|googlesyndication|adservice|adnxs|taboola|outbrain|revcontent|criteo|adroll)/.test(bg)) strong++;
        } catch {}

        // 3) Textual hints
        const text = ((el.textContent || '').trim().toLowerCase()).slice(0, 400);
        if (/(?:werbung|anzeige|sponsored|advert|ad\b|skip|überspringen|continue|weiter|close in|seconds|benachrichtigungen|benachrichtigung|notification|notifications|push)/.test(text)) weak++;

        // 4) Class/id hints for overlays
        const clsid = (el.className ? String(el.className) : '') + ' ' + (el.id || '');
        if (/(overlay|backdrop|modal|interstitial|lightbox)/i.test(clsid)) weak++;

        // Exclusions: common non-ad modals
        if (/(cookie|consent|gdpr|datenschutz)/.test(text)) continue;
        if (/(login|anmelden|sign in|signup|register|newsletter|subscribe)/.test(text) && strong === 0) continue;
        if (/(gallery|lightbox|image-viewer)/.test(clsid) && strong === 0) continue;

        // Decision: hide if we have any strong signal OR sufficient weak signals
        if (strong >= 1 || weak >= 2) {
            hideNode(el);
        }
    }
}

/* ---------------------------------------------------------
   Scan & Replace
--------------------------------------------------------- */
async function scanAndReplace() {
    const selectors = chooseSelectors(settings.intensity);
    const tasks = [];

    // First: detect and hide interstitial overlays that block the page
    try { detectAndHideInterstitials(); } catch {}

    // Handle background-image style ads (elements with big background images typical of ads)
    try {
        const bgCandidates = Array.from(document.querySelectorAll("div, section, aside, a"));
        for (const el of bgCandidates) {
            if (el.__catblockerProcessed) continue;
            if (el.closest('.catblocker-container')) continue;
            if (el.closest('#movie_player, .html5-video-player, ytd-player')) continue;
            if (inHeaderArea(el)) continue;
            if (el.closest('#comments, ytd-comments, ytd-comment-thread-renderer, ytd-comment-view-model, ytd-item-section-renderer[section-identifier="comments-entry-point"], .comment, .comments, [role="comments"]')) continue;
            const cs = getComputedStyle(el);
            const bgImg = cs.backgroundImage || "";
            if (!bgImg || bgImg === 'none') continue;
            // Heuristic: likely ad if the element is at least medium size and the bg url hints ad networks
            const r = el.getBoundingClientRect();
            if (r.width < 120 || r.height < 80) continue;
            const hint = bgImg.toLowerCase();
            if (/(?:doubleclick|googlesyndication|adservice|adnxs|taboola|outbrain|revcontent|adsystem|adroll|criteo)/.test(hint)) {
                tasks.push(replaceNodeWithCat(el));
            }
        }
    } catch {}

    // Heuristic: detect blocks labeled 'Sponsored'/'Anzeige' and replace their nearest container
    try {
        const labelCandidates = Array.from(document.querySelectorAll("*[aria-label], [data-testid], span, div, a"));
        labelCandidates.forEach(el => {
            if (el.__catblockerProcessed) return;
            // Skip anything inside header or known comment areas (YouTube and generic)
            if (inHeaderArea(el) || inGenericUiArea(el)) return;
            if (el.closest("#comments, ytd-comments, ytd-comment-thread-renderer, ytd-comment-view-model, ytd-item-section-renderer[section-identifier='comments-entry-point'], .comment, .comments, [role='comments']")) return;
            const txt = (el.textContent || "").trim().toLowerCase();
            if (!txt) return;
            if (["sponsored","promoted","anzeige","werbung","ad"].some(w => txt === w || txt.startsWith(w+" "))) {
                const container = el.closest("article, li, ytd-rich-item-renderer, ytd-video-renderer, .feed-item, .card, .result, section, div");
                if (container && !container.__catblockerProcessed) {
                    // Also ensure the chosen container is not in header or a comment node
                    if (inHeaderArea(container) || inGenericUiArea(container)) return;
                    if (container.closest("#comments, ytd-comments, ytd-comment-thread-renderer, ytd-comment-view-model, ytd-item-section-renderer[section-identifier='comments-entry-point'], .comment, .comments, [role='comments']")) return;
                    tasks.push(replaceNodeWithCat(container));
                }
            }
        });
    } catch {}

    // Replace ad iframes
    document.querySelectorAll("iframe[src*='ad'], iframe[id*='ad'], iframe[name*='ad']")
        .forEach(el => {
            if (el.__catblockerProcessed) return;
            if (el.closest('#movie_player, .html5-video-player, ytd-player')) return;
            if (inHeaderArea(el) || inGenericUiArea(el)) return;
            if (el.closest('#comments, ytd-comments, ytd-comment-thread-renderer, ytd-comment-view-model, ytd-item-section-renderer[section-identifier="comments-entry-point"], .comment, .comments, [role="comments"]')) return;
            tasks.push(replaceNodeWithCat(el));
        });

    // YouTube specific: overlay and in-feed ads
    try {
        // In-feed and sidebar ad renderers
        document.querySelectorAll("ytd-ad-slot-renderer, ytd-action-companion-ad-renderer, ytd-display-ad-renderer, ytd-promoted-sparkles-web-renderer, ytd-in-feed-ad-layout-renderer, ytd-promoted-video-renderer").forEach(node => {
            if (node.__catblockerProcessed) return;
            if (inHeaderArea(node)) return;
            tasks.push(replaceNodeWithCat(node));
        });
        // Video ad containers and overlays in the player
        document.querySelectorAll(".video-ads, .ytp-ad-player-overlay, .ytp-ad-text, .ytp-ad-overlay-container, .ytp-ad-image-overlay, .ytp-ad-module").forEach(node => {
            if (!node.__catblockerProcessed) hideNode(node);
        });
        // Ad countdown and skip button areas sometimes isolated
        const skipParent = document.querySelector('.ytp-ad-skip-button-container, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
        if (skipParent && !skipParent.__catblockerProcessed) hideNode(skipParent);
    } catch {}

    // Replace ad containers
    document.querySelectorAll(selectors.join(",")).forEach(node => {
        if (node.__catblockerProcessed) return;
        if (node.closest('.catblocker-container')) return;
        // Never replace anything inside YouTube's video player container
        if (node.closest('#movie_player, .html5-video-player, ytd-player')) return;
        // Never replace anything inside headers/nav/footers (generic and YT)
        if (inHeaderArea(node) || inGenericUiArea(node)) return;
        // Never replace anything inside known comment areas
        if (node.closest('#comments, ytd-comments, ytd-comment-thread-renderer, ytd-comment-view-model, ytd-item-section-renderer[section-identifier="comments-entry-point"], .comment, .comments, [role="comments"]')) return;
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

    // If the original node was fixed or sticky, do not replace it with a visible cat,
    // just hide it to avoid persistent on-screen overlays.
    try {
        const cs0 = getComputedStyle(node);
        const pos0 = (cs0.position || "").toLowerCase();
        if (pos0 === "fixed" || pos0 === "sticky") {
            hideNode(node);
            return;
        }
        // Also avoid replacing if any ancestor up to 3 levels is fixed (common for sticky headers/popups)
        let a = node.parentElement, depth = 0;
        while (a && depth < 3) {
            try {
                const pa = (getComputedStyle(a).position || "").toLowerCase();
                if (pa === "fixed") { hideNode(node); return; }
            } catch {}
            a = a.parentElement; depth++;
        }
    } catch {}

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
    pointer-events: none !important;
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

function hideNode(node) {
    try {
        node.__catblockerProcessed = true;
        node.style.setProperty('display', 'none', 'important');
        node.setAttribute('aria-hidden', 'true');
    } catch {}
}
