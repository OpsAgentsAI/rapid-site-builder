/*
 * Google Analytics 4 (GA4) — Rapid Site Builder
 * Mandatory analytics baseline: every OpsAgents app ships with GA4.
 *
 * SETUP (one line): set MEASUREMENT_ID below to the real GA4 web-stream id
 * once the rapid-site-builder data stream is provisioned. Until then this
 * file is a safe no-op (it deploys but sends nothing), so it is safe to merge.
 *
 * The stream can be created via the ga-provisioner@opsagent-prod SA (GA Admin
 * API) once that SA is added as Editor in GA Admin, or by hand in the GA UI
 * (Admin -> Data Streams -> Add stream -> Web -> rapid-site-builder.web.app).
 */
(function () {
  var MEASUREMENT_ID = 'G-XXXXXXXXXX'; // <-- replace with the real GA4 id

  // No-op guard: do nothing until a real measurement id is set.
  if (!MEASUREMENT_ID || /X{6,}/.test(MEASUREMENT_ID)) return;

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + MEASUREMENT_ID;
  document.head.appendChild(s);

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  gtag('js', new Date());
  gtag('config', MEASUREMENT_ID);

  // Expose a tiny helper so app code can fire conversion events, e.g.
  //   window.rsbTrack('generate_site', { plan: 'free' });
  window.rsbTrack = function (name, params) {
    try { gtag('event', name, params || {}); } catch (e) {}
  };
})();
