// common.js
const CAT_SELECTORS_BASE = [
    // common ad containers
    "[id*='ad-']",
    "[id^='ad_']",
    "[class*='ad-']",
    "[class^='ad_']",
    "[class*='advert']",
    "[class*='ads']",
    "[class*='sponsored']",
    "[data-ad]",
    "[data-advertisement]",
    "[data-testid='placementTracking']",
    "iframe[src*='ads']",
    "iframe[id*='ad']",
    "ins.adsbygoogle",
    "div[id^='google_ads']",
    ".ad, .ads, .advert, .advertisement"
];

const CAT_SELECTORS_AGGRESSIVE = [
    // size-based common ad placeholders
    "div[style*='width:300px'][style*='height:250px']",
    "div[style*='width:728px'][style*='height:90px']",
    "div[style*='width:160px'][style*='height:600px']",
    "div[style*='height:250px'][style*='width:300px']"
];

function hostnameOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function chooseSelectors(intensity) {
    if (intensity === "gentle") return CAT_SELECTORS_BASE;
    if (intensity === "aggressive") return [...CAT_SELECTORS_BASE, ...CAT_SELECTORS_AGGRESSIVE];
    // Treat 'balanced' and unknown as base for safety
    return [...CAT_SELECTORS_BASE];
}

// Cache custom URLs per page to avoid repeated storage reads
let __catblockerCustomUrls = null; // null = not loaded, [] = loaded empty

async function pickCatSrc() {
    try {
        if (__catblockerCustomUrls === null) {
            const data = await chrome.storage.sync.get(["customCatUrls"]);
            const arr = Array.isArray(data.customCatUrls) ? data.customCatUrls.filter(u => {
                try { new URL(u); return true; } catch { return false; }
            }) : [];
            __catblockerCustomUrls = arr;
        }
        const bundled = () => {
            const idx = Math.floor(Math.random() * 16) + 1; // 1..16
            return chrome.runtime.getURL(`cats/cat${idx}.jpg`);
        };
        // 70/30 bias towards user-provided URLs if available
        if (__catblockerCustomUrls.length && Math.random() < 0.7) {
            const i = Math.floor(Math.random() * __catblockerCustomUrls.length);
            return __catblockerCustomUrls[i];
        }
        return bundled();
    } catch {
        // Fallback to bundled on any error
        const idx = Math.floor(Math.random() * 16) + 1;
        return chrome.runtime.getURL(`cats/cat${idx}.jpg`);
    }
}
