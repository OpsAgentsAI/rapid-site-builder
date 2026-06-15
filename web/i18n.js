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
      'dyn.yourbiz': 'your business'
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
      'dyn.yourbiz': 'העסק שלך'
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
