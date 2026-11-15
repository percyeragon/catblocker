// youtube/yt_main.js — runs in the page's MAIN world on YouTube (registered by service_worker.js).
// Strips ad data out of YouTube's player responses before the player sees it, similar to
// uBlock Origin's "json-prune" / "set" scriptlets. Without ad data, the player schedules no
// pre-/mid-roll ads. Anything that still slips through is skipped by content.js.
(() => {
    "use strict";
    if (window.__catblockerYtMain) return;
    window.__catblockerYtMain = true;

    // Keys inside a player response that carry video ads
    const AD_KEYS = ["adPlacements", "adSlots", "playerAds"];

    function stripAds(obj) {
        let removed = 0;
        if (!obj || typeof obj !== "object") return removed;
        for (const k of AD_KEYS) {
            if (k in obj) { delete obj[k]; removed++; }
        }
        return removed;
    }

    // Handles both a bare player response and wrappers ({ playerResponse }, arrays of parts)
    function prune(data) {
        if (!data || typeof data !== "object") return data;
        let removed = 0;
        try {
            if (Array.isArray(data)) {
                for (const part of data) {
                    if (part && typeof part === "object") {
                        removed += stripAds(part.playerResponse);
                        removed += stripAds(part);
                    }
                }
            } else {
                removed += stripAds(data.playerResponse);
                if (data.playabilityStatus || data.streamingData || data.videoDetails || "playerAds" in data || "adPlacements" in data) {
                    removed += stripAds(data);
                }
            }
        } catch {}
        if (removed) report();
        return data;
    }

    // Tell the isolated content script (for the badge counter); throttled per video
    let lastReport = 0;
    function report() {
        const now = Date.now();
        if (now - lastReport < 1500) return;
        lastReport = now;
        try { window.postMessage({ source: "catblocker-yt", type: "ads-pruned" }, location.origin); } catch {}
    }

    // Keep wrapped functions looking native to page code
    const nativeToString = Function.prototype.toString;
    function cloak(wrapper, original) {
        try {
            Object.defineProperty(wrapper, "toString", {
                value: function toString() { return nativeToString.call(original); },
                configurable: true, writable: true
            });
        } catch {}
        return wrapper;
    }

    // 1) Initial page load: inline <script> assigns window.ytInitialPlayerResponse
    for (const name of ["ytInitialPlayerResponse"]) {
        try {
            let value = prune(window[name]);
            Object.defineProperty(window, name, {
                configurable: true,
                enumerable: true,
                get() { return value; },
                set(v) { value = prune(v); }
            });
        } catch {}
    }

    // 2) SPA navigation / embeds: responses from /youtubei/v1/player etc.
    try {
        const origParse = JSON.parse;
        const wrappedParse = function parse(text, reviver) {
            const out = origParse.call(this, text, reviver);
            if (out && typeof out === "object" && typeof text === "string" &&
                (text.includes('"adPlacements"') || text.includes('"playerAds"') || text.includes('"adSlots"'))) {
                return prune(out);
            }
            return out;
        };
        JSON.parse = cloak(wrappedParse, origParse);
    } catch {}

    try {
        const origJson = Response.prototype.json;
        const wrappedJson = function json() {
            return origJson.call(this).then((data) => {
                try {
                    if (/\/youtubei\/v1\/(player|next|reel)/.test(this.url || "")) return prune(data);
                } catch {}
                return data;
            });
        };
        Response.prototype.json = cloak(wrappedJson, origJson);
    } catch {}
})();
