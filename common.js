// common.js — shared utilities for CatBlocker
// Exposes globals used by content scripts and options/service worker.

/* ================================
   Defaults & Settings helpers
================================ */
const DEFAULT_SETTINGS = {
    enabled: true,
    intensity: "aggressive",           // "gentle" (aka conservative) | "balanced" | "aggressive"
    whitelist: [],
    cmpBypassSourcepoint: false,
    customBlocklistDomains: [
        "adtago.s3.amazonaws.com",
        "analyticsengine.s3.amazonaws.com",
        "analytics.s3.amazonaws.com",
        "advice-ads.s3.amazonaws.com"
    ],
    // Category toggles (network-level blocking; service_worker builds rules)
    categories: {
        ads: true,
        analytics: false,
        social: false,
        errorTrackers: false,
        oems: false,
        mix: false
    },
    // Per-host overrides
    allowDomains: ["extmaps-api.yandex.net"],  // e.g., allow Yandex maps API
    blockDomains: [],   // e.g., explicitly block a noisy host
    // UI
    showDismiss: true,   // show “×” on placeholders
    theme: "light"
};

// Merge current settings with defaults
function getSettings() {
    return new Promise((resolve) => {
        try {
            chrome.storage.sync.get({ settings: DEFAULT_SETTINGS }, ({ settings }) => {
                resolve({ ...DEFAULT_SETTINGS, ...(settings || {}) });
            });
        } catch {
            resolve({ ...DEFAULT_SETTINGS });
        }
    });
}

// Persist settings (full replacement)
function saveSettings(next) {
    return new Promise((resolve) => {
        try {
            chrome.storage.sync.set({ settings: { ...DEFAULT_SETTINGS, ...(next || {}) } }, resolve);
        } catch {
            resolve();
        }
    });
}

/* ================================
   Domain & selector helpers
================================ */
function hostnameOf(url) {
    try {
        const u = new URL(url, location.href);
        return u.hostname.replace(/^www\./, "");
    } catch {
        return location.hostname.replace(/^www\./, "");
    }
}

// Escape string for safe use in RegExp literal
function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a case-insensitive RegExp that matches any known ad/tracker domain.
 * Includes built-ins + user-defined customBlocklistDomains.
 */
function buildDomainRegexFromSettings(settings) {
    const base = [
        "doubleclick",
        "googlesyndication",
        "adservice",
        "adnxs",
        "taboola",
        "outbrain",
        "revcontent",
        "adsystem",
        "adroll",
        "criteo",
        "adtng",
        "trafficjunky",
        // modest expansion of common ad/tracker vendors
        "adform",
        "rubicon",
        "pubmatic",
        "smartadserver",
        "teads",
        "moatads"

    ];
    const extras = (settings?.customBlocklistDomains || []).map(escapeRe);
    const all = base.concat(extras).filter(Boolean);
    const pattern = all.length ? "(" + all.join("|") + ")" : "$^";
    return new RegExp(pattern, "i");
}

/**
 * Build a CSS selector that targets iframes whose src contains known ad domains
 * (includes customBlocklistDomains).
 */
function buildIframeSelectorFromSettings(settings) {
    const base = [
        `iframe[src*="doubleclick"]`,
        `iframe[src*="googlesyndication"]`,
        `iframe[src*="adservice"]`,
        `iframe[src*="adnxs"]`,
        `iframe[src*="taboola"]`,
        `iframe[src*="outbrain"]`,
        `iframe[src*="revcontent"]`,
        `iframe[src*="criteo"]`,
        `iframe[src*="adroll"]`,
        `iframe[src*="adform"]`,
        `iframe[src*="rubicon"]`,
        `iframe[src*="pubmatic"]`,
        `iframe[src*="smartadserver"]`,
        `iframe[src*="teads"]`,
        `iframe[src*="moatads"]`,
        `iframe[id*="ad"]`,
        `iframe[name*="ad"]`,
        `iframe[src*="adtng"]`,
        `iframe[src*="trafficjunky"]`,
    ];
    const extras = (settings?.customBlocklistDomains || [])
        .filter(Boolean)
        .map(d => `iframe[src*="${d}"]`);
    return base.concat(extras).join(",");
}

/**
 * Return a set of CSS selectors by intensity.
 */
