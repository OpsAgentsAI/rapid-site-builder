// @opsagentsai/observability — optional Firebase Performance Monitoring (card 2/7).
//
// Best-effort: the web adapter calls this only when config.firebaseConfig is present.
// We deliberately load firebase via a *variable* dynamic-import specifier so TypeScript
// types the result as `any` and never tries to resolve the module at build time — the
// package therefore has NO hard dependency on firebase. Consuming apps that want
// Performance Monitoring install `firebase` themselves; everyone else pays nothing and
// a missing module degrades to a silent no-op (the core's fail-safe philosophy).
/** Initialize Firebase Performance if `firebase` is installed in the host app. */
export async function maybeInitFirebasePerformance(config) {
    if (typeof window === 'undefined')
        return;
    if (!config.firebaseConfig)
        return;
    try {
        // Variable specifiers → not statically resolved by tsc (typed `any`).
        const appModuleName = 'firebase/app';
        const perfModuleName = 'firebase/performance';
        const appMod = await import(appModuleName);
        const perfMod = await import(perfModuleName);
        const apps = typeof appMod.getApps === 'function' ? appMod.getApps() : [];
        const app = apps && apps.length > 0
            ? apps[0]
            : appMod.initializeApp(config.firebaseConfig);
        perfMod.getPerformance(app);
    }
    catch (err) {
        if (config.debug) {
            console.warn('[observability:web] Firebase Performance not initialized (firebase not installed?)', err);
        }
    }
}
