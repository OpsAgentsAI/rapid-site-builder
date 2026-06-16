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

  // i18n bridge — the shared engine (web/i18n.js) owns the dictionaries, <html
  // lang/dir>, and static-string apply(). Here we localize the strings this
  // script builds at runtime. T() falls back to the key if the engine is absent
  // (e.g. a stripped deploy) so the board never renders an empty bubble.
  const T = (k, v) => (window.RSB_I18N ? RSB_I18N.t(k, v) : k);
  // UI language is whatever the shared engine resolved (?lang= → saved → host).
  // T() already reads it, so no separate copy is kept; setLang() reloads with the
  // chosen ?lang= so every runtime string below re-renders in the new language.
  // Wire the in-page language switcher (same component as the landing page).
  if ($('langbtn') && window.RSB_I18N) {
    $('langbtn').addEventListener('click', () => RSB_I18N.setLang(RSB_I18N.lang === 'he' ? 'en' : 'he'));
  }
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

  // Status pill labels, resolved through the engine each call so a language
  // switch repaints correctly. Keys mirror i18n.js board.status.*.
  const statusLabel = (s) => T('board.status.' + s);

  // ---- runtime-string localizers for ROSTER content ----
  // ROSTER keeps stable id/name/emoji/color + English literals as t() fallbacks.
  // role/sample/metric-label/feed lines resolve through board.* keys keyed by id.
  const tRole = (a) => T('board.role.' + a.id, undefined) !== ('board.role.' + a.id) ? T('board.role.' + a.id) : a.role;
  const tSample = (a) => (a.sample ? (T('board.sample.' + a.id) !== ('board.sample.' + a.id) ? T('board.sample.' + a.id) : a.sample) : a.sample);
  const tMetricLabel = (a) => (a.metric ? (T('board.mlabel.' + a.id) !== ('board.mlabel.' + a.id) ? T('board.mlabel.' + a.id) : a.metric.label) : '');
  const tFeed = (a) => (a.feed || []).map((line, i) => {
    const key = 'board.feed.' + a.id + '.' + i;
    const got = T(key);
    return got !== key ? got : line;
  });

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

  // ===== Dash-C: persisted roster order (localStorage.rsb_board_order) =====
  // Stored value is the ordered list of agent ids. On load we sort ROSTER by it;
  // unknown / newly-added ids fall to the end keeping their default order. The
  // demo state (resolved, live agents) is independent of order, so a reorder is
  // a pure presentation concern that never touches the gate / approval logic.
  const ORDER_KEY = 'rsb_board_order';
  function readOrder() {
    try {
      const o = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]');
      return Array.isArray(o) ? o.filter(x => typeof x === 'string') : [];
    } catch { return []; }
  }
  function applySavedOrder() {
    const saved = readOrder();
    if (!saved.length) return;
    const rank = new Map(saved.map((id, i) => [id, i]));
    // Stable sort: known ids by saved rank, unknown ids after them in place.
    ROSTER.sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
      const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
      return ra - rb;
    });
  }
  function persistOrder() {
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(ROSTER.map(a => a.id))); } catch { /* noop */ }
  }
  // Reorder the in-memory ROSTER moving id `srcId` to before/after `dstId`.
  function moveInRoster(srcId, dstId, after) {
    if (srcId === dstId) return false;
    const from = ROSTER.findIndex(a => a.id === srcId);
    if (from < 0) return false;
    const [moved] = ROSTER.splice(from, 1);
    let to = ROSTER.findIndex(a => a.id === dstId);
    if (to < 0) { ROSTER.push(moved); return true; }
    if (after) to += 1;
    ROSTER.splice(to, 0, moved);
    return true;
  }
  applySavedOrder();

  // ===== Dash-C: live filter state (active chip + free-text query) =====
  const filterState = { chip: 'all', query: '' };

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
      $('theo-say').innerHTML = T('board.theo.live', {
        business: esc(business || T('board.theo.yoursite')),
        n: String(Math.max(ran.length, 5))
      });
    } else {
      // Reduced welcome only: the rich agentsRan view stays same-session.
      $('theo-say').innerHTML = T('board.theo.reduced', {
        business: esc(business || T('board.theo.yourbiz'))
      });
    }

    $('site-chip').style.display = 'flex';
    $('site-name').textContent = business || '';
    const a = $('site-link'); a.href = safeUrl || '#'; a.textContent = safeUrl.replace(/^https?:\/\//, '');
    const shot = $('shot');
    shot.classList.remove('empty');
    shot.innerHTML = safeUrl
      ? `<iframe src="${esc(safeUrl)}" sandbox title="${esc(T('board.shot.previewtitle'))}" loading="lazy"></iframe><a class="open" href="${esc(safeUrl)}" target="_blank" rel="noopener">${esc(T('board.shot.open'))}</a>`
      : `<span>${esc(T('board.shot.nopreview'))}</span>`;

    const stats = [];
    if (live) {
      if (ran.length) stats.push([String(ran.length), T('board.stat.agents')]);
      if (state.seoScore) stats.push([String(state.seoScore), T('board.stat.seo')]);
      if ((state.agentsRan || []).includes('phoenix')) stats.push([T('board.stat.traced.v'), T('board.stat.traced.l')]);
      stats.push([T('board.stat.live.v'), T('board.stat.live.l')]);
    } else if (safeUrl) {
      // A non-session My-Sites entry has no live agentsRan/seoScore — show only
      // the honest "it's live" stat, never a fabricated agent count (STD D4).
      stats.push([T('board.stat.live.v'), T('board.stat.live.l')]);
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
    $('needs-tx').innerHTML = T('board.needs.tx');
    $('needs-later').onclick = () => { needs.style.display = 'none'; };
    $('needs-ok').onclick = () => {
      $('needs-tx').innerHTML = T('board.needs.approved');
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
      $('theo-say').textContent = T('board.theo.intro');
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
        last = lastBy[a.id] || T('board.last.acted');
        tag = `<span class="live-tag"><i></i>${esc(T('board.live'))}</span>`;
        feed = feedBy[a.id] || [];
        if (a.id === 'sam' && state && state.seoScore) metric = { value: String(state.seoScore), label: T('board.metric.seo') };
        if (a.id === 'max' && state && state.url) metric = { value: T('board.stat.live.v'), label: T('board.metric.shipped') };
        if (a.id === 'phoenix') metric = { value: T('board.stat.traced.v'), label: T('board.stat.traced.l') };
      } else {
        status = res === 'approved' ? 'healthy' : res === 'rejected' ? 'idle' : (a.status || 'idle');
        last = res === 'approved' ? T('board.last.approved')
             : res === 'rejected' ? T('board.last.rejected')
             : (tSample(a) || T('board.last.auto'));
        tag = '';
        feed = tFeed(a);
        if (a.metric && !res) metric = { value: a.metric.value, label: tMetricLabel(a) };
        needsApproval = a.needsApproval && !res;
      }

      // Dash-C: a card's "filter status" = what the user visibly sees. The
      // pill status (healthy/working/idle) drives Working/Idle chips; a card
      // currently rendering the approval gate is the "Needs you" bucket.
      const showGate = !!needsApproval;
      const fstatus = showGate ? 'needs' : status;

      // Convoy merge (board-refinement, rule #18): Dash-B drill-in attrs
      // (data-agent/tabindex/role/aria-label) + Dash-C drag/filter attrs
      // (draggable/data-id/data-fstatus/data-name/data-role) on one card.
      const role = tRole(a);
      return `<article class="card" draggable="true" data-agent="${a.id}" data-id="${esc(a.id)}" data-fstatus="${esc(fstatus)}" data-name="${esc(a.name)}" data-role="${esc(role)}" tabindex="0" role="button" aria-label="${esc(T('board.card.aria', { name: a.name, role: role }))}" style="--hue:var(--agent-${a.color})">
        <span class="bar" aria-hidden="true"></span>
        <button type="button" class="drag" aria-label="${esc(T('board.drag.aria', { name: a.name }))}" title="${esc(T('board.drag.title'))}"><i></i><i></i><i></i></button>
        <header>
          <span class="av${status === 'working' ? ' bob' : ''}"><span class="face"><img alt="" loading="lazy" src="${face(a.name)}"/></span><span class="role-badge" aria-hidden="true">${a.emoji}</span></span>
          <div class="meta"><div class="nm">${esc(a.name)} ${tag}</div><div class="rl">${esc(role)}</div></div>
          <span class="pill ${status}">${statusLabel(status)}</span>
        </header>
        <p class="last">${esc(last)}</p>
        ${metric ? `<div class="metric"><b>${esc(metric.value)}</b><span>${esc(metric.label)}</span></div>` : ''}
        ${feed.length ? `<ul class="cfeed">${feed.slice(0, 3).map(l => `<li><i>▸</i><span>${esc(l)}</span></li>`).join('')}</ul>` : ''}
        ${showGate ? `<div class="gate"><span class="g-label">✋ ${esc(T('board.gate.label'))}</span><button class="rej" data-act="reject" data-id="${esc(a.id)}">${esc(T('board.gate.reject'))}</button><button class="app" data-act="approve" data-id="${esc(a.id)}">${esc(T('board.gate.approve'))}</button></div>` : ''}
        ${isLive || res ? '' : `<span class="sample">${esc(T('board.tag.sample'))}</span>`}
      </article>`;
    });
    $('grid').innerHTML = cards.join('') + '<div class="grid-empty" id="grid-empty">No agents match this filter.</div>';
    // CRITICAL: re-attach the in-card approve/reject gate handlers on every
    // re-render — filtering and dragging both re-render, and dropping this wiring
    // would silently break the Uri approval gate.
    $('grid').querySelectorAll('.gate button').forEach(b => b.addEventListener('click', () => {
      resolved[b.dataset.id] = b.dataset.act === 'approve' ? 'approved' : 'rejected';
      if (b.dataset.act === 'approve') { const needs = $('needs'); if (needs) needs.style.display = 'none'; }
      renderTeam();
    }));
    wireDragReorder();
    applyFilter();
  }

  // ===== Dash-C: drag-to-reorder (HTML5 DnD + pointer/touch fallback) =====
  function wireDragReorder() {
    const grid = $('grid');
    if (!grid) return;
    const cards = Array.from(grid.querySelectorAll('.card'));

    cards.forEach(card => {
      // The drag handle keeps the card draggable only when the grip is grabbed,
      // so text selection / gate clicks elsewhere on the card stay intact.
      const handle = card.querySelector('.drag');

      // --- HTML5 drag & drop (desktop) ---
      card.addEventListener('dragstart', (e) => {
        card.classList.add('dragging');
        try { e.dataTransfer.setData('text/plain', card.dataset.id); e.dataTransfer.effectAllowed = 'move'; } catch { /* noop */ }
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        cards.forEach(c => c.classList.remove('drag-over'));
      });
      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        card.classList.add('drag-over');
      });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('drag-over');
        let srcId = '';
        try { srcId = e.dataTransfer.getData('text/plain'); } catch { /* noop */ }
        const dstId = card.dataset.id;
        if (!srcId || srcId === dstId) return;
        // drop after the target if released on its lower half
        const r = card.getBoundingClientRect();
        const after = (e.clientY - r.top) > r.height / 2;
        if (moveInRoster(srcId, dstId, after)) { persistOrder(); renderTeam(); }
      });

      // --- Pointer/touch fallback (works at 390px) ---
      if (handle) {
        handle.addEventListener('pointerdown', (e) => startPointerDrag(e, card));
        // Don't let a grip drag start a native text selection / scroll.
        handle.addEventListener('dragstart', (e) => e.preventDefault());
      }
    });
  }

  // Pointer-based reorder for touch/coarse pointers: grab the grip, move over
  // another card, release to drop. Mirrors the HTML5 path and persists the same
  // localStorage order — so reorder survives reload on mobile too.
  let pdrag = null;
  function startPointerDrag(e, card) {
    // Only drive the fallback for non-mouse (touch / pen); mouse uses HTML5 DnD.
    if (e.pointerType === 'mouse') return;
    e.preventDefault();
    pdrag = { srcId: card.dataset.id, card, overId: null, after: false };
    card.classList.add('grabbed');
    try { e.target.setPointerCapture(e.pointerId); } catch { /* noop */ }
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp, { once: true });
    window.addEventListener('pointercancel', onPointerUp, { once: true });
  }
  function onPointerMove(e) {
    if (!pdrag) return;
    e.preventDefault();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const over = el && el.closest ? el.closest('.card') : null;
    const grid = $('grid');
    grid.querySelectorAll('.card.drag-over').forEach(c => c.classList.remove('drag-over'));
    if (over && over.dataset.id !== pdrag.srcId) {
      over.classList.add('drag-over');
      const r = over.getBoundingClientRect();
      pdrag.overId = over.dataset.id;
      pdrag.after = (e.clientY - r.top) > r.height / 2;
    } else {
      pdrag.overId = null;
    }
  }
  function onPointerUp() {
    if (!pdrag) return;
    const { srcId, overId, after, card } = pdrag;
    const grid = $('grid');
    if (grid) grid.querySelectorAll('.card.drag-over').forEach(c => c.classList.remove('drag-over'));
    card.classList.remove('grabbed');
    pdrag = null;
    window.removeEventListener('pointermove', onPointerMove);
    if (overId && overId !== srcId && moveInRoster(srcId, overId, after)) { persistOrder(); renderTeam(); }
  }

  // ===== Dash-C: live filtering (chip + text query) =====
  function applyFilter() {
    const grid = $('grid');
    if (!grid) return;
    const q = filterState.query.trim().toLowerCase();
    const chip = filterState.chip;
    let shown = 0;
    grid.querySelectorAll('.card').forEach(card => {
      const fstatus = card.dataset.fstatus || 'idle';
      const matchChip = chip === 'all' || fstatus === chip;
      const hay = ((card.dataset.name || '') + ' ' + (card.dataset.role || '')).toLowerCase();
      const matchText = !q || hay.indexOf(q) !== -1;
      const visible = matchChip && matchText;
      if (visible) { card.removeAttribute('hidden'); shown++; }
      else { card.setAttribute('hidden', ''); }
    });
    const empty = $('grid-empty');
    if (empty) empty.style.display = shown ? 'none' : 'block';
    updateChipCounts();
  }

  // Each chip carries a live count of how many cards (matching the text query)
  // would fall into that bucket — recomputed on every render / filter change.
  function updateChipCounts() {
    const grid = $('grid');
    if (!grid) return;
    const q = filterState.query.trim().toLowerCase();
    const counts = { all: 0, working: 0, idle: 0, needs: 0 };
    grid.querySelectorAll('.card').forEach(card => {
      const hay = ((card.dataset.name || '') + ' ' + (card.dataset.role || '')).toLowerCase();
      if (q && hay.indexOf(q) === -1) return;
      counts.all++;
      const f = card.dataset.fstatus;
      if (f === 'working') counts.working++;
      else if (f === 'idle') counts.idle++;
      else if (f === 'needs') counts.needs++;
    });
    document.querySelectorAll('#filter-chips .chip .n').forEach(n => {
      const k = n.getAttribute('data-count');
      if (k in counts) n.textContent = String(counts[k]);
    });
  }

  function wireFilters() {
    const chipBar = $('filter-chips');
    if (chipBar) {
      chipBar.addEventListener('click', (e) => {
        const btn = e.target.closest('.chip');
        if (!btn) return;
        filterState.chip = btn.dataset.filter || 'all';
        chipBar.querySelectorAll('.chip').forEach(c =>
          c.setAttribute('aria-pressed', String(c === btn)));
        applyFilter();
      });
    }
    const q = $('filter-q');
    if (q) q.addEventListener('input', () => { filterState.query = q.value; applyFilter(); });
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
      last = lastBy[a.id] || T('board.last.acted');
      feed = feedBy[a.id] || [];
    } else {
      status = res === 'approved' ? 'healthy' : res === 'rejected' ? 'idle' : (a.status || 'idle');
      last = res === 'approved' ? T('board.last.approved')
           : res === 'rejected' ? T('board.last.rejected')
           : (tSample(a) || T('board.last.auto'));
      feed = tFeed(a);
    }
    return { isLive, status, last, feed };
  }

  function openDrill(id) {
    const a = ROSTER.find(x => x.id === id);
    if (!a) return;
    const v = agentView(a);
    const role = tRole(a);
    const tag = v.isLive
      ? `<span class="live-tag"><i></i>${esc(T('board.live'))}</span>`
      : `<span class="sample">${esc(T('board.tag.sample'))}</span>`;
    const fn = (T('board.fn.' + a.id) !== ('board.fn.' + a.id)) ? T('board.fn.' + a.id) : (FN[a.id] || role);
    const feedHtml = v.feed.length
      ? `<div class="drill-feed-h">${esc(v.isLive ? T('board.drill.recent') : T('board.drill.sample'))}</div>
         <ul class="drill-feed">${v.feed.map(l => `<li><i>▸</i><span>${esc(l)}</span></li>`).join('')}</ul>`
      : `<div class="drill-empty">${esc(T('board.drill.noactivity'))}</div>`;

    $('drill-body').innerHTML = `
      <div class="drill-head" style="--hue:var(--agent-${a.color})">
        <span class="av"><span class="face"><img alt="" src="${face(a.name)}"/></span><span class="role-badge" aria-hidden="true">${a.emoji}</span></span>
        <div class="meta"><div class="nm" id="drill-name">${esc(a.name)} ${tag}</div><div class="rl">${esc(role)}</div></div>
        <span class="pill ${v.status}">${statusLabel(v.status)}</span>
      </div>
      <p class="drill-fn">${esc(fn)}</p>
      <div class="drill-rows">
        <div class="drill-row"><span class="k">${esc(T('board.drill.k.status'))}</span><span class="v">${statusLabel(v.status)}</span></div>
        <div class="drill-row"><span class="k">${esc(T('board.drill.k.function'))}</span><span class="v">${esc(role)}</span></div>
        <div class="drill-row"><span class="k">${esc(T('board.drill.k.source'))}</span><span class="v">${esc(v.isLive ? T('board.drill.src.live') : T('board.drill.src.sample'))}</span></div>
        <div class="drill-row"><span class="k">${esc(T('board.drill.k.last'))}</span><span class="v">${esc(v.last)}</span></div>
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
    reply.textContent = T('board.ask.thinking');
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
      reply.textContent = T('board.ask.err');
    } finally {
      btn.disabled = false;
    }
  }

  const ACCT_BTN = 'border:1px solid var(--border);background:var(--surface-sunken);border-radius:var(--radius-pill);padding:6px 13px;font:600 12.5px var(--font-display);color:var(--ink-2);cursor:pointer';

  // My Sites. The device-memory flow (card jvsQp6cS) runs for everyone and is
  // the ENTIRE behavior on the auth-off deploy. When sign-in is configured
  // (card VI673sym) an account overlay layers on top: signed in → the account's
  // sites cross-device; signed out → the device list + a sign-in chip. So the
  // auth-off board behaves exactly as it did before the login gate landed.
  async function renderMySites() {
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
        // The server list may add deep-linked / cross-page sites — re-render the
        // switcher against the merged list (reuses this fetch; no new request).
        renderSwitcher();
      }
    } catch { /* offline or server unreachable — the local list already painted */ }

    // ---- account overlay — only on the auth-enabled (real-app) deploy ----
    if (!window.RSB_AUTH) return;
    let cfg;
    try { cfg = await RSB_AUTH.config(); } catch { return; }
    if (!cfg || !cfg.authEnabled) return; // auth-off deploy: device memory is the whole story
    if (cfg.me) {
      let acct = [];
      try {
        acct = (await RSB_AUTH.mySites())
          .map(s => ({ id: s.id, url: s.url, business: s.business, at: Date.parse(s.createdAt) || 0 }));
      } catch { /* keep the device list painted above */ }
      if (acct.length) { mySites = acct; paintMySites(acct); renderSwitcher(); }
      $('mysites').style.display = 'block';
      $('mysites-label').textContent = T('board.mysites.label.account');
      $('mysites-acct').innerHTML = `<span>${esc(cfg.me.email || T('board.mysites.signedin'))}</span><button id="acct-out" style="${ACCT_BTN}">${esc(T('board.mysites.signout'))}</button>`;
      $('acct-out').addEventListener('click', () => RSB_AUTH.signOut().then(() => location.reload()));
    } else {
      // signed out on an auth-on deploy: invite sign-in (device list stays painted).
      $('mysites').style.display = 'block';
      $('mysites-acct').innerHTML = `<button id="acct-in" style="${ACCT_BTN}">${esc(T('board.mysites.signin'))}</button>`;
      $('acct-in').addEventListener('click', () =>
        RSB_AUTH.signIn().then(() => renderMySites()).catch(() => { /* user closed the popup */ }));
    }
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
  wireFilters();
  renderTheo();
  renderTeam();
  renderMySites();
})();
