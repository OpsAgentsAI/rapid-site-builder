/* Sign-in client for Publish + My Sites (card VI673sym).
 * Shared by the landing page and the operate board. Deliberately tiny: the
 * Firebase Web SDK loads lazily ONLY when the user actually needs to sign in —
 * the build flow never pays for it. All auth calls are relative URLs so they
 * ride the Firebase Hosting rewrite (first-party `__session` cookie); only the
 * long SSE build talks to the Cloud Run origin directly.
 */
(function () {
  'use strict';

  var SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';
  var cfgPromise = null;

  function config(fresh) {
    if (!cfgPromise || fresh) {
      cfgPromise = fetch('/api/auth-config', { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .catch(function () { return { authEnabled: false, firebase: null, me: null }; });
    }
    return cfgPromise;
  }

  var fbAuthPromise = null;
  function firebaseAuth(fb) {
    if (!fbAuthPromise) {
      fbAuthPromise = Promise.all([
        import(SDK + 'firebase-app.js'),
        import(SDK + 'firebase-auth.js')
      ]).then(function (mods) {
        var appMod = mods[0], authMod = mods[1];
        var app = appMod.initializeApp({
          apiKey: fb.apiKey, authDomain: fb.authDomain, projectId: fb.projectId
        });
        return { auth: authMod.getAuth(app), mod: authMod };
      });
    }
    return fbAuthPromise;
  }

  function exchange(user) {
    return user.getIdToken().then(function (idToken) {
      return fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ idToken: idToken })
      });
    }).then(function (r) {
      if (!r.ok) throw new Error('session exchange failed');
      cfgPromise = null; // me changed — next config() refetches
      return true;
    });
  }

  // Google sign-in: popup first (page state survives), redirect as the
  // fallback for popup-blocking browsers — the caller is expected to have
  // saved a draft first so the build survives the round-trip.
  function signIn() {
    return config().then(function (cfg) {
      if (!cfg.authEnabled || !cfg.firebase) throw new Error('Sign-in is not available right now.');
      if (cfg.me) return true;
      return firebaseAuth(cfg.firebase).then(function (fa) {
        var provider = new fa.mod.GoogleAuthProvider();
        return fa.mod.signInWithPopup(fa.auth, provider)
          .then(function (cred) { return exchange(cred.user); })
          .catch(function (e) {
            if (e && /popup/i.test(String(e.code || e.message))) {
              return fa.mod.signInWithRedirect(fa.auth, provider); // page unloads here
            }
            throw e;
          });
      });
    });
  }

  // Call on page load: completes a redirect-based sign-in if one is in flight.
  // Resolves true when a session was just minted, false otherwise.
  function completeRedirect() {
    return config().then(function (cfg) {
      if (!cfg.authEnabled || !cfg.firebase || cfg.me) return false;
      // getRedirectResult is a no-op (null) unless we're landing back from the
      // provider, so this is cheap on a cold visit... but the SDK import isn't.
      // Only pay it when a redirect is actually pending.
      if (sessionStorage.getItem('rsb_auth_redirect') !== '1') return false;
      sessionStorage.removeItem('rsb_auth_redirect');
      return firebaseAuth(cfg.firebase).then(function (fa) {
        return fa.mod.getRedirectResult(fa.auth).then(function (cred) {
          if (cred && cred.user) return exchange(cred.user).then(function () { return true; });
          return false;
        });
      });
    }).catch(function () { return false; });
  }

  function signOut() {
    return fetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
      .then(function () { cfgPromise = null; });
  }

  function mySites() {
    return fetch('/api/my-sites', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { sites: [] }; })
      .then(function (d) { return (d && d.sites) || []; })
      .catch(function () { return []; });
  }

  // Draft persistence so a build survives the sign-in wall (redirect path).
  function saveDraft(draft) {
    try {
      sessionStorage.setItem('rsb_auth_redirect', '1');
      localStorage.setItem('rsb_draft', JSON.stringify({ at: Date.now(), draft: draft }));
    } catch (e) { /* storage unavailable — popup path still works */ }
  }
  function takeDraft() {
    try {
      var raw = localStorage.getItem('rsb_draft');
      if (!raw) return null;
      localStorage.removeItem('rsb_draft');
      var d = JSON.parse(raw);
      // drafts older than an hour are stale intent, not a resume
      if (!d || !d.draft || Date.now() - d.at > 3600000) return null;
      return d.draft;
    } catch (e) { return null; }
  }

  window.RSB_AUTH = {
    config: config, signIn: signIn, signOut: signOut, completeRedirect: completeRedirect,
    mySites: mySites, saveDraft: saveDraft, takeDraft: takeDraft
  };
})();