function chooseSelectors(intensity = "balanced") {
    const conservative = [
        '[id^="ad_"]',
        '[class*=" ad-"]',
        '[class^="ad-"]',
        '[class*="-ad "]',
        '[class$="-ad"]',
        '[data-ad="true"]',
        '[data-adslot]',
        '[data-ad-unit]',
        '[data-adname]',
        '[data-testid="ad"]',
        '.OUTBRAIN',
        '.ob-widget',
        '.taboola',
        '.google-auto-placed',
        '.adsbygoogle'
    ];

    const balanced = conservative.concat([
        '.ad, .ads, .advert, .advertisement',
        '.ad-container, .ad-slot, .ad-unit, .ad__slot',
        '.sponsored, .promoted',
        '.sponsor, .sponsored-content',
        '.banner, .leaderboard, .billboard, .mpu, .rectangle, .skyscraper',
        '.promoted-link, .promoted-item, .promoted-post'
    ]);

    const aggressive = balanced.concat([
        'section[id*="ad"]',
        'aside[id*="ad"]',
        'div[id*="ad-"], div[id*="-ad"]',
        'div[class*="sponsor"]',
        '[aria-label*="advert"]',
        '[aria-label*="Anzeige"]',
        '[aria-label*="Werbung"]',
        '[aria-label*="sponsored"]',
        '[data-ad-provider]',
        '[data-google-query-id]',
        '[data-native-ad]',
        '[data-sponsor]',
        '[data-sponsored]',
        '[class*="native-ad"]',
        '[class*="promoted"]',
        '[class*="sponsor"]',
        '.gpt-ad', '.dfp-ad'
    ]);

    // Backward compatibility: "gentle" maps to "conservative"
    if (intensity === "gentle" || intensity === "conservative") return conservative;
    if (intensity === "aggressive") return aggressive;
    return balanced;
}

/* ================================
   Cat image provider (local /cats folder)
================================ */
const CATS = Array.from({ length: 81 }, (_, i) => `cat${i + 1}.jpg`);

// Simple recent-history to avoid immediate repeats across calls
const __recentCats = [];
const __recentMax = 5;
const __preloadCache = new Map(); // url -> Image

function __preload(url) {
    try {
        if (!url || __preloadCache.has(url)) return;
        const img = new Image();
        img.decoding = "async";
        img.loading = "eager";
        img.src = url;
        __preloadCache.set(url, img);
        // best-effort: drop cache entry after some time to free memory
        setTimeout(() => { try { __preloadCache.delete(url); } catch {} }, 30000);
    } catch {}
}

async function pickCatSrc() {
    if (!CATS.length) return chrome.runtime.getURL("cats/placeholder.png");

    // Prefer cats not in recent history
    const pool = CATS.slice();
    const notRecent = pool.filter(f => !__recentCats.includes(f));
    const candidates = (notRecent.length ? notRecent : pool);

    const file = candidates[Math.floor(Math.random() * candidates.length)];
    const url = chrome.runtime.getURL("cats/" + file);

    // update recent history
    __recentCats.push(file);
    while (__recentCats.length > __recentMax) __recentCats.shift();

    // opportunistically preload a different next image
    try {
        const nextChoices = CATS.filter(f => f !== file && !__recentCats.includes(f));
        const nextFile = (nextChoices.length ? nextChoices : CATS).find(Boolean);
        if (nextFile) __preload(chrome.runtime.getURL("cats/" + nextFile));
    } catch {}

    return url;
}

/* ================================
   Safe export (for other scripts)
================================ */
try {
    if (typeof window !== "undefined") {
        window.DEFAULT_SETTINGS = window.DEFAULT_SETTINGS || DEFAULT_SETTINGS;
        window.getSettings = window.getSettings || getSettings;
        window.saveSettings = window.saveSettings || saveSettings;

        window.hostnameOf = window.hostnameOf || hostnameOf;
        window.chooseSelectors = window.chooseSelectors || chooseSelectors;
        window.pickCatSrc = window.pickCatSrc || pickCatSrc;

        window.CatBlockerCommons = Object.assign(window.CatBlockerCommons || {}, {
            escapeRe,
            buildDomainRegexFromSettings,
            buildIframeSelectorFromSettings
        });

        if (typeof window.escapeRe === "undefined") window.escapeRe = escapeRe;
        if (typeof window.buildDomainRegexFromSettings === "undefined") window.buildDomainRegexFromSettings = buildDomainRegexFromSettings;
        if (typeof window.buildIframeSelectorFromSettings === "undefined") window.buildIframeSelectorFromSettings = buildIframeSelectorFromSettings;
    }
} catch { /* no-op */ }
