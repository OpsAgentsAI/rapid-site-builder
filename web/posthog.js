/* PostHog product analytics + client error tracking (card u4xmePAo).
 *
 * Loads posthog-js from the CDN and initializes it with the project key this
 * deployment is configured with, then exposes window.rsbPH(event, params) for
 * the key activation events. Autocapture is ON and capture_exceptions is ON
 * (client-side error tracking).
 *
 * The key is NOT hardcoded — it comes from GET /api/client-config (server reads
 * process.env.POSTHOG_KEY). When unset (a judge cloning the public repo, or
 * local dev) this is a complete no-op: the posthog-js script is not loaded and
 * rsbPH() silently does nothing. So analytics never blocks the app and the
 * public repo carries no tracking key. A personal phx_ key must NEVER be used
 * here — the configured key is a project key (phc_…) for an OpsAgents project.
 *
 * Ingest is reverse-proxied: api_host is a SAME-ORIGIN opaque path (/rp) that
 * the Express server forwards to PostHog, so ad-blockers that block the PostHog
 * domain don't drop our events. ui_host keeps "open in PostHog" links pointing
 * at the real dashboard.
 */
(function () {
  'use strict';

  // rsbPH is always defined (even before/with no PostHog) so callers never guard.
  window.rsbPH = function (event, params) {
    try { if (window.posthog && window.posthog.capture) window.posthog.capture(event, params || {}); }
    catch (e) { /* never break the app for analytics */ }
  };

  function loadSnippet() {
    // Official posthog-js loader snippet (array-stub → real SDK once loaded).
    !function (t, e) { var o, n, p, r; e.__SV || (window.posthog = e, e._i = [], e.init = function (i, s, a) { function g(t, e) { var o = e.split("."); 2 == o.length && (t = t[o[0]], e = o[1]), t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))); }; } (p = t.createElement("script")).type = "text/javascript", p.crossOrigin = "anonymous", p.async = !0, p.src = s.api_host.replace(".i.posthog.com", "-assets.i.posthog.com") + "/static/array.js", (r = t.getElementsByTagName("script")[0]).parentNode.insertBefore(p, r); var u = e; for (void 0 !== a ? u = e[a] = [] : a = "posthog", u.people = u.people || [], u.toString = function (t) { var e = "posthog"; return "posthog" !== a && (e += "." + a), t || (e += " (stub)"), e; }, u.people.toString = function () { return u.toString(1) + ".people (stub)"; }, o = "init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug getPageViewId captureTraceFeedback captureTraceMetric".split(" "), n = 0; n < o.length; n++) g(u, o[n]); e._i.push([i, s, a]); }, e.__SV = 1); }(document, window.posthog || []);
  }

  function boot(cfg) {
    var key = cfg && cfg.posthogKey;
    if (!key) return; // no project key configured → stay a no-op
    var host = (cfg && cfg.posthogHost) || 'https://us.i.posthog.com';
    loadSnippet();
    try {
      window.posthog.init(key, {
        // Same-origin opaque path — the Express /rp route reverse-proxies to
        // PostHog so ad-blockers that block the PostHog domain don't kill ingest.
        api_host: '/rp',
        ui_host: host,
        autocapture: true,          // AC #2: autocapture ON
        capture_exceptions: true,   // AC #3: client-side error tracking ON
        capture_pageview: true,
        persistence: 'localStorage+cookie'
      });
    } catch (e) { /* init failure must never block the app */ }
  }

  fetch('/api/client-config', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (cfg) { boot(cfg); })
    .catch(function () { /* config unreachable → no-op, app unaffected */ });
})();
