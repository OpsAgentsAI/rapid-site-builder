/* Operate board — orchestrator-focal client surface.
 * Reads the just-finished build from sessionStorage.operate_state (written by
 * the landing page): agents that actually ran are LIVE with their real last
 * actions; the rest of the roster renders as the wider team with sample data.
 * The client never HAS to do anything here — Theo summarizes, approvals are
 * the single interaction, and "Ask the team" reaches the live orchestrator
 * only when the client wishes. */
(() => {
  // Injected at deploy: the Cloud Run service URL (Ask-Theo calls it directly —
  // the Hosting proxy caps long requests).
  const RAW_API = '__API_BASE__';
  const API = RAW_API.startsWith('http') ? RAW_API : '';
  const $ = (id) => document.getElementById(id);
  const state = (() => {
    try { return JSON.parse(sessionStorage.getItem('operate_state') || 'null'); } catch { return null; }
  })();

  // Design-system characters: DiceBear Adventurer face on a hue ring, role
  // emoji as a small corner badge (the kit's Avatar component treatment).
  const face = (seed) => `https://api.dicebear.com/9.x/adventurer/svg?seed=${encodeURIComponent(seed)}&radius=18&backgroundType=solid&scale=96`;

  const ROSTER = [
    { id: 'aria', name: 'Aria', emoji: '🔍', color: 'violet', role: 'Research', crew: 'build' },
    { id: 'leo', name: 'Leo', emoji: '🎨', color: 'blue', role: 'Layout', crew: 'build' },
    { id: 'noa', name: 'Noa', emoji: '✍️', color: 'pink', role: 'Copywriter', crew: 'build' },
    { id: 'sam', name: 'Sam', emoji: '📈', color: 'green', role: 'SEO', crew: 'build' },
    { id: 'max', name: 'Max', emoji: '🚀', color: 'orange', role: 'Publish', crew: 'build' },
    { id: 'phoenix', name: 'Phoenix', emoji: '🔭', color: 'purple', role: 'Arize · tracing', crew: 'observe' },
    { id: 'vera', name: 'Vera', emoji: '🩺', color: 'green', role: 'Monitor', crew: 'operate', status: 'healthy',
      sample: 'Uptime watch armed for your site',
      metric: { value: '24/7', label: 'uptime watch' },
      feed: ['probe_site_health → armed', 'TLS check scheduled'] },
    { id: 'ben', name: 'Ben', emoji: '💾', color: 'teal', role: 'Backup', crew: 'operate', status: 'idle',
      sample: 'Daily backup scheduled',
      feed: ['snapshot plan: daily 03:00', 'restore drill scheduled'] },
    { id: 'uri', name: 'Uri', emoji: '⬆️', color: 'amber', role: 'Updates', crew: 'operate', status: 'working', needsApproval: true,
      sample: 'Core update proposed · awaiting your call',
      metric: { value: '1', label: 'proposal waiting' },
      feed: ['check_updates → 1 behind', 'filed proposal card', 'parked — no change without you'] },
    { id: 'gil', name: 'Gil', emoji: '🛡️', color: 'coral', role: 'Security', crew: 'operate', status: 'healthy',
      sample: 'Threat watch on · 0 open findings',
      metric: { value: '0', label: 'open findings' },
      feed: ['scan → clean', 'rate-limit shield armed'] },
    { id: 'tova', name: 'Tova', emoji: '📝', color: 'sky', role: 'Content · SEO', crew: 'operate', status: 'idle',
      sample: 'Content freshness watch armed',
      feed: ['freshness scan scheduled', 'internal-link audit queued'] },
    { id: 'cara', name: 'Cara', emoji: '🔐', color: 'lime', role: 'Certificates', crew: 'operate', status: 'healthy',
      sample: 'TLS auto-renew armed',
      metric: { value: 'OK', label: 'auto-renew armed' },
      feed: ['TLS chain verified', 'auto-renew armed'] }
  ];

  const STATUS_LABEL = { healthy: 'Healthy', working: 'Working', stuck: 'Needs approval', idle: 'Idle' };

  function esc(s) { const d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; }

  // Newest published site remembered on this device — the cross-tab fallback
  // when the per-tab operate_state is absent. Only http(s) URLs qualify (the
  // list is device-local, but never let a corrupted entry become an iframe src).
  function latestMySite() {
    try {
      const mine = JSON.parse(localStorage.getItem('my_sites') || '[]');
      const s = Array.isArray(mine) ? mine[0] : null;
      return s && /^https?:\/\//.test(String(s.url || '')) ? s : null;
    } catch { return null; }
  }

  // The merged device-sites list (local my_sites + GET /api/my-sites?device=),
  // populated by renderMySites() — the switcher reads it (rule: zero new network
  // calls; reuse renderMySites()'s own fetch result). The id of the site Theo is
  // currently operating, so the switcher reflects the live selection.
  let mySites = [];
  let selectedId = null;

  // The same-session live site (operate_state) carries an id on newer builds; a
  // returning-user My-Sites entry never has live agentsRan/seoScore. We treat a
  // chosen site as LIVE only when its url matches the same-session state.url —
  // matching latestMySite()'s reduced-view behavior for any other entry.
  function isLiveSite(site) { return !!(state && state.url && site && site.url === state.url); }

  // Paint the Theo hero (greeting, live URL chip, iframe preview, stats) for one
  // {business,url} site. `live` ⇒ the rich same-session agentsRan view; otherwise
  // the reduced "returning user" view with an honest minimal stat (no fabricated
  // agent counts — STD D4). Guards the iframe src to http(s) only.
  function paintHero(site, live) {
    const safeUrl = site && /^https?:\/\//.test(String(site.url || '')) ? site.url : '';
    const business = site ? site.business : '';
    const ran = live ? (state.agentsRan || []).filter(a => a !== 'orchestrator') : [];

    if (live) {
      $('theo-say').innerHTML = `Welcome back. <b>${esc(business || 'Your site')}</b> is live and healthy — my team of ${Math.max(ran.length, 5)} agents built it and now keeps it running. You don’t need to do anything; I’ll only ask when a decision is truly yours.`;
    } else {
      // Reduced welcome only: the rich agentsRan view stays same-session.
      $('theo-say').innerHTML = `Welcome back — <b>${esc(business || 'your site')}</b> is live. My team keeps it monitored, updated, and secure; I’ll only ask you when a decision is truly yours.`;
    }

    $('site-chip').style.display = 'flex';
    $('site-name').textContent = business || '';
    const a = $('site-link'); a.href = safeUrl || '#'; a.textContent = safeUrl.replace(/^https?:\/\//, '');
    const shot = $('shot');
    shot.classList.remove('empty');
    shot.innerHTML = safeUrl
      ? `<iframe src="${esc(safeUrl)}" sandbox title="Live site preview" loading="lazy"></iframe><a class="open" href="${esc(safeUrl)}" target="_blank" rel="noopener">Open site</a>`
      : '<span>No preview available for this site.</span>';

    const stats = [];
    if (live) {
      if (ran.length) stats.push([String(ran.length), 'agents on the job']);
      if (state.seoScore) stats.push([String(state.seoScore), 'SEO score · Sam']);
      if ((state.agentsRan || []).includes('phoenix')) stats.push(['Traced', 'run logged · Arize']);
      stats.push(['Live', 'shipped to the web']);
    } else if (safeUrl) {
      // A non-session My-Sites entry has no live agentsRan/seoScore — show only
      // the honest "it's live" stat, never a fabricated agent count (STD D4).
      stats.push(['Live', 'shipped to the web']);
    }
    $('stats').innerHTML = stats.map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');

    // The needs-you strip only exists for the real same-session site — an
    // arbitrary My-Sites entry has no live decision to take, so hide it (mirrors
    // the latestMySite() reduced view).
    const needs = $('needs');
    if (!live) {
      needs.style.display = 'none';
      return;
    }
    needs.style.display = 'flex';
    $('needs-tx').innerHTML = '<b>One decision waits for you</b> — Uri proposes a core update (sample item). Everything else is handled.';
    $('needs-later').onclick = () => { needs.style.display = 'none'; };
    $('needs-ok').onclick = () => {
      $('needs-tx').innerHTML = 'Approved — Uri is on it. That’s all you needed to do.';
      $('needs-ok').style.display = 'none'; $('needs-later').style.display = 'none';
      resolved.uri = 'approved'; renderTeam();
      setTimeout(() => { needs.style.display = 'none'; }, 3500);
    };
  }

  function renderTheo() {
    if (state && state.url) {
      selectedId = state.id || null;
      paintHero({ id: state.id, business: state.business, url: state.url }, true);
    } else if (latestMySite()) {
      // operate_state is per-tab (sessionStorage); a returning user or a fresh
      // tab still has their published sites on this device — greet with the
      // newest one instead of a false "no sites" empty state (card jYXyj0lx).
      const mine = latestMySite();
      selectedId = mine.id || null;
      paintHero({ id: mine.id, business: mine.business, url: mine.url }, false);
    } else {
      $('theo-say').textContent = 'Hi, I’m Theo. Once you build and publish a site, my team takes over the day-to-day — monitoring, updates, security — and I report here in plain language.';
      $('stats').innerHTML = '';
      $('needs').style.display = 'none';
    }
  }

  // Re-point the hero at a known site by id (switcher change / deep link). Falls
  // back silently if the id isn't in the merged list. Reflects the choice in the
  // URL so /board?site=<id> deep links are shareable.
  function selectSite(id, pushUrl) {
    const site = mySites.find(s => s.id === id);
    if (!site) return;
    selectedId = id;
    paintHero(site, isLiveSite(site));
    const sel = $('site-switch'); if (sel) sel.value = id;
    if (pushUrl) {
      try {
        const u = new URL(window.location.href);
        u.searchParams.set('site', id);
        history.replaceState(null, '', u);
      } catch { /* noop */ }
    }
  }

  // Render the in-hero site switcher from the merged list. Hidden for 0 or 1
  // known sites (single-site users see no clutter). On first paint, honor a
  // /board?site=<id> deep link if it matches a known site.
  function renderSwitcher() {
    const sel = $('site-switch');
    const box = $('switcher');
    if (!sel || !box) return;

    if (mySites.length < 2) { box.style.display = 'none'; return; }
    box.style.display = 'flex';

    sel.innerHTML = mySites.map(s =>
      `<option value="${esc(s.id)}">${esc(s.business || s.id)}</option>`
    ).join('');

    let want = null;
    try {
      const q = new URLSearchParams(window.location.search).get('site');
      if (q && mySites.some(s => s.id === q)) want = q;
    } catch { /* noop */ }

    if (want) {
      // Deep link wins on load — select + rehydrate + reflect in the dropdown.
      selectSite(want, false);
    } else if (mySites.some(s => s.id === selectedId)) {
      // The current site (same-session live or the latestMySite greeting) is in
      // the list — just reflect it in the dropdown; the hero is already painted,
      // so don't repaint/override the live view.
      sel.value = selectedId;
    } else {
      // No deep link and the current selection isn't a listed site (e.g. a
      // same-session site with no id, or no session at all). Reflect the newest
      // entry in the dropdown WITHOUT repainting — preserves the existing hero
      // (live same-session or empty-state) until the user explicitly switches.
      sel.value = mySites[0].id;
    }

    if (!sel.dataset.bound) {
      sel.dataset.bound = '1';
      sel.addEventListener('change', () => selectSite(sel.value, true));
    }
  }

  const resolved = {}; // agent id -> 'approved' | 'rejected' (in-card gates, local demo state)

  function renderTeam() {
    const ran = new Set(state ? state.agentsRan || [] : []);
    const lastBy = (state && state.lastByAgent) || {};
    const feedBy = (state && state.feedByAgent) || {};
    // map landing personas → roster ids (brief → aria)
    if (ran.has('brief')) {
      ran.add('aria');
      if (lastBy.brief) lastBy.aria = lastBy.brief;
      if (feedBy.brief) feedBy.aria = feedBy.brief;
    }

    const cards = ROSTER.map(a => {
      const isLive = ran.has(a.id);
      const res = resolved[a.id];
      let status, last, tag, feed, metric, needsApproval;

      if (isLive) {
        status = 'healthy';
        last = lastBy[a.id] || 'Acted in your last build';
        tag = `<span class="live-tag"><i></i>LIVE</span>`;
        feed = feedBy[a.id] || [];
        if (a.id === 'sam' && state && state.seoScore) metric = { value: String(state.seoScore), label: 'SEO score · your site' };
        if (a.id === 'max' && state && state.url) metric = { value: 'Live', label: 'shipped to the web' };
        if (a.id === 'phoenix') metric = { value: 'Traced', label: 'run logged · Arize' };
      } else {
        status = res === 'approved' ? 'healthy' : res === 'rejected' ? 'idle' : (a.status || 'idle');
        last = res === 'approved' ? 'Approved — on it'
             : res === 'rejected' ? 'Rejected — staying as is'
             : (a.sample || 'Handled automatically — nothing for you to do.');
        tag = '';
        feed = a.feed || [];
        if (a.metric && !res) metric = a.metric;
        needsApproval = a.needsApproval && !res;
      }

      return `<article class="card" style="--hue:var(--agent-${a.color})">
        <span class="bar" aria-hidden="true"></span>
        <header>
          <span class="av${status === 'working' ? ' bob' : ''}"><span class="face"><img alt="" loading="lazy" src="${face(a.name)}"/></span><span class="role-badge" aria-hidden="true">${a.emoji}</span></span>
          <div class="meta"><div class="nm">${esc(a.name)} ${tag}</div><div class="rl">${esc(a.role)}</div></div>
          <span class="pill ${status}">${STATUS_LABEL[status]}</span>
        </header>
        <p class="last">${esc(last)}</p>
        ${metric ? `<div class="metric"><b>${esc(metric.value)}</b><span>${esc(metric.label)}</span></div>` : ''}
        ${feed.length ? `<ul class="cfeed">${feed.slice(0, 3).map(l => `<li><i>▸</i><span>${esc(l)}</span></li>`).join('')}</ul>` : ''}
        ${needsApproval ? `<div class="gate"><span class="g-label">✋ Human approval</span><button class="rej" data-act="reject" data-id="${a.id}">Reject</button><button class="app" data-act="approve" data-id="${a.id}">Approve</button></div>` : ''}
        ${isLive || res ? '' : `<span class="sample">sample</span>`}
      </article>`;
    });
    $('grid').innerHTML = cards.join('');
    $('grid').querySelectorAll('.gate button').forEach(b => b.addEventListener('click', () => {
      resolved[b.dataset.id] = b.dataset.act === 'approve' ? 'approved' : 'rejected';
      if (b.dataset.act === 'approve') { const needs = $('needs'); if (needs) needs.style.display = 'none'; }
      renderTeam();
    }));
  }

  async function ask() {
    const q = $('ask-in').value.trim();
    if (!q) return;
    const btn = $('ask-go'), reply = $('ask-reply');
    btn.disabled = true;
    reply.style.display = 'block';
    reply.textContent = 'Theo is thinking…';
    try {
      const r = await fetch(API + '/api/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: q,
          business: state ? state.business : '',
          url: state ? state.url : '',
          // Mirror the question's language — a Hebrew question gets a Hebrew answer.
          lang: /[֐-׿]/.test(q) ? 'he' : 'en'
        })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'ask failed');
      reply.textContent = j.reply || '…';
    } catch {
      reply.textContent = 'Couldn’t reach Theo right now — try again in a moment.';
    } finally {
      btn.disabled = false;
    }
  }

  async function renderMySites() {
    // Local list paints first (instant), then the server's device-keyed list
    // merges in (card jvsQp6cS) — so sites survive a cleared localStorage and
    // show up from any page that knows this device id. No sign-in involved.
    let mine = [];
    try { mine = JSON.parse(localStorage.getItem('my_sites') || '[]'); } catch { /* noop */ }
    mySites = mine;
    paintMySites(mine);
    renderSwitcher();
    try {
      const r = await fetch(API + '/api/my-sites?device=' + encodeURIComponent(window.RSB_DEVICE || ''));
      if (r.ok) {
        const j = await r.json();
        const known = new Set(mine.map(s => s.id));
        for (const s of (j.sites || [])) {
          if (!known.has(s.id)) mine.push({ id: s.id, url: s.url, business: s.business, at: Date.parse(s.createdAt) || 0 });
        }
        mine.sort((a, b) => (b.at || 0) - (a.at || 0));
        try { localStorage.setItem('my_sites', JSON.stringify(mine.slice(0, 20))); } catch { /* noop */ }
        mySites = mine;
        paintMySites(mine);
        // The server list may add the deep-linked / additional sites — re-render
        // the switcher against the full merged list (reuses this same fetch; no
        // new network call).
        renderSwitcher();
      }
    } catch { /* offline or server unreachable — the local list already painted */ }
  }

  function paintMySites(mine) {
    if (!mine.length) return;
    $('mysites').style.display = 'block';
    $('mysites-list').innerHTML = mine.slice(0, 12).map(s =>
      `<a href="${esc(s.url)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:7px;background:var(--surface-sunken);border:1px solid var(--border);border-radius:var(--radius-pill);padding:7px 14px;font-size:13px;font-weight:600;color:var(--ink-2);text-decoration:none">${esc(s.business || s.id)}<span style="font-family:var(--font-mono);font-size:10.5px;color:var(--ink-3)">/${esc(s.id)}</span></a>`
    ).join('');
  }

  $('ask-go').addEventListener('click', ask);
  $('ask-in').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
  renderTheo();
  renderTeam();
  renderMySites();
})();
