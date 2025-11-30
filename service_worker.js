// service_worker.js — CatBlocker

const DEFAULT_SETTINGS = {
    enabled: true,
    intensity: "aggressive",
    whitelist: [],
    cmpBypassSourcepoint: false,
    customBlocklistDomains: [
        "adtago.s3.amazonaws.com",
        "analyticsengine.s3.amazonaws.com",
        "analytics.s3.amazonaws.com",
        "advice-ads.s3.amazonaws.com"
    ],
    // Category toggles (network-level blocking)
    categories: {
        ads: true,
        analytics: false,
        social: false,
        errorTrackers: false,
        oems: false,
        mix: false
    },
    // Per-host overrides
    allowDomains: ["extmaps-api.yandex.net"],
    blockDomains: [],
    overrides: {},
    // UI
    showDismiss: true,
    // UI theme ("light" | "dark" | undefined)
    theme: "light"
};

// Session badge
const session = { replacedCount: 0, lastBadgeUpdate: 0 };

// Pro-Tab-Zähler (nur im RAM)
const perTab = new Map();


// ---- Settings I/O
async function getSettings() {
    return new Promise((resolve) => {
        chrome.storage.sync.get({ settings: DEFAULT_SETTINGS }, ({ settings }) => {
            resolve({ ...DEFAULT_SETTINGS, ...(settings || {}) });
        });
    });
}
async function saveSettings(next) {
    return new Promise((resolve) => {
        chrome.storage.sync.set({ settings: { ...DEFAULT_SETTINGS, ...(next || {}) } }, resolve);
    });
}

// ---- Kategorie-Presets (kuratiert; du kannst jederzeit ergänzen)
const PRESETS = {
    ads: [
        // Google Ads & DoubleClick (vollständig)
        "adservice.google.com",
        "pagead2.googlesyndication.com",
        "pagead2.googleadservices.com",
        "afs.googlesyndication.com",
        "ad.doubleclick.net",
        "m.doubleclick.net",
        "static.doubleclick.net",
        "stats.g.doubleclick.net",
        "mediavisor.doubleclick.net",
        "pagead.l.doubleclick.net",
        "adtng.com",
        "a.adtng.com",
        "trafficjunky.com", "ads.trafficjunky.net",

        // Media.net
        "adservetx.media.net",
        "static.media.net",
        "media.net",

        // S3 gehostete Ads
        "adtago.s3.amazonaws.com",
        "advice-ads.s3.amazonaws.com",
        "analytics.s3.amazonaws.com",
        "analyticsengine.s3.amazonaws.com"
    ],

    analytics: [
        // Google Analytics
        "google-analytics.com",
        "ssl.google-analytics.com",
        "analytics.google.com",
        "click.googleanalytics.com",

        // Hotjar (mehr Endpunkte ergänzt)
        "insights.hotjar.com",
        "script.hotjar.com",
        "events.hotjar.io",
        "identify.hotjar.com",
        "surveys.hotjar.com",
        "adm.hotjar.com",
        // "careers.hotjar.com", // meist unkritisch – optional

        // Mouseflow
        "api.mouseflow.com",
        "gtm.mouseflow.com",
        // optional: CDN/Tools, i. d. R. unkritisch
        // "cdn.mouseflow.com", "cdn-test.mouseflow.com", "tools.mouseflow.com"

        // WordPress Stats
        "stats.wp.com"
    ],

    social: [
        // Meta
        "pixel.facebook.com", "an.facebook.com",

        // X / Twitter
        "static.ads-twitter.com", "ads-api.twitter.com",

        // LinkedIn
        "ads.linkedin.com", "analytics.pointdrive.linkedin.com",

        // Pinterest (ergänzt: log)
        "ads.pinterest.com", "analytics.pinterest.com", "trk.pinterest.com", "log.pinterest.com",

        // Reddit
        "events.reddit.com", "events.redditmedia.com",

        // YouTube Ads
        "ads.youtube.com",

        // TikTok (ergänzt: weitere Regionen/Business)
        "analytics.tiktok.com", "ads.tiktok.com", "ads-api.tiktok.com",
        "business-api.tiktok.com", "log.byteoversea.com",
        "ads-sg.tiktok.com", "analytics-sg.tiktok.com"
    ],

    errorTrackers: [
        // Bugsnag (komplett)
        "notify.bugsnag.com", "sessions.bugsnag.com", "api.bugsnag.com", "app.bugsnag.com",

        // Sentry
        "browser.sentry-cdn.com", "app.getsentry.com"
    ],

    oems: [
        // Samsung/Apple – behutsam, kann First-Party-Funktionen berühren
        "samsungads.com", "smetrics.samsung.com", "nmetrics.samsung.com",
        "metrics.mzstatic.com", "metrics.icloud.com"
    ],

    mix: [
        // Yahoo Ad/Analytics (erweitert)
        "ads.yahoo.com", "adtech.yahooinc.com", "analytics.yahoo.com",
        "partnerads.ysm.yahoo.com",
        // optional weitere Signals – vorsichtig aktivieren:
        // "log.fc.yahoo.com", "analytics.query.yahoo.com", "geo.yahoo.com", "udcm.yahoo.com", "gemini.yahoo.com",

        // Unity Ads (ergänzt)
        "adserver.unityads.unity3d.com", "config.unityads.unity3d.com",
        "auction.unityads.unity3d.com", "webview.unityads.unity3d.com",

        // Yandex reine Ad/Stat-Hosts (Maps/Ext-APIs NICHT)
        "adfstat.yandex.ru", "adfox.yandex.ru"
        // HINWEIS: In deinem Log waren `extmaps-api.yandex.net`/`offerwall.yandex.net` geblockt.
        // `extmaps-api` kann Maps-Funktionen brechen – lieber rauslassen und bei Bedarf per Custom-Blocklist sperren.
    ]
};


