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

  const I18N = {
    en: {
      brand: 'Your AI ops team',
      theoName: 'Theo', theoRole: 'Orchestrator · runs the whole team for you',
      askLabel: 'Talk to the team — only if you wish',
      askBtn: 'Ask Theo', askHint: 'Copy tweaks, a new section, a question — Theo routes it to the right agent. You’ll never need to chase anyone.',
      isLive: 'is live:', noSite: 'No site from this session yet — build one first and publish it; it will appear here.',
      teamTitle: 'The team', teamSub: 'LIVE = acted in your build just now · the rest run quietly in the background',
      footLine: 'Build agents run on Google Cloud Agent Builder (ADK) on Vertex AI Agent Engine · every run traced to Arize Phoenix via MCP · roster agents not in this run show sample data.',
      back: '← Build another site',
      needsTx: '<b>One decision waits for you</b> — Uri proposes a core update (sample item). Everything else is handled.',
      later: 'Later', approve: 'Approve',
      saySite: (b, n) => `Welcome back. <b>${b}</b> is live and healthy — my team of ${n} agents built it and now keeps it running. You don’t need to do anything; I’ll only ask when a decision is truly yours.`,
      sayNoSite: 'Hi, I’m Theo. Once you build and publish a site, my team takes over the day-to-day — monitoring, updates, security — and I report here in plain language.',
      statAgents: 'agents on the job', statSeo: 'SEO score · Sam', statTraced: 'run traced · Arize', statShipped: 'shipped & live',
      thinking: 'Theo is thinking…', askFail: 'Couldn’t reach Theo right now — try again in a moment.',
      sample: 'sample', liveNow: 'in your build',
      handled: 'Handled automatically — nothing for you to do.'
    },
    he: {
      brand: 'צוות ה-AI שלך',
      theoName: 'תיאו', theoRole: 'מנצח · מנהל את כל הצוות בשבילך',
      askLabel: 'דברו עם הצוות — רק אם בא לכם',
      askBtn: 'שאלו את תיאו', askHint: 'שינוי קופי, מקטע חדש, שאלה — תיאו ינתב לסוכן הנכון. לעולם לא תצטרכו לרדוף אחרי אף אחד.',
      isLive: 'באוויר:', noSite: 'עוד אין אתר מהסשן הזה — בנו אתר ופרסמו אותו, והוא יופיע כאן.',
      teamTitle: 'הצוות', teamSub: 'LIVE = פעלו בבנייה שלכם ממש עכשיו · השאר עובדים ברקע בשקט',
      footLine: 'סוכני הבנייה רצים על Google Cloud Agent Builder (ADK) ב-Vertex AI Agent Engine · כל ריצה מתועדת ב-Arize Phoenix דרך MCP · סוכנים שלא השתתפו בריצה מציגים נתוני דוגמה.',
      back: '→ לבנות אתר נוסף',
      needsTx: '<b>החלטה אחת מחכה לך</b> — אורי מציע עדכון ליבה (פריט דוגמה). כל השאר מטופל.',
      later: 'אחר־כך', approve: 'אישור',
      saySite: (b, n) => `ברוכים השבים. <b>${b}</b> באוויר ותקין — צוות של ${n} סוכנים בנה אותו ועכשיו מתחזק אותו. אין מה לעשות; אפנה אליך רק כשההחלטה באמת שלך.`,
      sayNoSite: 'היי, אני תיאו. אחרי שתבנו ותפרסמו אתר, הצוות שלי ייקח את היומיום — ניטור, עדכונים, אבטחה — ואני אדווח כאן בשפה פשוטה.',
      statAgents: 'סוכנים במשימה', statSeo: 'ציון SEO · סם', statTraced: 'ריצה מתועדת · אריז', statShipped: 'פורסם וחי',
      thinking: 'תיאו חושב…', askFail: 'לא הצלחנו להגיע לתיאו כרגע — נסו שוב עוד רגע.',
      sample: 'דוגמה', liveNow: 'בבנייה שלך',
      handled: 'מטופל אוטומטית — אין מה לעשות.'
    }
  };

  const ROSTER = [
    { id: 'aria', name: 'Aria', nameHe: 'אריה', emoji: '🔍', color: 'violet', role: 'Research', roleHe: 'מחקר', crew: 'build' },
    { id: 'leo', name: 'Leo', nameHe: 'ליאו', emoji: '🎨', color: 'blue', role: 'Layout', roleHe: 'פריסה', crew: 'build' },
    { id: 'noa', name: 'Noa', nameHe: 'נועה', emoji: '✍️', color: 'pink', role: 'Copy · HE/EN', roleHe: 'קופי · עב/אנ', crew: 'build' },
    { id: 'sam', name: 'Sam', nameHe: 'סם', emoji: '📈', color: 'green', role: 'SEO', roleHe: 'קידום', crew: 'build' },
    { id: 'max', name: 'Max', nameHe: 'מקס', emoji: '🚀', color: 'orange', role: 'Publish', roleHe: 'פרסום', crew: 'build' },
    { id: 'phoenix', name: 'Phoenix', nameHe: 'פיניקס', emoji: '🔭', color: 'purple', role: 'Arize · tracing', roleHe: 'אריז · מעקב', crew: 'observe' },
    { id: 'vera', name: 'Vera', nameHe: 'ורה', emoji: '🩺', color: 'green', role: 'Monitor', roleHe: 'ניטור', crew: 'operate',
      sample: { en: 'Uptime watch armed for your site', he: 'ניטור זמינות דרוך לאתר שלך' }, status: 'healthy' },
    { id: 'ben', name: 'Ben', nameHe: 'בן', emoji: '💾', color: 'teal', role: 'Backup', roleHe: 'גיבוי', crew: 'operate',
      sample: { en: 'Daily backup scheduled', he: 'גיבוי יומי מתוזמן' }, status: 'idle' },
    { id: 'uri', name: 'Uri', nameHe: 'אורי', emoji: '⬆️', color: 'amber', role: 'Updates', roleHe: 'עדכונים', crew: 'operate',
      sample: { en: 'Core update proposed · awaiting your call', he: 'עדכון ליבה מוצע · ממתין להחלטתך' }, status: 'working' },
    { id: 'gil', name: 'Gil', nameHe: 'גיל', emoji: '🛡️', color: 'coral', role: 'Security', roleHe: 'אבטחה', crew: 'operate',
      sample: { en: 'Threat watch on · 0 open findings', he: 'ניטור איומים פעיל · 0 ממצאים פתוחים' }, status: 'healthy' },
    { id: 'tova', name: 'Tova', nameHe: 'טובה', emoji: '📝', color: 'sky', role: 'Content · SEO', roleHe: 'תוכן · קידום', crew: 'operate',
      sample: { en: 'Content freshness watch armed', he: 'ניטור רעננות תוכן דרוך' }, status: 'idle' },
    { id: 'cara', name: 'Cara', nameHe: 'קארה', emoji: '🔐', color: 'lime', role: 'Certificates', roleHe: 'אישורים', crew: 'operate',
      sample: { en: 'TLS auto-renew armed', he: 'חידוש TLS אוטומטי דרוך' }, status: 'healthy' }
  ];

  let lang = (state && state.lang) === 'he' ? 'he' : 'en';

  function t(key) { return I18N[lang][key]; }
  function esc(s) { const d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; }

  function renderChrome() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
    document.querySelectorAll('[data-t]').forEach(el => {
      const v = t(el.dataset.t);
      if (typeof v === 'string') el.textContent = v;
    });
    $('lang-en').setAttribute('aria-pressed', String(lang === 'en'));
    $('lang-he').setAttribute('aria-pressed', String(lang === 'he'));
    $('ask-in').placeholder = lang === 'he' ? 'למשל: תחליפו את תמונת הפתיחה למשהו חמים יותר' : 'e.g. Make the hero warmer, or add a FAQ section';
  }

  function renderTheo() {
    const ran = state ? (state.agentsRan || []).filter(a => a !== 'orchestrator') : [];
    if (state && state.url) {
      $('theo-say').innerHTML = I18N[lang].saySite(esc(state.business || 'Your site'), Math.max(ran.length, 5));
      $('site-chip').style.display = 'flex';
      $('site-name').textContent = state.business || '';
      const a = $('site-link'); a.href = state.url; a.textContent = state.url.replace(/^https?:\/\//, '');
      const shot = $('shot');
      shot.classList.remove('empty');
      shot.innerHTML = `<iframe src="${esc(state.url)}" sandbox title="Live site preview" loading="lazy"></iframe><a class="open" href="${esc(state.url)}" target="_blank" rel="noopener">${lang === 'he' ? 'פתחו את האתר ↗' : 'Open site ↗'}</a>`;
    } else {
      $('theo-say').innerHTML = I18N[lang].sayNoSite;
    }
    const stats = [];
    if (ran.length) stats.push([String(ran.length), t('statAgents')]);
    if (state && state.seoScore) stats.push([String(state.seoScore), t('statSeo')]);
    if (state && (state.agentsRan || []).includes('phoenix')) stats.push(['✓', t('statTraced')]);
    if (state && state.url) stats.push(['✓', t('statShipped')]);
    $('stats').innerHTML = stats.map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
    // demo approval strip (sample item, clearly labeled)
    const needs = $('needs');
    needs.style.display = 'flex';
    $('needs-tx').innerHTML = t('needsTx');
    $('needs-later').textContent = t('later');
    $('needs-ok').textContent = t('approve');
    $('needs-later').onclick = () => { needs.style.display = 'none'; };
    $('needs-ok').onclick = () => {
      $('needs-tx').innerHTML = lang === 'he' ? '✅ אושר — אורי מטפל בזה. זהו, סיימת.' : '✅ Approved — Uri is on it. That’s all you needed to do.';
      $('needs-ok').style.display = 'none'; $('needs-later').style.display = 'none';
      setTimeout(() => { needs.style.display = 'none'; }, 3500);
    };
  }

  function renderTeam() {
    const ran = new Set(state ? state.agentsRan || [] : []);
    const lastBy = (state && state.lastByAgent) || {};
    // map landing personas → roster ids (brief → aria)
    if (ran.has('brief')) { ran.add('aria'); if (lastBy.brief) lastBy.aria = lastBy.brief; }
    const cards = ROSTER.map(a => {
      const isLive = ran.has(a.id);
      const name = lang === 'he' ? a.nameHe : a.name;
      const role = lang === 'he' ? a.roleHe : a.role;
      let status, last, tag;
      if (isLive) {
        status = a.id === 'max' && state && state.url ? 'healthy' : 'healthy';
        last = lastBy[a.id] || (lang === 'he' ? 'פעל בבנייה האחרונה שלך' : 'Acted in your last build');
        tag = `<span class="live-tag"><i></i>LIVE</span>`;
      } else {
        status = a.status || 'idle';
        last = a.sample ? a.sample[lang] : t('handled');
        tag = '';
      }
      const statusLabel = {
        en: { healthy: 'Healthy', working: 'Working', stuck: 'Needs approval', idle: 'Idle' },
        he: { healthy: 'תקין', working: 'עובד', stuck: 'דרוש אישור', idle: 'ממתין' }
      }[lang][status];
      return `<article class="card" style="--hue:var(--agent-${a.color})">
        <span class="bar" aria-hidden="true"></span>
        <header>
          <span class="av" aria-hidden="true">${a.emoji}</span>
          <div class="meta"><div class="nm">${esc(name)} ${tag}</div><div class="rl">${esc(role)}</div></div>
          <span class="pill ${status}">${statusLabel}</span>
        </header>
        <p class="last">${esc(last)}</p>
        ${isLive ? '' : `<span class="sample">${t('sample')}</span>`}
      </article>`;
    });
    $('grid').innerHTML = cards.join('');
  }

  async function ask() {
    const q = $('ask-in').value.trim();
    if (!q) return;
    const btn = $('ask-go'), reply = $('ask-reply');
    btn.disabled = true;
    reply.style.display = 'block';
    reply.textContent = t('thinking');
    try {
      const r = await fetch(API + '/api/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: q,
          business: state ? state.business : '',
          url: state ? state.url : '',
          lang
        })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'ask failed');
      reply.textContent = j.reply || '…';
    } catch {
      reply.textContent = t('askFail');
    } finally {
      btn.disabled = false;
    }
  }

  function renderAll() { renderChrome(); renderTheo(); renderTeam(); }
  $('lang-en').addEventListener('click', () => { lang = 'en'; renderAll(); });
  $('lang-he').addEventListener('click', () => { lang = 'he'; renderAll(); });
  $('ask-go').addEventListener('click', ask);
  $('ask-in').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
  renderAll();
})();
