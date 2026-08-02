// @opsagentsai/observability — shared gtag/GA4 engine (card [Observability 2/7], 0zAVst1m).
//
// The single browser-side GA4 implementation reused by BOTH the web adapter
// (src/web.ts) and the WordPress adapter (src/wordpress.ts, card 4/7 m2R7gyRU).
// Card 4/7's contract is "reuse the /web handler code — do not re-author"; this
// module is that shared handler. It owns: loading the gtag.js script, the dataLayer
// bridge, mapping the core taxonomy onto GA4 events, and the global
// window.onerror + unhandledrejection → GA4 `exception` bridge.
//
// SSR/Node-safe: every entry point guards `typeof window`/`document` so importing or
// initializing the engine outside a browser is a silent no-op (the core's no-op
// safety philosophy), which is also what lets the scaffold seam-test run under Node.
const GTAG_SRC = 'https://www.googletagmanager.com/gtag/js';
function browser() {
    return typeof window === 'undefined' ? null : window;
}
/** True once we have injected the script tag for a given measurement id. */
const loadedIds = new Set();
/**
 * Ensure the gtag.js script + dataLayer shim exist and gtag('config', id) has run.
 * Idempotent per measurement id. No-op (returns null) outside a browser.
 */
function ensureGtag(win, measurementId, debugMode) {
    if (typeof document === 'undefined')
        return null;
    // dataLayer shim — gtag() queues into dataLayer until/while the script loads, so
    // events fired immediately after config still arrive once gtag.js is ready.
    if (!win.gtag) {
        win.dataLayer = win.dataLayer || [];
        const gtag = function gtagShim(...args) {
            win.dataLayer.push(args);
        };
        win.gtag = gtag;
        gtag('js', new Date());
    }
    if (!loadedIds.has(measurementId)) {
        // Inject the loader script once per id (skip if the page already has it).
        const already = document.querySelector(`script[src^="${GTAG_SRC}?id=${measurementId}"]`);
        if (!already) {
            const s = document.createElement('script');
            s.async = true;
            s.src = `${GTAG_SRC}?id=${encodeURIComponent(measurementId)}`;
            const first = document.getElementsByTagName('script')[0];
            if (first && first.parentNode)
                first.parentNode.insertBefore(s, first);
            else
                (document.head || document.documentElement).appendChild(s);
        }
        // debug_mode surfaces events in GA4 DebugView (the card's acceptance surface).
        win.gtag('config', measurementId, debugMode ? { debug_mode: true } : {});
        loadedIds.add(measurementId);
    }
    return win.gtag;
}
/** Map a captured error onto GA4's `description`/`fatal` exception params. */
function describeError(error) {
    if (error instanceof Error)
        return error.stack || error.message || String(error);
    if (typeof error === 'string')
        return error;
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}
/**
 * The browser-side GA4 engine. One instance per adapter; holds the measurement id,
 * the resolved gtag fn, and the global error handlers it installed (so they can be
 * removed on teardown — important for HMR/tests).
 */
export class GtagEngine {
    measurementId;
    debug;
    gtag = null;
    onError;
    onRejection;
    constructor(config) {
        this.measurementId = config.ga4MeasurementId;
        this.debug = config.debug ?? false;
    }
    /** Initialize gtag + install global handlers. Safe/no-op outside a browser. */
    init() {
        const win = browser();
        if (!win)
            return;
        if (!this.measurementId) {
            if (this.debug)
                console.warn('[observability:gtag] no ga4MeasurementId — events will not be sent');
            return;
        }
        this.gtag = ensureGtag(win, this.measurementId, this.debug);
        this.installGlobalHandlers(win);
    }
    /** page_view / conversion / custom event → gtag('event', name, params). */
    track(eventName, params) {
        if (!this.gtag)
            return;
        this.gtag('event', eventName, sanitize(params));
    }
    /** captureException → a GA4 `exception` event ({ description, fatal }). */
    captureException(error, context) {
        if (!this.gtag)
            return;
        const { fatal, ...rest } = context ?? {};
        this.gtag('event', 'exception', {
            description: describeError(error),
            fatal: fatal ?? false,
            ...sanitize(rest),
        });
    }
    /** setUser → gtag user_id + user_properties (null clears). */
    setUser(id, props) {
        if (!this.gtag)
            return;
        this.gtag('set', { user_id: id ?? undefined });
        if (props && Object.keys(props).length > 0) {
            this.gtag('set', 'user_properties', sanitize(props));
        }
    }
    /** Remove the installed global handlers (HMR / test teardown). */
    teardown() {
        const win = browser();
        if (!win)
            return;
        if (this.onError)
            win.removeEventListener('error', this.onError);
        if (this.onRejection)
            win.removeEventListener('unhandledrejection', this.onRejection);
        this.onError = undefined;
        this.onRejection = undefined;
    }
    /**
     * window.onerror + unhandledrejection → GA4 `exception` events. Uncaught errors are
     * fatal:false (the page survived the handler) — a true page-killing crash is rare in
     * the browser; GA4 has no separate crash channel, so `exception` is the canonical
     * web analog per the mandatory-baseline rule.
     */
    installGlobalHandlers(win) {
        if (this.onError)
            return; // already installed
        this.onError = (ev) => {
            this.captureException(ev.error ?? ev.message, { fatal: false });
        };
        this.onRejection = (ev) => {
            this.captureException(ev.reason, { fatal: false });
        };
        win.addEventListener('error', this.onError);
        win.addEventListener('unhandledrejection', this.onRejection);
    }
}
/** Drop undefined/null values so GA4 doesn't receive empty params. */
function sanitize(params) {
    const out = {};
    if (!params)
        return out;
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null)
            out[k] = v;
    }
    return out;
}
/** Test-only: forget which measurement ids have been injected. */
export function __resetGtagEngine() {
    loadedIds.clear();
}