// ---- DNR helpers
function ruleIdForString(s) {
    const h = Math.abs([...String(s)].reduce((a, c) => ((a << 5) - a) + c.charCodeAt(0), 0));
    return 10000 + (h % 5000);
}
function buildBlockRule(hostOrFragment) {
    return {
        id: ruleIdForString("BLK:" + hostOrFragment),
        priority: 1,
        action: { type: "block" },
        condition: {
            urlFilter: hostOrFragment,
            resourceTypes: ["script","xmlhttprequest","sub_frame","image","media","font"]
        }
    };
}
function buildAllowRule(hostOrFragment) {
    return {
        id: ruleIdForString("ALW:" + hostOrFragment),
        priority: 10, // must be higher than block to win
        action: { type: "allow" },
        condition: {
            urlFilter: hostOrFragment,
            resourceTypes: ["script","xmlhttprequest","sub_frame","image","media","font"]
        }
    };
}

async function syncDynamicRulesFromSettings(settings) {
    const enabledCats = settings.categories || {};
    const domains = new Set();

    // Kategorien sammeln
    Object.entries(PRESETS).forEach(([key, list]) => {
        if (enabledCats[key]) list.forEach(d => domains.add(d));
    });

    // Custom-Liste hinzufügen (Block)
    (settings.customBlocklistDomains || []).forEach(d => domains.add(d));

    // Explizite Overrides
    const blockList = new Set(settings.blockDomains || []);
    const allowList = new Set(settings.allowDomains || []);
    blockList.forEach(d => domains.add(d));

    const blockRules = [...domains].map(buildBlockRule);
    const allowRules = [...allowList].map(buildAllowRule);
    const desiredRules = blockRules.concat(allowRules);

    try {
        const existing = await chrome.declarativeNetRequest.getDynamicRules();
        const removeIds = existing
            .map(r => r.id)
            .filter(id => id >= 10000 && id < 15000);

        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: removeIds,
            addRules: desiredRules
        });
    } catch (e) {
        // Falls Permission fehlt: still und leise.
    }
}

// ---- Badge
async function setBadgeCount(n, tabId) {
    try {
        const text = n > 0 ? String(n) : "";
        const opts = tabId ? { tabId } : {};
        await chrome.action.setBadgeBackgroundColor({ color: "#5b7fff", ...opts });
        await chrome.action.setBadgeText({ text, ...opts });
    } catch {}
}
function bumpBadge(amount = 1) {
    session.replacedCount += amount;
    const now = Date.now();
    if (now - session.lastBadgeUpdate > 250) {
        setBadgeCount(session.replacedCount);
        session.lastBadgeUpdate = now;
    }
}

// ---- Context Menu
chrome.runtime.onInstalled.addListener(async () => {
    try {
        chrome.contextMenus.create({
            id: "catblocker-block-domain",
            title: "CatBlocker: Block this domain",
            contexts: ["page"]
        });
        chrome.contextMenus.create({
            id: "catblocker-replace-now",
            title: "CatBlocker: Replace ads now",
            contexts: ["page"]
        });
        chrome.contextMenus.create({
            id: "catblocker-toggle-whitelist",
            title: "CatBlocker: Toggle whitelist for this domain",
            contexts: ["page"]
        });
    } catch {}
    const s = await getSettings();
    await syncDynamicRulesFromSettings(s);
});
chrome.runtime.onStartup.addListener(async () => {
    const s = await getSettings();
    await syncDynamicRulesFromSettings(s);
    session.replacedCount = 0;
    setBadgeCount(0);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab?.url) return;
    try {
        const u = new URL(tab.url);
        const domain = u.hostname.replace(/^www\./, "");
        const s = await getSettings();

        if (info.menuItemId === "catblocker-block-domain") {
            const next = { ...s, customBlocklistDomains: Array.from(new Set([...(s.customBlocklistDomains||[]), domain])) };
            await saveSettings(next);
            await syncDynamicRulesFromSettings(next);
            if (tab.id) chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_TOAST", text: `Blocked ${domain}` });
            return;
        }

        if (info.menuItemId === "catblocker-replace-now") {
            if (tab.id) {
                try { await chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_FORCE_SCAN" }); } catch {}
                if (tab.id) chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_TOAST", text: "Scan triggered" });
            }
            return;
        }

        if (info.menuItemId === "catblocker-toggle-whitelist") {
            const set = new Set([...(s.whitelist || [])]);
            const had = set.has(domain);
            if (had) set.delete(domain); else set.add(domain);
            const next = { ...s, whitelist: Array.from(set) };
            await saveSettings(next);
            if (tab.id) {
                chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_TOAST", text: had ? `Removed ${domain} from whitelist` : `Whitelisted ${domain}` });
                try { await chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_FORCE_SCAN" }); } catch {}
            }
            return;
        }
    } catch {}
});

// ---- Storage listener
chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "sync" || !changes.settings) return;
    const s = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    await syncDynamicRulesFromSettings(s);
});

