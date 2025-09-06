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
    return [...CAT_SELECTORS_BASE];
}

function pickCatSrc() {
    // Choose a bundled cat image
    const idx = Math.floor(Math.random() * 5) + 1; // 1..5
    return chrome.runtime.getURL(`cats/cat${idx}.jpg`);
}
