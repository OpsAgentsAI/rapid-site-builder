/* GA4 instrumentation via the shared @opsagentsai/observability web adapter
 * (card BNlDstQX — supersedes the hand-rolled gtag bootstrap from WZtm0jA3;
 * MSApps mandatory baseline #2).
 *
 * The vendored adapter (web/vendor/opsagents-observability/, built dist — see its
 * README) speaks raw canonical gtag under the hood: it loads gtag.js and owns the
 * SINGLE set of global window error/unhandledrejection → GA4 `exception`
 * handlers. No handlers are installed here — duplicating them alongside the
 * adapter's would double-count every exception event (bug viphNQFG).
 *
 * GUARD (card xLnxgQNF — upstream engine bugs, invoicing-dashboard pattern):
 * immediately BEFORE initObservability we install the CANONICAL gtag shim +
 * auto-pageview suppression ourselves, without editing the vendored files.
 * Bug 1 (transmission killer): the vendored engine's fallback shim pushes
 * rest-arg ARRAYS into dataLayer, but gtag.js only processes `arguments`
 * objects — the container loads yet zero hits reach /g/collect. Its ensureGtag()
 * reuses a pre-existing window.gtag, so pre-installing the canonical shim keeps
 * the broken one from ever installing. Bug 2 (double pageview once transmission
 * works): gtag('set', {send_page_view:false}) suppresses the gtag('config')
 * auto-pageview; we then emit exactly ONE explicit page_view through the
 * adapter's track() after init — this vendored build emits no explicit
 * page_view itself, so without ours suppression would mean zero pageviews.
 * When re-vendoring on the upstream fix (opsagents-observability#13), revisit
 * this guard: drop our explicit page_view if the fixed engine emits its own.
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
        // Canonical shim + auto-pageview suppression BEFORE init (guard, card
        // xLnxgQNF — see header). ensureGtag() reuses this window.gtag, so the
        // engine's broken array-pushing shim never installs.
        window.dataLayer = window.dataLayer || [];
        if (!window.gtag) {
          window.gtag = function () { window.dataLayer.push(arguments); };
          window.gtag('js', new Date());
        }
        window.gtag('set', { send_page_view: false });
        core.initObservability({
          appName: 'rapid-site-builder',
          environment: (location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? 'development' : 'production',
          ga4MeasurementId: id,
          adapter: web.createWebAdapter()
        });
        obsTrack = core.track;
        // Exactly ONE page_view (the explicit one): the config auto-pageview is
        // suppressed above and this vendored engine emits no page_view itself.
        core.track('page_view', {
          page_location: location.href,
          page_title: document.title,
          page_referrer: document.referrer
        });
      });
    })
    .catch(function () { /* config unreachable or import failed → no-op, app unaffected */ });
})();
