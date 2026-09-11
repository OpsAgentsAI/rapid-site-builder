// @opsagentsai/observability — platform-agnostic core (card [Observability 1/7]).
//
// Holds the four-call public API, the event taxonomy, the adapter registry, and a
// no-op fallback so app code is identical across web / native / wordpress and never
// throws when observability is unwired. Platform adapters (cards 2/7–4/7) plug into
// the ObservabilityAdapter seam; this module owns routing + safety, not any backend.
export const EVENT_TAXONOMY = ['page_view', 'conversion', 'exception'];
/**
 * No-op adapter — the default before init() and the fallback if a real adapter
 * fails to initialize. Silent unless config.debug is on, in which case it logs so
 * a developer can see calls are flowing without a backend wired.
 */
function createNoopAdapter(debug = false) {
    const log = (m, x) => {
        if (debug)
            console.warn(`[observability:noop] ${m}`, x ?? '');
    };
    return {
        name: 'noop',
        init: () => log('init (no real adapter selected)'),
        track: (eventName, params) => log(`track ${eventName}`, params),
        captureException: (error, context) => log('captureException', { error, context }),
        setUser: (id, props) => log('setUser', { id, props }),
    };
}
let active = createNoopAdapter();
let initialized = false;
let currentConfig = null;
/**
 * Initialize observability once at app startup. Selects config.adapter when given,
 * else the no-op fallback (platform packages pass their own adapter via config or a
 * thin wrapper). Never throws: an adapter init() failure downgrades to the no-op so
 * the host app keeps running.
 */
export function initObservability(config) {
    currentConfig = config;
    const chosen = config.adapter ?? createNoopAdapter(config.debug);
    const downgrade = (err) => {
        // Fail safe: a broken adapter must never take down the host app.
        active = createNoopAdapter(config.debug);
        if (config.debug)
            console.warn('[observability] adapter init failed; using no-op', err);
    };
    try {
        // init() may be sync (void) or async (Promise<void>). For an async adapter we
        // must NOT mark it active until its init() resolves, and an async rejection must
        // be caught here — otherwise it escapes as an unhandled rejection and the adapter
        // is wrongly treated as active before it finished initializing.
        const result = chosen.init(config);
        if (result && typeof result.then === 'function') {
            result.then(() => {
                active = chosen;
            }).catch(downgrade);
        }
        else {
            active = chosen;
        }
    }
    catch (err) {
        downgrade(err);
    }
    initialized = true;
}
/** Record a taxonomy event (page_view / conversion / exception) or a custom event. */
export function track(eventName, params) {
    active.track(eventName, withMeta(params));
}
/** Capture an error as a non-fatal by default (set context.fatal for crashes). */
export function captureException(error, context) {
    active.captureException(error, context);
    // Mirror onto the taxonomy so a track-only backend still surfaces an `exception`
    // event — but ONLY for adapters that don't natively record exceptions. Web/native/
    // wordpress set capturesExceptions=true, where mirroring would double-count the GA4
    // `exception` event (captureException and track both hit gtag). (card viphNQFG)
    if (!active.capturesExceptions) {
        active.track('exception', withMeta({ description: errorMessage(error), fatal: context?.fatal ?? false }));
    }
}
/** Associate subsequent events with a user id + optional properties (null clears). */
export function setUser(id, props) {
    active.setUser(id, props);
}
/** Test/diagnostic helpers — not part of the app-facing four-call surface. */
export function __getActiveAdapterName() {
    return active.name;
}
export function __isInitialized() {
    return initialized;
}
export function __reset() {
    active = createNoopAdapter();
    initialized = false;
    currentConfig = null;
}
function withMeta(params) {
    if (!currentConfig)
        return { ...params };
    // Core-stamped fields win: caller params must never override app_name/environment,
    // so they spread FIRST and the trusted fields are written last.
    return { ...params, app_name: currentConfig.appName, environment: currentConfig.environment };
}
function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === 'string')
        return error;
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}
export { createNoopAdapter };
