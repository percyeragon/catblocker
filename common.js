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
    "[class*='promo']",
    "[class*='promoted']",
    "[data-ad]",
    "[data-advertisement]",
    "[aria-label='Ad']",
    "[aria-label='Ads']",
    "[role='advertisement']",
    "[data-testid='placementTracking']",
    "[data-testid='ad']",
    "iframe[src*='ads']",
    "iframe[id*='ad']",
    // Social platforms common ad units
    "[data-testid='placementTracking'], [data-testid='fbfeed_story'], [data-testid='ad_unit']",
    "div[role='complementary'][aria-label*='Sponsored']",
    "div[aria-label='Sponsored']",
    "a[aria-label='Sponsored']",
    // YouTube common ad containers
    "#player-ads",
    ".ytp-ad-module",
    "ytd-ad-slot-renderer",
    "ytd-promoted-sparkles-web-renderer",
    "ytd-in-feed-ad-layout-renderer",
    "ins.adsbygoogle",
    "div[id^='google_ads']",
    ".ad, .ads, .advert, .advertisement, .sponsor, .sponsored, .promoted"
];

const CAT_SELECTORS_AGGRESSIVE = [
    // size-based common ad placeholders (robust, match common IAB sizes in inline styles)
    // Popular rectangles
    "div[style*='width:300px'][style*='height:250px']",
    "div[style*='height:250px'][style*='width:300px']",
    "div[style*='width:336px'][style*='height:280px']",
    "div[style*='height:280px'][style*='width:336px']",
    "div[style*='width:250px'][style*='height:250px']",
    "div[style*='width:200px'][style*='height:200px']",

    // Leaderboards / billboards
    "div[style*='width:728px'][style*='height:90px']",
    "div[style*='height:90px'][style*='width:728px']",
    "div[style*='width:970px'][style*='height:250px']",
    "div[style*='height:250px'][style*='width:970px']",
    "div[style*='width:970px'][style*='height:90px']",
    "div[style*='height:90px'][style*='width:970px']",
    "div[style*='width:980px'][style*='height:120px']",
    "div[style*='height:120px'][style*='width:980px']",

    // Skyscrapers
    "div[style*='width:160px'][style*='height:600px']",
    "div[style*='height:600px'][style*='width:160px']",
    "div[style*='width:120px'][style*='height:600px']",
    "div[style*='height:600px'][style*='width:120px']",
    "div[style*='width:300px'][style*='height:600px']",
    "div[style*='height:600px'][style*='width:300px']",

    // Mobile banners
    "div[style*='width:320px'][style*='height:50px']",
    "div[style*='height:50px'][style*='width:320px']",
    "div[style*='width:320px'][style*='height:100px']",
    "div[style*='height:100px'][style*='width:320px']",
    "div[style*='width:300px'][style*='height:50px']",
    "div[style*='height:50px'][style*='width:300px']",
    "div[style*='width:300px'][style*='height:100px']",
    "div[style*='height:100px'][style*='width:300px']",

    // Legacy banners
    "div[style*='width:468px'][style*='height:60px']",
    "div[style*='height:60px'][style*='width:468px']",
    "div[style*='width:234px'][style*='height:60px']",
    "div[style*='height:60px'][style*='width:234px']",
    "div[style*='width:180px'][style*='height:150px']",
    "div[style*='height:150px'][style*='width:180px']",

    // Variants using min/max- sizes (common in placeholders)
    "div[style*='min-width:300px'][style*='min-height:250px']",
    "div[style*='min-height:250px'][style*='min-width:300px']",

    // Attribute-based wrappers used by ad libraries (broad but ad-typical)
    "[data-google-query-id]",
    "[data-ad-client]",
    "[data-ad-slot]",
    "[data-ad-unit]",
    "[data-testid='ad-slot']",
    "ins[data-ad-client]",
    "ins[data-ad-slot]",
    "div[id^='gpt_unit_']",
    "div[id*='gpt-ad']",
    "div[id^='adngin-']",

    // Also target typical containers with specific sizes
    "ins[style*='width:300px'][style*='height:250px']",
    "ins[style*='width:728px'][style*='height:90px']",
    "aside[style*='width:300px'][style*='height:250px']",
    "section[style*='width:300px'][style*='height:250px']"
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
