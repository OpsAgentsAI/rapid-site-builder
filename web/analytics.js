/* Rapid Site Builder — PostHog bootstrap (card u4xmePAo).
 *
 * The page holds NO key. It asks /api/analytics-config and loads the PostHog
 * snippet only inside the enabled branch, so an unbound deployment — which is
 * every deployment until the operator binds POSTHOG_PROJECT_KEY — makes no
 * network call to PostHog at all and logs nothing to the console.
 *
 * GA4 is untouched and stays where it is, inline in the page head: it is a
 * different product with a different failure mode, and this card is explicit
 * that PostHog must not be blocked on the GA4 wizard.
 */
(function () {
  'use strict';

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
})();
