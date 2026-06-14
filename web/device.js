'use strict';
// Anonymous device identity (card jvsQp6cS) — remembers this browser's sites
// without any sign-in. A random 32-hex id lives in BOTH localStorage and a
// 1-year cookie so each can restore the other; it is sent explicitly with API
// calls (a body field / query param), never relied on as a cross-origin
// cookie. It groups sites for convenience only — real per-account ownership
// arrives with the login gate (card VI673sym), which can claim these ids.
window.RSB_DEVICE = (function () {
  var KEY = 'rsb_device';
  var RE = /^[a-f0-9]{32}$/;
  var id = '';
  try { id = String(localStorage.getItem(KEY) || ''); } catch (e) { /* storage off */ }
  if (!RE.test(id)) {
    var m = document.cookie.match(/(?:^|;\s*)rsb_device=([a-f0-9]{32})/);
    if (m) id = m[1];
  }
  if (!RE.test(id)) {
    var buf = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    id = Array.prototype.map.call(buf, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  try { localStorage.setItem(KEY, id); } catch (e) { /* non-fatal */ }
  try { document.cookie = 'rsb_device=' + id + '; Max-Age=31536000; Path=/; SameSite=Lax; Secure'; } catch (e) { /* non-fatal */ }
  return id;
})();