// ---- Messaging
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "CATBLOCKER_GET_SETTINGS") {
        (async () => {
            const s = await getSettings();
            const rawHost = (msg?.hostname || "").toString();
            let host = "";
            try {
                host = rawHost.trim().toLowerCase().replace(/^www\./, "");
            } catch {}

            function resolveEffective(settings, hostname){
                const eff = { ...settings };
                if (!hostname) return eff;
                // Whitelist short-circuit: disabled if whitelisted
                if ((settings.whitelist || []).includes(hostname)) {
                    eff.enabled = false;
                    return eff;
                }
                const ov = (settings.overrides || {})[hostname];
                if (ov && typeof ov === 'object') {
                    if (typeof ov.enabled === 'boolean') eff.enabled = ov.enabled;
                    if (typeof ov.intensity === 'string') eff.intensity = ov.intensity;
                }
                return eff;
            }

            const effective = resolveEffective(s, host);
            sendResponse({ ok: true, settings: s, effective, hostname: host });
        })();
        return true;
    }

    if (msg.type === "CATBLOCKER_ADD_COUNT") {
        const amount = Number(msg.amount) || 0;

        // >>> das hattest du schon (gesamt/session hochzählen)
        // z.B. bumpBadge(amount) oder session.replacedCount += amount;
        if (typeof bumpBadge === "function") {
            bumpBadge(amount);
        } else if (typeof session?.replacedCount === "number") {
            session.replacedCount += amount;
        }

        // >>> NEU: pro aktivem Tab mitzählen
        const tabId = sender?.tab?.id;
        if (tabId) {
            const prev = perTab.get(tabId) || 0;
            perTab.set(tabId, prev + amount);
        }

        sendResponse?.({ ok: true });
        return false;
    }

    // >>> NEU: Popup fragt This page & Insgesamt ab
    if (msg.type === "CATBLOCKER_GET_COUNTS") {
        const tabId = Number(msg.tabId);
        sendResponse({
            ok: true,
            session: perTab.get(tabId) || 0,                // This page (pro Tab)
            global: (session?.replacedCount ?? 0) | 0       // Insgesamt = was du bisher schon gezählt hast
        });
        return true;
    }

    if (msg.type === "CATBLOCKER_SET_SETTINGS") {
        (async () => {
            const cur = await getSettings();
            const next = { ...cur, ...(msg.patch || {}) };
            await saveSettings(next);
            // DNR-Resync via storage listener
            sendResponse({ ok: true });
        })();
        return true;
    }

    if (msg.type === "CATBLOCKER_FORCE_SCAN_ALL_TABS") {
        (async () => {
            const tabs = await chrome.tabs.query({ url: ["http://*/*","https://*/*"] });
            for (const t of tabs) {
                try { chrome.tabs.sendMessage(t.id, { type: "CATBLOCKER_FORCE_SCAN" }); } catch {}
            }
            sendResponse({ ok: true, tabs: tabs.length });
        })();
        return true;
    }
});

// ---- Command optional
chrome.commands?.onCommand.addListener(async (command) => {
    if (command === "toggle-enabled") {
        const s = await getSettings();
        const next = { ...s, enabled: !s.enabled };
        await saveSettings(next);
        if (!next.enabled) { setBadgeCount(0); session.replacedCount = 0; }
        const tabs = await chrome.tabs.query({ url: ["http://*/*","https://*/*"] });
        for (const t of tabs) {
            try { chrome.tabs.sendMessage(t.id, { type: "CATBLOCKER_FORCE_SCAN" }); } catch {}
        }
        return;
    }

    if (command === "replace-now") {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.id) {
                chrome.tabs.sendMessage(tab.id, { type: "CATBLOCKER_FORCE_SCAN" });
            }
        } catch {}
        return;
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "loading") {
        // nur Top-Level-Seiten (chrome:// auslassen)
        if (tab?.url && !tab.url.startsWith("chrome://")) {
            perTab.set(tabId, 0);
        }
    }
});