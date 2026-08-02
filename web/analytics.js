/* GA4 instrumentation via the shared @opsagentsai/observability web adapter
 * (card BNlDstQX — supersedes the hand-rolled gtag bootstrap from WZtm0jA3;
 * MSApps mandatory baseline #2).
 *
 * The vendored adapter (web/vendor/opsagents-observability/, built dist — see its
 * README) speaks raw canonical gtag under the hood: it loads gtag.js, sends the
 * initial page_view via gtag('config', id), and owns the SINGLE set of global
 * window error/unhandledrejection → GA4 `exception` handlers. No handlers are
 * installed here — duplicating them alongside the adapter's would double-count
 * every exception event (bug viphNQFG).
 *
 * window.rsbTrack(event, params) keeps its contract for the key conversion
 * events; it now routes through the adapter's track() (which stamps
 * app_name/environment onto every event).
 *
 * The Measurement ID is NOT hardcoded — it comes from GET /api/client-config
 * (server reads process.env.GA4_MEASUREMENT_ID). When unset (a judge cloning the
 * public repo, or local dev), this is a complete no-op: nothing is imported, no
 * gtag script is loaded and rsbTrack() silently does nothing. So analytics never
 * blocks the app and the public repo carries no tracking ID.
 */
(function () {
  'use strict';

  // rsbTrack is always defined (even before init resolves) so callers never guard.
  var obsTrack = null;
  window.rsbTrack = function (event, params) {
    try { if (obsTrack) obsTrack(event, params || {}); } catch (e) { /* never break the app for analytics */ }
  };

  fetch('/api/client-config', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (cfg) {
      var id = cfg && cfg.ga4Id;
      if (!id) return; // no Measurement ID configured → stay a no-op
      return Promise.all([
        import('/vendor/opsagents-observability/index.js'),
        import('/vendor/opsagents-observability/web.js')
      ]).then(function (mods) {
        var core = mods[0], web = mods[1];
        core.initObservability({
          appName: 'rapid-site-builder',
          environment: (location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? 'development' : 'production',
          ga4MeasurementId: id,
          adapter: web.createWebAdapter()
        });
        obsTrack = core.track;
      });
    })
    .catch(function () { /* config unreachable or import failed → no-op, app unaffected */ });
})();
