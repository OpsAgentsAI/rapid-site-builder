/* Rapid Site Builder — bilingual chrome (English / feminine Hebrew + RTL).
 *
 * The build engine already speaks Hebrew: POST /api/build with {lang:'he'} keeps
 * the crew's Hebrew output and stamps the spec lang (server.js). This file is the
 * APP SHELL i18n — it picks the UI language, sets <html lang/dir>, translates
 * tagged strings, renders a language switcher, and exposes RSB_I18N.t() so the
 * inline page scripts can localize the strings they build at runtime.
 *
 * Tagging in HTML:
 *   data-i18n="key"        → textContent
 *   data-i18n-html="key"   → innerHTML (strings that carry <em>/<b>/<a>)
 *   data-i18n-ph="key"     → placeholder attribute
 *   data-i18n-aria="key"   → aria-label attribute
 *
 * Language is resolved (highest first): ?lang= → saved choice → host default
 * (a *-he. hostname or <html data-default-lang="he">) → en. The canonical URL
 * stays English; Hebrew has its own URL + the in-page switcher.
 * Hebrew copy is FEMININE throughout (house rule — the user is addressed as "את").
 */
(function () {
  const STRINGS = {
    en: {
      'doc.title': 'Rapid Site Builder — your AI web team, live',
      'lang.toggle': 'עברית',
      'lang.aria': 'Switch language',
      // intake
      'hero.h1': 'Meet the AI team that builds your website <em>in front of you</em>',
      'hero.sub': 'One line about your business. Five specialist agents — research, design, copy, SEO, observability — go to work live. Watch them ship your site. Free.',
      'chip.1': 'Neighborhood specialty coffee bar in Tel Aviv',
      'chip.2': 'Boutique pilates studio for busy parents',
      'chip.3': 'Family real-estate agency, 20 years in the Sharon',
      'chip.4': 'Cozy neighborhood bakery with a wood-fired oven',
      'label.business': 'Business name',
      'label.category': 'Category',
      'label.description': 'One line about it',
      'label.style': 'Vibe (optional)',
      'ph.business': 'Cafe Luna',
      'ph.description': 'Specialty coffee roasted in-house, pastries from our own oven',
      'cat.food_beverage': 'Food & beverage',
      'cat.retail': 'Retail & shop',
      'cat.beauty': 'Beauty & wellness',
      'cat.health': 'Health & clinics',
      'cat.fitness': 'Fitness & studio',
      'cat.professional': 'Professional services',
      'cat.tech': 'Tech & startup',
      'cat.real_estate': 'Real estate',
      'cat.education': 'Education',
      'cat.events': 'Events & hospitality',
      'cat.other': 'Other — let the team figure it out',
      'style.default': 'Let the team pick',
      'style.warm': 'Warm',
      'style.fresh': 'Fresh',
      'style.modern': 'Modern',
      'style.trust': 'Trustworthy',
      'style.bold': 'Bold',
      'media.label': 'Your photos & videos',
      'media.opt': '(optional — the team features them on your site)',
      'media.drop': 'Drop files here or',
      'media.browse': 'browse',
      'media.limits': '— up to 8 · photos ≤15MB · video ≤100MB',
      'go': 'Build my site — watch the team work',
      'free': 'Free · no signup · about two minutes',
      'restore.saved': '💾 Your last build is saved on this device —',
      'restore.bring': 'Bring it back',
      // show
      'show.title': 'Your AI team is on it',
      'phase.0': 'Research & layout',
      'phase.1': 'Copy & SEO',
      'phase.2': 'Observability',
      'phase.3': 'Final assembly',
      'preview.url': 'preview — built by your agent team',
      'publish': 'Publish it — free',
      'board.link': 'Meet your ops team',
      'again': 'Build another',
      'live.label': 'Live:',
      'copy': 'Copy',
      'arize.banner': '<b>Phoenix</b> recorded this run to <b>Arize Phoenix</b> through its MCP server — every agent turn is traced.',
      'console.bar': 'the team, live · Vertex AI Agent Engine',
      'footer': 'Built with <b>Google Cloud Agent Builder (ADK)</b> on Vertex AI Agent Engine · <b>Gemini</b> + Nano Banana Pro (Gemini 3) image generation · <b>Arize Phoenix MCP</b> observability · no other AI anywhere. · <a href="/campfire">The campfire</a>',
      // crew roles
      'role.theo': 'Orchestrator',
      'role.brief': 'Business research',
      'role.leo': 'Layout & art direction',
      'role.noa': 'Copywriter',
      'role.sam': 'SEO',
      'role.phoenix': 'Observability · Arize MCP',
      'role.max': 'Publisher · human-gated',
      'pill.queued': 'queued',
      'pill.working': 'working',
      'pill.done': 'done',
      // dynamic runtime strings ({business} interpolated)
      'dyn.greeting': 'Got it — {business}. Briefing the team now; Aria opens with research.',
      'dyn.hero': 'Hero photography is in — picked from our Gemini image studio.',
      'dyn.purl.draft': '{business} — first draft · the team is refining it live',
      'dyn.pstate.draft': 'first draft',
      'dyn.title.draft': 'First draft is up — the team is refining it',
      'dyn.purl.site': '{business} — built live by the crew',
      'dyn.pstate.site': 'refined by the team',
      'dyn.title.ready': 'Your site is ready',
      'dyn.err.snag': 'The live crew hit a snag mid-run — your first draft below is ready and publishable; build again for the fully refined version.',
      'dyn.publishing': 'Publishing…',
      'dyn.signin': 'Sign in to publish…',
      'dyn.purl.restore': '{business} — restored from this device',
      'dyn.pstate.restore': 'restored',
      'dyn.title.restore': 'Your site is back — publish when ready',
      'dyn.yourbiz': 'your business',
      // ===== /board operate console =====
      'board.doc.title': 'Your AI ops team',
      'board.crumb': 'Your AI ops team',
      'board.live': 'LIVE',
      // Theo hero
      'board.theo.role': 'Orchestrator · runs the whole team for you',
      'board.switcher.label': 'Operating',
      'board.switcher.aria': 'Switch which site Theo operates',
      'board.ask.label': 'Talk to the team — only if you wish',
      'board.ask.ph': 'e.g. Make the hero warmer, or add a FAQ section',
      'board.ask.btn': 'Ask Theo',
      'board.ask.hint': "Copy tweaks, a new section, a question — Theo routes it to the right agent. You'll never need to chase anyone.",
      'board.ask.thinking': 'Theo is thinking…',
      'board.ask.err': "Couldn’t reach Theo right now — try again in a moment.",
      'board.shot.empty': 'No site from this session yet — build one first and publish it; it will appear here.',
      'board.shot.nopreview': 'No preview available for this site.',
      'board.shot.previewtitle': 'Live site preview',
      'board.shot.open': 'Open site',
      'board.site.live': 'is live:',
      // needs-you strip
      'board.needs.later': 'Later',
      'board.needs.approve': 'Approve',
      'board.needs.tx': '<b>One decision waits for you</b> — Uri proposes a core update (sample item). Everything else is handled.',
      'board.needs.approved': 'Approved — Uri is on it. That’s all you needed to do.',
      // my-sites
      'board.mysites.title': 'Your sites',
      'board.mysites.label.device': 'saved on this device',
      'board.mysites.label.account': 'on your account',
      'board.mysites.signout': 'Sign out',
      'board.mysites.signin': 'Sign in — see your sites on any device',
      'board.mysites.signedin': 'signed in',
      // team section
      'board.team.h': 'The team',
      'board.team.sub': 'LIVE = acted in your build just now · the rest run quietly in the background',
      // filters
      'board.filter.all': 'All',
      'board.filter.working': 'Working',
      'board.filter.idle': 'Idle',
      'board.filter.needs': 'Needs you',
      'board.filter.ph': 'Filter by name or role…',
      'board.filter.aria': 'Filter agents by name or role',
      'board.filter.empty': 'No agents match this filter.',
      // drill-in panel
      'board.drill.close': 'Close panel',
      'board.drill.recent': 'Recent activity',
      'board.drill.sample': 'Sample activity',
      'board.drill.noactivity': 'No recent activity lines for this agent yet.',
      'board.drill.k.status': 'Status',
      'board.drill.k.function': 'Function',
      'board.drill.k.source': 'Source',
      'board.drill.k.last': 'Last activity',
      'board.drill.src.live': 'LIVE — acted in your last build',
      'board.drill.src.sample': 'SAMPLE — illustrative, no run this session',
      // footer
      'board.foot': 'Build agents run on Google Cloud Agent Builder (ADK) on Vertex AI Agent Engine · every run traced to Arize Phoenix via MCP · roster agents not in this run show sample data.',
      'board.foot.again': 'Build another site',
      'board.foot.campfire': 'After hours: the team campfire',
      // status pills
      'board.status.healthy': 'Healthy',
      'board.status.working': 'Working',
      'board.status.stuck': 'Needs approval',
      'board.status.idle': 'Idle',
      // card tags
      'board.tag.sample': 'sample',
      'board.gate.label': 'Human approval',
      'board.gate.reject': 'Reject',
      'board.gate.approve': 'Approve',
      'board.card.aria': '{name} — {role}, open details',
      'board.drag.aria': 'Reorder {name}',
      'board.drag.title': 'Drag to reorder',
      // Theo greetings ({business} / {n} interpolated)
      'board.theo.intro': 'Hi, I’m Theo. Once you build and publish a site, my team takes over the day-to-day — monitoring, updates, security — and I report here in plain language.',
      'board.theo.live': 'Welcome back. <b>{business}</b> is live and healthy — my team of {n} agents built it and now keeps it running. You don’t need to do anything; I’ll only ask when a decision is truly yours.',
      'board.theo.reduced': 'Welcome back — <b>{business}</b> is live. My team keeps it monitored, updated, and secure; I’ll only ask you when a decision is truly yours.',
      'board.theo.yoursite': 'Your site',
      'board.theo.yourbiz': 'your site',
      // stat labels
      'board.stat.agents': 'agents on the job',
      'board.stat.seo': 'SEO score · Sam',
      'board.stat.traced.v': 'Traced',
      'board.stat.traced.l': 'run logged · Arize',
      'board.stat.live.v': 'Live',
      'board.stat.live.l': 'shipped to the web',
      // per-agent metric labels (live)
      'board.metric.seo': 'SEO score · your site',
      'board.metric.shipped': 'shipped to the web',
      // generic card last-action lines
      'board.last.acted': 'Acted in your last build',
      'board.last.approved': 'Approved — on it',
      'board.last.rejected': 'Rejected — staying as is',
      'board.last.auto': 'Handled automatically — nothing for you to do.',
      // ROSTER — names, roles, samples, metric labels, feed lines (operate crew)
      'board.role.aria': 'Research',
      'board.role.leo': 'Layout',
      'board.role.noa': 'Copywriter',
      'board.role.sam': 'SEO',
      'board.role.max': 'Publish',
      'board.role.phoenix': 'Arize · tracing',
      'board.role.vera': 'Monitor',
      'board.role.ben': 'Backup',
      'board.role.uri': 'Updates',
      'board.role.gil': 'Security',
      'board.role.tova': 'Content · SEO',
      'board.role.cara': 'Certificates',
      'board.sample.vera': 'Uptime watch armed for your site',
      'board.sample.ben': 'Daily backup scheduled',
      'board.sample.uri': 'Core update proposed · awaiting your call',
      'board.sample.gil': 'Threat watch on · 0 open findings',
      'board.sample.tova': 'Content freshness watch armed',
      'board.sample.cara': 'TLS auto-renew armed',
      'board.mlabel.vera': 'uptime watch',
      'board.mlabel.uri': 'proposal waiting',
      'board.mlabel.gil': 'open findings',
      'board.mlabel.cara': 'auto-renew armed',
      'board.feed.vera.0': 'probe_site_health → armed',
      'board.feed.vera.1': 'TLS check scheduled',
      'board.feed.ben.0': 'snapshot plan: daily 03:00',
      'board.feed.ben.1': 'restore drill scheduled',
      'board.feed.uri.0': 'check_updates → 1 behind',
      'board.feed.uri.1': 'filed proposal card',
      'board.feed.uri.2': 'parked — no change without you',
      'board.feed.gil.0': 'scan → clean',
      'board.feed.gil.1': 'rate-limit shield armed',
      'board.feed.tova.0': 'freshness scan scheduled',
      'board.feed.tova.1': 'internal-link audit queued',
      'board.feed.cara.0': 'TLS chain verified',
      'board.feed.cara.1': 'auto-renew armed',
      // FN — drill-in one-line function per agent
      'board.fn.aria': 'Researches your business, market and audience so the rest of the team builds on real ground.',
      'board.fn.leo': 'Designs the page layout and visual structure — sections, hierarchy and responsive grid.',
      'board.fn.noa': 'Writes the on-page copy: headlines, body and calls-to-action in your brand voice.',
      'board.fn.sam': 'Tunes on-page SEO — titles, meta, headings and structured data — for discoverability.',
      'board.fn.max': 'Publishes the finished site to the web and confirms it is live.',
      'board.fn.phoenix': 'Traces every agent run to Arize Phoenix so each decision is observable and auditable.',
      'board.fn.vera': 'Monitors uptime and site health around the clock and raises an alert the moment something slips.',
      'board.fn.ben': 'Runs scheduled backups and keeps a tested restore path so your site is always recoverable.',
      'board.fn.uri': 'Watches for core and dependency updates and files a proposal — never changing anything without your approval.',
      'board.fn.gil': 'Guards the site: security scans, threat watch and rate-limit shielding against abuse.',
      'board.fn.tova': 'Keeps content fresh and internal links healthy, flagging pages that need a refresh.',
      'board.fn.cara': 'Manages TLS certificates and auto-renewal so the padlock never lapses.'
    },
    he: {
      'doc.title': 'Rapid Site Builder — צוות ה-AI שבונה לך אתר, בשידור חי',
      'lang.toggle': 'EN',
      'lang.aria': 'החלפת שפה',
      'hero.h1': 'תכירי את צוות ה-AI שבונה לך אתר <em>מול העיניים</em>',
      'hero.sub': 'שורה אחת על העסק שלך. חמישה סוכנים מומחים — מחקר, עיצוב, קופי, SEO וניטור — נכנסים לעבודה בשידור חי. תראי אותם משיקים לך אתר. בחינם.',
      'chip.1': 'בית קפה שכונתי עם קפה מיוחד בתל אביב',
      'chip.2': 'סטודיו בוטיק לפילאטיס להורים עסוקים',
      'chip.3': 'סוכנות נדל״ן משפחתית, 20 שנה בשרון',
      'chip.4': 'מאפייה שכונתית נעימה עם תנור אבן',
      'label.business': 'שם העסק',
      'label.category': 'קטגוריה',
      'label.description': 'שורה אחת על העסק',
      'label.style': 'סגנון (לא חובה)',
      'ph.business': 'קפה לונה',
      'ph.description': 'קפה מיוחד שנקלה אצלנו, מאפים מהתנור שלנו',
      'cat.food_beverage': 'אוכל ומשקאות',
      'cat.retail': 'קמעונאות וחנות',
      'cat.beauty': 'יופי ורווחה',
      'cat.health': 'בריאות וקליניקות',
      'cat.fitness': 'כושר וסטודיו',
      'cat.professional': 'שירותים מקצועיים',
      'cat.tech': 'טכנולוגיה וסטארטאפ',
      'cat.real_estate': 'נדל״ן',
      'cat.education': 'חינוך',
      'cat.events': 'אירועים ואירוח',
      'cat.other': 'אחר — שהצוות יבין לבד',
      'style.default': 'שהצוות יבחר',
      'style.warm': 'חמים',
      'style.fresh': 'רענן',
      'style.modern': 'מודרני',
      'style.trust': 'אמין',
      'style.bold': 'נועז',
      'media.label': 'התמונות והסרטונים שלך',
      'media.opt': '(לא חובה — הצוות ישלב אותם באתר שלך)',
      'media.drop': 'גררי קבצים לכאן או',
      'media.browse': 'בחרי קובץ',
      'media.limits': '— עד 8 · תמונות עד 15MB · וידאו עד 100MB',
      'go': 'בנו לי אתר — תראי את הצוות עובד',
      'free': 'בחינם · בלי הרשמה · בערך שתי דקות',
      'restore.saved': '💾 הבנייה האחרונה שלך שמורה במכשיר הזה —',
      'restore.bring': 'החזירי אותה',
      'show.title': 'צוות ה-AI שלך על זה',
      'phase.0': 'מחקר ופריסה',
      'phase.1': 'קופי ו-SEO',
      'phase.2': 'ניטור',
      'phase.3': 'הרכבה סופית',
      'preview.url': 'תצוגה מקדימה — נבנתה על ידי צוות הסוכנים שלך',
      'publish': 'פרסמי אותו — בחינם',
      'board.link': 'הכירי את צוות התפעול',
      'again': 'בנו עוד אחד',
      'live.label': 'באוויר:',
      'copy': 'העתקה',
      'arize.banner': '<b>Phoenix</b> תיעד את הריצה הזו אל <b>Arize Phoenix</b> דרך שרת ה-MCP שלו — כל תור של סוכן נרשם.',
      'console.bar': 'הצוות, בשידור חי · Vertex AI Agent Engine',
      'footer': 'נבנה עם <b>Google Cloud Agent Builder (ADK)</b> על Vertex AI Agent Engine · <b>Gemini</b> + Nano Banana Pro (Gemini 3) ליצירת תמונות · ניטור <b>Arize Phoenix MCP</b> · בלי שום AI אחר. · <a href="/campfire">המדורה</a>',
      'role.theo': 'מנצח',
      'role.brief': 'מחקר עסקי',
      'role.leo': 'פריסה ובימוי אמנותי',
      'role.noa': 'קופירייטינג',
      'role.sam': 'SEO',
      'role.phoenix': 'ניטור · Arize MCP',
      'role.max': 'פרסום · באישור אדם',
      'pill.queued': 'בתור',
      'pill.working': 'עובד',
      'pill.done': 'הושלם',
      'dyn.greeting': 'קיבלתי — {business}. מתדרך את הצוות עכשיו; אריה פותחת במחקר.',
      'dyn.hero': 'צילומי הכותרת נכנסו — נבחרו מסטודיו התמונות של Gemini.',
      'dyn.purl.draft': '{business} — טיוטה ראשונה · הצוות משכלל אותה בשידור חי',
      'dyn.pstate.draft': 'טיוטה ראשונה',
      'dyn.title.draft': 'הטיוטה הראשונה עלתה — הצוות משכלל אותה',
      'dyn.purl.site': '{business} — נבנה בשידור חי על ידי הצוות',
      'dyn.pstate.site': 'שוכלל על ידי הצוות',
      'dyn.title.ready': 'האתר שלך מוכן',
      'dyn.err.snag': 'הצוות נתקל בתקלה באמצע — הטיוטה הראשונה למטה מוכנה וניתנת לפרסום; בני שוב לקבלת הגרסה המשוכללת המלאה.',
      'dyn.publishing': 'מפרסם…',
      'dyn.signin': 'התחברי כדי לפרסם…',
      'dyn.purl.restore': '{business} — שוחזר מהמכשיר הזה',
      'dyn.pstate.restore': 'שוחזר',
      'dyn.title.restore': 'האתר שלך חזר — פרסמי כשתהיי מוכנה',
      'dyn.yourbiz': 'העסק שלך',
      // ===== /board operate console =====
      'board.doc.title': 'צוות התפעול ה-AI שלך',
      'board.crumb': 'צוות התפעול ה-AI שלך',
      'board.live': 'באוויר',
      // Theo hero
      'board.theo.role': 'מנצח · מנהל לך את כל הצוות',
      'board.switcher.label': 'מתפעל',
      'board.switcher.aria': 'בחירת האתר שתאו מתפעל',
      'board.ask.label': 'דברי עם הצוות — רק אם בא לך',
      'board.ask.ph': 'למשל: תהפכו את הכותרת לחמימה יותר, או הוסיפו אזור שאלות נפוצות',
      'board.ask.btn': 'שאלי את תאו',
      'board.ask.hint': 'שינויי קופי, אזור חדש, שאלה — תאו מנתב את זה לסוכן הנכון. לעולם לא תצטרכי לרדוף אחרי אף אחד.',
      'board.ask.thinking': 'תאו חושב…',
      'board.ask.err': 'לא הצלחנו להגיע לתאו כרגע — נסי שוב עוד רגע.',
      'board.shot.empty': 'עדיין אין אתר מהסשן הזה — בני אחד קודם ופרסמי אותו; הוא יופיע כאן.',
      'board.shot.nopreview': 'אין תצוגה מקדימה לאתר הזה.',
      'board.shot.previewtitle': 'תצוגה מקדימה של האתר החי',
      'board.shot.open': 'פתחי את האתר',
      'board.site.live': 'באוויר:',
      // needs-you strip
      'board.needs.later': 'אחר כך',
      'board.needs.approve': 'אישור',
      'board.needs.tx': '<b>החלטה אחת מחכה לך</b> — אורי מציע עדכון ליבה (פריט לדוגמה). כל השאר מטופל.',
      'board.needs.approved': 'אושר — אורי על זה. זה כל מה שהיית צריכה לעשות.',
      // my-sites
      'board.mysites.title': 'האתרים שלך',
      'board.mysites.label.device': 'שמורים במכשיר הזה',
      'board.mysites.label.account': 'בחשבון שלך',
      'board.mysites.signout': 'התנתקי',
      'board.mysites.signin': 'התחברי — ראי את האתרים שלך מכל מכשיר',
      'board.mysites.signedin': 'מחוברת',
      // team section
      'board.team.h': 'הצוות',
      'board.team.sub': 'באוויר = פעל בבנייה שלך ממש עכשיו · השאר רצים בשקט ברקע',
      // filters
      'board.filter.all': 'הכול',
      'board.filter.working': 'עובדים',
      'board.filter.idle': 'בהמתנה',
      'board.filter.needs': 'דורשים אותך',
      'board.filter.ph': 'סינון לפי שם או תפקיד…',
      'board.filter.aria': 'סינון סוכנים לפי שם או תפקיד',
      'board.filter.empty': 'אין סוכנים שמתאימים לסינון הזה.',
      // drill-in panel
      'board.drill.close': 'סגירת הפאנל',
      'board.drill.recent': 'פעילות אחרונה',
      'board.drill.sample': 'פעילות לדוגמה',
      'board.drill.noactivity': 'עדיין אין שורות פעילות אחרונות לסוכן הזה.',
      'board.drill.k.status': 'סטטוס',
      'board.drill.k.function': 'תפקיד',
      'board.drill.k.source': 'מקור',
      'board.drill.k.last': 'פעילות אחרונה',
      'board.drill.src.live': 'באוויר — פעל בבנייה האחרונה שלך',
      'board.drill.src.sample': 'לדוגמה — להמחשה, לא רץ בסשן הזה',
      // footer
      'board.foot': 'סוכני הבנייה רצים על Google Cloud Agent Builder (ADK) על Vertex AI Agent Engine · כל ריצה מתועדת ל-Arize Phoenix דרך MCP · סוכנים שלא רצו בבנייה הזו מציגים נתוני דוגמה.',
      'board.foot.again': 'בני עוד אתר',
      'board.foot.campfire': 'אחרי שעות העבודה: המדורה של הצוות',
      // status pills
      'board.status.healthy': 'תקין',
      'board.status.working': 'עובד',
      'board.status.stuck': 'דורש אישור',
      'board.status.idle': 'בהמתנה',
      // card tags
      'board.tag.sample': 'דוגמה',
      'board.gate.label': 'אישור אנושי',
      'board.gate.reject': 'דחייה',
      'board.gate.approve': 'אישור',
      'board.card.aria': '{name} — {role}, לפתיחת פרטים',
      'board.drag.aria': 'שינוי סדר {name}',
      'board.drag.title': 'גררי לשינוי סדר',
      // Theo greetings ({business} / {n} interpolated)
      'board.theo.intro': 'היי, אני תאו. ברגע שתבני ותפרסמי אתר, הצוות שלי לוקח על עצמו את היומיום — ניטור, עדכונים, אבטחה — ואני מדווח כאן בשפה פשוטה.',
      'board.theo.live': 'ברוכה השבה. <b>{business}</b> באוויר ותקין — צוות של {n} סוכנים בנה אותו ועכשיו שומר עליו רץ. את לא צריכה לעשות כלום; אפנה אלייך רק כשההחלטה באמת שלך.',
      'board.theo.reduced': 'ברוכה השבה — <b>{business}</b> באוויר. הצוות שלי שומר עליו מנוטר, מעודכן ומאובטח; אפנה אלייך רק כשההחלטה באמת שלך.',
      'board.theo.yoursite': 'האתר שלך',
      'board.theo.yourbiz': 'האתר שלך',
      // stat labels
      'board.stat.agents': 'סוכנים על המשימה',
      'board.stat.seo': 'ציון SEO · סם',
      'board.stat.traced.v': 'מתועד',
      'board.stat.traced.l': 'ריצה נרשמה · Arize',
      'board.stat.live.v': 'באוויר',
      'board.stat.live.l': 'שוגר לרשת',
      // per-agent metric labels (live)
      'board.metric.seo': 'ציון SEO · האתר שלך',
      'board.metric.shipped': 'שוגר לרשת',
      // generic card last-action lines
      'board.last.acted': 'פעל בבנייה האחרונה שלך',
      'board.last.approved': 'אושר — על זה',
      'board.last.rejected': 'נדחה — נשאר כמו שהוא',
      'board.last.auto': 'מטופל אוטומטית — אין לך מה לעשות.',
      // ROSTER — names, roles, samples, metric labels, feed lines (operate crew)
      'board.role.aria': 'מחקר',
      'board.role.leo': 'פריסה',
      'board.role.noa': 'קופירייטינג',
      'board.role.sam': 'SEO',
      'board.role.max': 'פרסום',
      'board.role.phoenix': 'Arize · תיעוד',
      'board.role.vera': 'ניטור',
      'board.role.ben': 'גיבוי',
      'board.role.uri': 'עדכונים',
      'board.role.gil': 'אבטחה',
      'board.role.tova': 'תוכן · SEO',
      'board.role.cara': 'תעודות',
      'board.sample.vera': 'ניטור זמינות פעיל לאתר שלך',
      'board.sample.ben': 'גיבוי יומי מתוזמן',
      'board.sample.uri': 'הוצע עדכון ליבה · מחכה להחלטה שלך',
      'board.sample.gil': 'ניטור איומים פעיל · 0 ממצאים פתוחים',
      'board.sample.tova': 'ניטור רעננות תוכן פעיל',
      'board.sample.cara': 'חידוש TLS אוטומטי פעיל',
      'board.mlabel.vera': 'ניטור זמינות',
      'board.mlabel.uri': 'הצעה ממתינה',
      'board.mlabel.gil': 'ממצאים פתוחים',
      'board.mlabel.cara': 'חידוש אוטומטי פעיל',
      'board.feed.vera.0': 'probe_site_health → פעיל',
      'board.feed.vera.1': 'בדיקת TLS מתוזמנת',
      'board.feed.ben.0': 'תוכנית גיבוי: יומי 03:00',
      'board.feed.ben.1': 'תרגיל שחזור מתוזמן',
      'board.feed.uri.0': 'check_updates → פיגור של 1',
      'board.feed.uri.1': 'הוגש כרטיס הצעה',
      'board.feed.uri.2': 'בהמתנה — אין שינוי בלעדייך',
      'board.feed.gil.0': 'סריקה → נקי',
      'board.feed.gil.1': 'מגן הגבלת קצב פעיל',
      'board.feed.tova.0': 'סריקת רעננות מתוזמנת',
      'board.feed.tova.1': 'ביקורת קישורים פנימיים בתור',
      'board.feed.cara.0': 'שרשרת TLS אומתה',
      'board.feed.cara.1': 'חידוש אוטומטי פעיל',
      // FN — drill-in one-line function per agent
      'board.fn.aria': 'חוקרת את העסק, השוק והקהל שלך כדי שכל שאר הצוות יבנה על קרקע אמיתית.',
      'board.fn.leo': 'מעצב את פריסת העמוד והמבנה הוויזואלי — אזורים, היררכיה ורשת רספונסיבית.',
      'board.fn.noa': 'כותבת את הקופי בעמוד: כותרות, גוף וקריאות לפעולה בקול המותג שלך.',
      'board.fn.sam': 'מכוונן SEO בעמוד — כותרות, מטא, כותרות ונתונים מובנים — לנראות בחיפוש.',
      'board.fn.max': 'מפרסם את האתר המוגמר לרשת ומוודא שהוא באוויר.',
      'board.fn.phoenix': 'מתעד כל ריצת סוכן ל-Arize Phoenix כך שכל החלטה ניתנת לצפייה ולביקורת.',
      'board.fn.vera': 'מנטרת זמינות ובריאות אתר מסביב לשעון ומרימה התראה ברגע שמשהו חורג.',
      'board.fn.ben': 'מריץ גיבויים מתוזמנים ושומר נתיב שחזור בדוק כך שהאתר שלך תמיד ניתן לשחזור.',
      'board.fn.uri': 'עוקב אחר עדכוני ליבה ותלויות ומגיש הצעה — בלי לשנות שום דבר בלי האישור שלך.',
      'board.fn.gil': 'שומר על האתר: סריקות אבטחה, ניטור איומים ומגן הגבלת קצב מפני שימוש לרעה.',
      'board.fn.tova': 'שומרת על תוכן רענן וקישורים פנימיים תקינים, ומסמנת עמודים שצריכים רענון.',
      'board.fn.cara': 'מנהלת תעודות TLS וחידוש אוטומטי כך שהמנעול לעולם לא פג.'
    }
  };

  function detectLang() {
    try {
      const q = new URLSearchParams(location.search).get('lang');
      if (q === 'he' || q === 'en') { try { localStorage.setItem('rsb_lang', q); } catch (e) {} return q; }
    } catch (e) {}
    try { const s = localStorage.getItem('rsb_lang'); if (s === 'he' || s === 'en') return s; } catch (e) {}
    const host = (location.hostname || '');
    if (/(^|[.-])he($|[.-])/.test(host)) return 'he';                 // rapid-site-builder-he.web.app
    if ((document.documentElement.getAttribute('data-default-lang') || '') === 'he') return 'he';
    // Predictable canonical URL: rapid-site-builder.web.app is English; the Hebrew
    // version lives at its own URL (rapid-site-builder-he.web.app) + the switcher.
    // (No navigator.language auto-flip — it made the canonical URL locale-dependent.)
    return 'en';
  }

  var lang = detectLang();
  var dict = STRINGS[lang] || STRINGS.en;

  function t(key, vars) {
    var s = (dict[key] != null) ? dict[key] : (STRINGS.en[key] != null ? STRINGS.en[key] : key);
    if (vars) for (var k in vars) s = s.split('{' + k + '}').join(vars[k]);
    return s;
  }

  function apply(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
    root.querySelectorAll('[data-i18n-html]').forEach(function (el) { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
    root.querySelectorAll('[data-i18n-ph]').forEach(function (el) { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
    root.querySelectorAll('[data-i18n-aria]').forEach(function (el) { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
    if (root === document) { var tk = document.documentElement.getAttribute('data-i18n-title'); if (tk) document.title = t(tk); }
  }

  function setLang(next) {
    if (next !== 'he' && next !== 'en') return;
    try { localStorage.setItem('rsb_lang', next); } catch (e) {}
    try { var u = new URL(location.href); u.searchParams.set('lang', next); location.href = u.toString(); }
    catch (e) { location.reload(); }
  }

  // set <html lang/dir> as early as possible (script is in <head>)
  document.documentElement.lang = lang;
  document.documentElement.dir = (lang === 'he') ? 'rtl' : 'ltr';

  window.RSB_I18N = { lang: lang, dir: document.documentElement.dir, t: t, apply: apply, setLang: setLang };

  if (document.readyState !== 'loading') apply();
  else document.addEventListener('DOMContentLoaded', function () { apply(); });
})();
