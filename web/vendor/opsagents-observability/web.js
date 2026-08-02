// @opsagentsai/observability/web — web adapter (card [Observability 2/7], 0zAVst1m).
//
// GA4 exception events + pageviews + (optional) Firebase Performance + global
// window.onerror/unhandledrejection handlers, all behind the platform-agnostic
// ObservabilityAdapter seam. Works in React / Vite / Remix / static — every browser
// touchpoint is guarded so SSR and Node degrade to a safe no-op (web has NO Crashlytics
// SDK, so GA4 `exception` events are the canonical web analog per the baseline rule).
//
// Usage:
//   import { createWebAdapter } from '@opsagentsai/observability/web';
//   initObservability({ appName: 'leads', environment: 'production',
//                       ga4MeasurementId: 'G-XXXX', adapter: createWebAdapter() });
import { createNoopAdapter } from './core.js';
import { GtagEngine } from './internal/gtag.js';
import { maybeInitFirebasePerformance } from './internal/firebase-performance.js';
/**
 * Build the web adapter. The single initObservability() call wires gtag.js, the GA4
 * taxonomy mapping, the global error handlers, and (when config.firebaseConfig is set
 * and `firebase` is installed) Firebase Performance Monitoring.
 */
export function createWebAdapter() {
    const fallback = createNoopAdapter();
    let engine = null;
    return {
        name: 'web',
        // captureException → GtagEngine emits the GA4 `exception` event itself, so the
        // core must not also mirror it onto track('exception') (double-count). (viphNQFG)
        capturesExceptions: true,
        init(config) {
            // Outside a browser there is nothing to wire — stay a silent no-op (SSR-safe).
            if (typeof window === 'undefined') {
                fallback.init(config);
                return;
            }
            // Re-init must not stack a second set of global error handlers: tear down the
            // previous engine's listeners before creating a new one (HMR/tests). (viphNQFG)
            engine?.teardown();
            engine = new GtagEngine(config);
            engine.init();
            // Optional, best-effort, never blocks init() or throws.
            void maybeInitFirebasePerformance(config);
        },
        track(eventName, params) {
            engine?.track(eventName, params);
        },
        captureException(error, context) {
            engine?.captureException(error, context);
        },
        setUser(id, props) {
            engine?.setUser(id, props);
        },
        teardown() {
            engine?.teardown();
            engine = null;
        },
    };
}
