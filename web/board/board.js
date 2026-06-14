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

  // One-line function/responsibility per agent for the drill-in panel. Kept in a
  // separate const (not merged into ROSTER) so the panel stays purely additive
  // (card r9n9Hc8C). Keyed by roster id.
  const FN = {
    aria: 'Researches your business, market and audience so the rest of the team builds on real ground.',
    leo: 'Designs the page layout and visual structure — sections, hierarchy and responsive grid.',
    noa: 'Writes the on-page copy: headlines, body and calls-to-action in your brand voice.',
    sam: 'Tunes on-page SEO — titles, meta, headings and structured data — for discoverability.',
    max: 'Publishes the finished site to the web and confirms it is live.',
    phoenix: 'Traces every agent run to Arize Phoenix so each decision is observable and auditable.',
    vera: 'Monitors uptime and site health around the clock and raises an alert the moment something slips.',
    ben: 'Runs scheduled backups and keeps a tested restore path so your site is always recoverable.',
    uri: 'Watches for core and dependency updates and files a proposal — never changing anything without your approval.',
    gil: 'Guards the site: security scans, threat watch and rate-limit shielding against abuse.',
    tova: 'Keeps content fresh and internal links healthy, flagging pages that need a refresh.',
    cara: 'Manages TLS certificates and auto-renewal so the padlock never lapses.'
  };

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

  function renderTheo() {
    const ran = state ? (state.agentsRan || []).filter(a => a !== 'orchestrator') : [];
    if (state && state.url) {
      $('theo-say').innerHTML = `Welcome back. <b>${esc(state.business || 'Your site')}</b> is live and healthy — my team of ${Math.max(ran.length, 5)} agents built it and now keeps it running. You don’t need to do anything; I’ll only ask when a decision is truly yours.`;
      $('site-chip').style.display = 'flex';
      $('site-name').textContent = state.business || '';
      const a = $('site-link'); a.href = state.url; a.textContent = state.url.replace(/^https?:\/\//, '');
      const shot = $('shot');
      shot.classList.remove('empty');
      shot.innerHTML = `<iframe src="${esc(state.url)}" sandbox title="Live site preview" loading="lazy"></iframe><a class="open" href="${esc(state.url)}" target="_blank" rel="noopener">Open site</a>`;
    } else if (latestMySite()) {
      // operate_state is per-tab (sessionStorage); a returning user or a fresh
      // tab still has their published sites on this device — greet with the
      // newest one instead of a false "no sites" empty state (card jYXyj0lx).
      // Reduced welcome only: the rich agentsRan view stays same-session.
      const mine = latestMySite();
      $('theo-say').innerHTML = `Welcome back — <b>${esc(mine.business || 'your site')}</b> is live. My team keeps it monitored, updated, and secure; I’ll only ask you when a decision is truly yours.`;
      $('site-chip').style.display = 'flex';
      $('site-name').textContent = mine.business || '';
      const a = $('site-link'); a.href = mine.url; a.textContent = String(mine.url || '').replace(/^https?:\/\//, '');
      const shot = $('shot');
      shot.classList.remove('empty');
      shot.innerHTML = `<iframe src="${esc(mine.url)}" sandbox title="Live site preview" loading="lazy"></iframe><a class="open" href="${esc(mine.url)}" target="_blank" rel="noopener">Open site</a>`;
    } else {
      $('theo-say').textContent = 'Hi, I’m Theo. Once you build and publish a site, my team takes over the day-to-day — monitoring, updates, security — and I report here in plain language.';
    }
    const stats = [];
    if (ran.length) stats.push([String(ran.length), 'agents on the job']);
    if (state && state.seoScore) stats.push([String(state.seoScore), 'SEO score · Sam']);
    if (state && (state.agentsRan || []).includes('phoenix')) stats.push(['Traced', 'run logged · Arize']);
    if (state && state.url) stats.push(['Live', 'shipped to the web']);
    $('stats').innerHTML = stats.map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');

    // The needs-you strip only exists for a real site — on an empty board there
    // is no decision to take (the roster's Uri card keeps its tagged sample gate).
    const needs = $('needs');
    if (!(state && state.url)) {
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

      return `<article class="card" data-agent="${a.id}" tabindex="0" role="button" aria-label="${esc(a.name)} — ${esc(a.role)}, open details" style="--hue:var(--agent-${a.color})">
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

  // ===== drill-in detail panel (card r9n9Hc8C) =====
  // Pure-frontend: everything comes from ROSTER + FN + the live `state` already
  // on the page (no new network calls). Mirrors renderTeam's live/sample logic.
  let drillReturnFocus = null;

  function agentView(a) {
    // Same live/sample resolution renderTeam uses, including brief→aria persona map.
    const ran = new Set(state ? state.agentsRan || [] : []);
    const lastBy = Object.assign({}, (state && state.lastByAgent) || {});
    const feedBy = Object.assign({}, (state && state.feedByAgent) || {});
    if (ran.has('brief')) {
      ran.add('aria');
      if (lastBy.brief) lastBy.aria = lastBy.brief;
      if (feedBy.brief) feedBy.aria = feedBy.brief;
    }
    const isLive = ran.has(a.id);
    const res = resolved[a.id];
    let status, last, feed;
    if (isLive) {
      status = 'healthy';
      last = lastBy[a.id] || 'Acted in your last build';
      feed = feedBy[a.id] || [];
    } else {
      status = res === 'approved' ? 'healthy' : res === 'rejected' ? 'idle' : (a.status || 'idle');
      last = res === 'approved' ? 'Approved — on it'
           : res === 'rejected' ? 'Rejected — staying as is'
           : (a.sample || 'Handled automatically — nothing for you to do.');
      feed = a.feed || [];
    }
    return { isLive, status, last, feed };
  }

  function openDrill(id) {
    const a = ROSTER.find(x => x.id === id);
    if (!a) return;
    const v = agentView(a);
    const tag = v.isLive
      ? '<span class="live-tag"><i></i>LIVE</span>'
      : '<span class="sample">sample</span>';
    const fn = FN[a.id] || a.role;
    const feedHtml = v.feed.length
      ? `<div class="drill-feed-h">${v.isLive ? 'Recent activity' : 'Sample activity'}</div>
         <ul class="drill-feed">${v.feed.map(l => `<li><i>▸</i><span>${esc(l)}</span></li>`).join('')}</ul>`
      : '<div class="drill-empty">No recent activity lines for this agent yet.</div>';

    $('drill-body').innerHTML = `
      <div class="drill-head" style="--hue:var(--agent-${a.color})">
        <span class="av"><span class="face"><img alt="" src="${face(a.name)}"/></span><span class="role-badge" aria-hidden="true">${a.emoji}</span></span>
        <div class="meta"><div class="nm" id="drill-name">${esc(a.name)} ${tag}</div><div class="rl">${esc(a.role)}</div></div>
        <span class="pill ${v.status}">${STATUS_LABEL[v.status]}</span>
      </div>
      <p class="drill-fn">${esc(fn)}</p>
      <div class="drill-rows">
        <div class="drill-row"><span class="k">Status</span><span class="v">${STATUS_LABEL[v.status]}</span></div>
        <div class="drill-row"><span class="k">Function</span><span class="v">${esc(a.role)}</span></div>
        <div class="drill-row"><span class="k">Source</span><span class="v">${v.isLive ? 'LIVE — acted in your last build' : 'SAMPLE — illustrative, no run this session'}</span></div>
        <div class="drill-row"><span class="k">Last activity</span><span class="v">${esc(v.last)}</span></div>
      </div>
      ${feedHtml}`;

    const drill = $('drill');
    drill.style.setProperty('--hue', `var(--agent-${a.color})`);
    drill.hidden = false;
    drillReturnFocus = document.activeElement;
    $('drill-sheet').focus();
  }

  function closeDrill() {
    const drill = $('drill');
    if (drill.hidden) return;
    drill.hidden = true;
    if (drillReturnFocus && typeof drillReturnFocus.focus === 'function') drillReturnFocus.focus();
    drillReturnFocus = null;
  }

  // Open via event delegation on the grid; gate buttons must NOT open the panel.
  $('grid').addEventListener('click', (e) => {
    if (e.target.closest('.gate')) return;
    const card = e.target.closest('.card[data-agent]');
    if (card) openDrill(card.dataset.agent);
  });
  $('grid').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    if (e.target.closest('.gate')) return;
    const card = e.target.closest('.card[data-agent]');
    if (card && card === e.target) { e.preventDefault(); openDrill(card.dataset.agent); }
  });
  $('drill-x').addEventListener('click', closeDrill);
  $('drill-back').addEventListener('click', closeDrill);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('drill').hidden) closeDrill(); });
  // Focus trap: keep Tab / Shift+Tab inside the open sheet (role=dialog aria-modal).
  $('drill-sheet').addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = Array.from($('drill-sheet').querySelectorAll(
      'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])'
    )).filter((el) => !el.hidden && el.offsetParent !== null);
    if (!f.length) { e.preventDefault(); $('drill-sheet').focus(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

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
    paintMySites(mine);
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
        paintMySites(mine);
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
