/* GA4 instrumentation (card WZtm0jA3 — MSApps mandatory baseline #2).
 *
 * Loads gtag.js for the Measurement ID this deployment is configured with, then
 * exposes window.rsbTrack(event, params) for the key conversion events and wires
 * GA4 'exception' events for web error tracking (the web analog of Crashlytics).
 *
 * The Measurement ID is NOT hardcoded — it comes from GET /api/client-config
 * (server reads process.env.GA4_MEASUREMENT_ID). When unset (a judge cloning the
 * public repo, or local dev), this is a complete no-op: no gtag script is loaded
 * and rsbTrack() silently does nothing. So analytics never blocks the app and the
 * public repo carries no tracking ID.
 */
(function () {
  'use strict';

  // rsbTrack is always defined (even before/with no gtag) so callers never guard.
  window.rsbTrack = function (event, params) {
    try { if (window.gtag) window.gtag('event', event, params || {}); } catch (e) { /* never break the app for analytics */ }
  };

  function boot(id) {
    if (!id) return; // no Measurement ID configured → stay a no-op
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', id); // sends the initial page_view
  }

  // GA4 'exception' events = web error tracking (GA has no Crashlytics SDK).
  window.addEventListener('error', function (e) {
    if (!window.gtag) return;
    try { window.gtag('event', 'exception', { description: String((e && e.message) || 'error').slice(0, 150), fatal: false }); } catch (_) {}
  });
  window.addEventListener('unhandledrejection', function (e) {
    if (!window.gtag) return;
    var d = (e && e.reason && (e.reason.message || e.reason)) || 'unhandledrejection';
    try { window.gtag('event', 'exception', { description: String(d).slice(0, 150), fatal: false }); } catch (_) {}
  });

  fetch('/api/client-config', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (cfg) { boot(cfg && cfg.ga4Id); })
    .catch(function () { /* config unreachable → no-op, app unaffected */ });
})();
