/* Rapid Site Builder - analytics bootstrap.
 *
 * TWO systems, deliberately side by side (reconciliation merge, card xe1q8uHa):
 *
 * 1. GA4 via the shared @opsagentsai/observability web adapter (card BNlDstQX -
 *    supersedes the hand-rolled gtag bootstrap from WZtm0jA3; MSApps mandatory
 *    baseline #2). The vendored adapter (web/vendor/opsagents-observability/,
 *    built dist - see its README) speaks raw canonical gtag under the hood: it
 *    loads gtag.js and owns the SINGLE set of global error/unhandledrejection
 *    handlers. No handlers are installed here - duplicating them alongside the
 *    adapter's would double-count every exception event (bug viphNQFG).
 *    GUARD (card xLnxgQNF): immediately BEFORE initObservability we install the
 *    CANONICAL gtag shim + auto-pageview suppression ourselves, without editing
 *    the vendored files (the fallback shim pushes rest-arg ARRAYS that gtag.js
 *    never processes; its ensureGtag() reuses a pre-existing window.gtag).
 *    window.rsbTrack(event, params) routes through the adapter's track().
 *    The GA4 Measurement ID is NOT hardcoded - it comes from GET
 *    /api/client-config (server reads process.env.GA4_MEASUREMENT_ID).
 *
 * 2. PostHog bootstrap (card u4xmePAo). The page holds NO key. It asks
 *    /api/analytics-config and loads the PostHog snippet only inside the
 *    enabled branch, so an unbound deployment - every deployment until the
 *    operator binds POSTHOG_PROJECT_KEY - makes no network call to PostHog at
 *    all and logs nothing to the console. window.rsbCapture(event, props).
 *
 * Both are complete no-ops when unconfigured (judge clone, local dev): nothing
 * is imported, no script loads, and rsbTrack()/rsbCapture() silently do
 * nothing. Analytics never blocks the app and the public repo carries no IDs.
 */
(function () {
  'use strict';

  // ── PostHog (u4xmePAo) ───────────────────────────────────────────────
  // Queue-then-flush: pages can call rsbCapture() before (or without) the
  // config round trip, and events are simply dropped if analytics never turns
  // on. A caller must never need to know whether PostHog loaded.
  var pending = [];
  window.rsbCapture = function (event, props) {
    if (window.posthog && window.posthog.capture) window.posthog.capture(event, props || {});
    else if (pending.length < 50) pending.push([event, props || {}]);
  };

  function loadPostHog(cfg) {
    // PostHog's own array.js stub: queues calls made before the library
    // finishes loading, so rsbCapture never races the <script>.
    !function (t, e) { var o, n, p, r; e.__SV || (window.posthog = e, e._i = [], e.init = function (i, s, a) { function g(t, e) { var o = e.split("."); 2 == o.length && (t = t[o[0]], e = o[1]), t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))) } } (p = t.createElement("script")).type = "text/javascript", p.async = !0, p.src = s.api_host + "/static/array.js", (r = t.getElementsByTagName("script")[0]).parentNode.insertBefore(p, r); var u = e; for (void 0 !== a ? u = e[a] = [] : a = "posthog", u.people = u.people || [], u.toString = function (t) { var e = "posthog"; return "posthog" !== a && (e += "." + a), t || (e += " (stub)"), e }, u.people.toString = function () { return u.toString(1) + ".people (stub)" }, o = "capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures getActiveMatchingSurveys getSurveys getNextSurveyStep onSessionId".split(" "), n = 0; n < o.length; n++) g(u, o[n]); e._i.push([i, s, a]) }, e.__SV = 1) }(document, window.posthog || []);

    window.posthog.init(cfg.projectKey, {
      api_host: cfg.apiHost,
      // The activation funnel this card exists for needs pageviews and clicks
      // without a per-element wiring project.
      autocapture: true,
      capture_pageview: true,
      // Client error tracking. GA4 already reports `exception` events; these
      // are the stack-bearing twin, and having both is deliberate — GA4
      // answers "how often", PostHog answers "on which session, doing what".
      capture_exceptions: true,
      person_profiles: 'identified_only',
    });

    for (var i = 0; i < pending.length; i++) window.posthog.capture(pending[i][0], pending[i][1]);
    pending = [];
  }

  fetch('/api/analytics-config', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) {
      if (!cfg || !cfg.enabled || !cfg.projectKey) return; // the default state: silent
      loadPostHog(cfg);
    })
    .catch(function () { /* analytics must never break the page */ });

  // ── GA4 observability adapter (BNlDstQX) ─────────────────────────────
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
