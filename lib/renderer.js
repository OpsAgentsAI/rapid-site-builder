'use strict';
// Renders a complete, polished one-page site from an agent-produced spec.
// Pure function of (spec, options) → single-file static HTML: inline CSS,
// Google Fonts, real hero photography (cached Gemini image) with a gradient
// scrim, fluid type, full RTL support — and zero <script> tags by construction.
//
// spec schema (produced by the agent crew):
// { business, tagline, vibe: warm|fresh|modern|trust|bold,
//   layout: standard|services|catalog|booking, hero_emoji,
//   about_heading, about, items_heading, items[{emoji,name,desc,price}],
//   why_heading, why[{emoji,title,text}], cta_heading, cta_text, cta_button,
//   contact{address,phone,email,hours}, lang?, dir? }

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// drop unfilled "[Your Address Here]"-style placeholders the model sometimes emits
function real(v) {
  const s = String(v == null ? '' : v).trim();
  return /^\[.*\]$/.test(s) || /\[[^\]]{3,}\]/.test(s) ? '' : s;
}
function short(s, n = 72) {
  s = String(s || '');
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)) + '…';
}
function escUrl(u) {
  const s = String(u || '');
  return /^https:\/\/[\w.-]+\/[\w\-./%]*$/.test(s) ? s : '';
}

const PALETTES = {
  warm:   { bg: '#FAF5EE', bg2: '#F1E6D6', surface: '#FFFDF9', ink: '#2B1D12', dim: '#7A6450', accent: '#C2571B', accent2: '#E8A852', dark: '#241509' },
  fresh:  { bg: '#F4F9F5', bg2: '#E2F0E6', surface: '#FFFFFF', ink: '#14241A', dim: '#5B7264', accent: '#1F7A4D', accent2: '#7FC79E', dark: '#0F1F16' },
  modern: { bg: '#0B0E16', bg2: '#151B2B', surface: '#121826', ink: '#F2F5FF', dim: '#9AA6C7', accent: '#7C5CFF', accent2: '#2DD4BF', dark: '#070A11' },
  trust:  { bg: '#F5F8FC', bg2: '#E3ECF7', surface: '#FFFFFF', ink: '#0E2138', dim: '#52677F', accent: '#1D6FE0', accent2: '#67A7FF', dark: '#0A1727' },
  bold:   { bg: '#FFF8F3', bg2: '#FFE8DB', surface: '#FFFFFF', ink: '#27130E', dim: '#7A5A4E', accent: '#E03E2D', accent2: '#FF9D5C', dark: '#1D0E09' }
};
const SERIF_VIBES = new Set(['warm', 'fresh']);

function fonts(spec) {
  return `<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,640;9..144,720&family=Sora:wght@500;600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>`;
}
function headFont(spec) {
  return SERIF_VIBES.has(spec.vibe) ? "'Fraunces',Georgia,serif" : "'Sora',system-ui,sans-serif";
}
function bodyFont(spec) {
  return "'Inter',system-ui,sans-serif";
}
// chrome strings are English-only in this build (generated copy comes from the spec)
function L(spec, en) { return en; }

function style(spec) {
  const p = PALETTES[spec.vibe] || PALETTES.trust;
  const hf = headFont(spec), bf = bodyFont(spec);
  return `<style>
:root{--bg:${p.bg};--bg2:${p.bg2};--surface:${p.surface};--ink:${p.ink};--dim:${p.dim};--accent:${p.accent};--accent2:${p.accent2};--dark:${p.dark}}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:${bf};background:var(--bg);color:var(--ink);line-height:1.7;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
h1,h2,h3{font-family:${hf};line-height:1.08;letter-spacing:-.015em;font-weight:700}
img{max-width:100%;display:block}
a{color:inherit;text-decoration:none}
.wrap{max-width:1120px;margin-inline:auto;padding-inline:24px}
.btn{display:inline-flex;align-items:center;gap:10px;padding:16px 30px;border-radius:999px;font-weight:700;font-size:16px;background:var(--accent);color:#fff;border:2px solid transparent;transition:transform .18s ease,box-shadow .18s ease;cursor:pointer}
.btn:hover{transform:translateY(-2px);box-shadow:0 16px 34px color-mix(in srgb,var(--accent) 38%,transparent)}
.btn.ghost{background:transparent;color:var(--accent);border-color:color-mix(in srgb,var(--accent) 55%,transparent)}
.btn.ghost:hover{border-color:var(--accent);box-shadow:none;background:color-mix(in srgb,var(--accent) 8%,transparent)}
.btn:focus-visible,a:focus-visible{outline:3px solid var(--accent2);outline-offset:3px;border-radius:8px}
header.nav{position:sticky;top:0;z-index:50;backdrop-filter:blur(14px);background:color-mix(in srgb,var(--bg) 78%,transparent);border-bottom:1px solid color-mix(in srgb,var(--ink) 8%,transparent)}
.nav-in{display:flex;align-items:center;justify-content:space-between;height:74px}
.brand{display:flex;align-items:center;gap:12px;font-family:${hf};font-weight:700;font-size:20px;letter-spacing:-.01em}
.brand .mk{width:40px;height:40px;border-radius:13px;display:grid;place-items:center;font-size:18px;font-weight:800;color:#fff;background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 6px 16px color-mix(in srgb,var(--accent) 35%,transparent)}
.nav nav{display:flex;align-items:center;gap:26px}
.nav a.lnk{color:var(--dim);font-weight:600;font-size:15px;transition:color .15s}
.nav a.lnk:hover{color:var(--accent)}
.nav .btn{padding:11px 22px;font-size:14px}
@media(max-width:760px){.nav a.lnk{display:none}}
.hero{position:relative;overflow:hidden}
.hero-grid{display:grid;grid-template-columns:1.05fr .95fr;gap:56px;align-items:center;padding-block:96px}
@media(max-width:860px){.hero-grid{grid-template-columns:1fr;gap:36px;padding-block:64px;text-align:center}}
.eyebrow{display:inline-flex;align-items:center;gap:8px;padding:8px 16px;border-radius:999px;background:color-mix(in srgb,var(--accent) 10%,var(--surface));color:var(--accent);font-weight:700;font-size:13px;letter-spacing:.04em;margin-bottom:22px;border:1px solid color-mix(in srgb,var(--accent) 22%,transparent)}
.hero h1{font-size:clamp(40px,6.4vw,68px);margin-bottom:18px;text-wrap:balance}
.hero .lead{font-size:clamp(17px,2.1vw,20px);color:var(--dim);max-width:52ch;margin-bottom:32px}
@media(max-width:860px){.hero .lead{margin-inline:auto}}
.hero-cta{display:flex;gap:14px;flex-wrap:wrap}
@media(max-width:860px){.hero-cta{justify-content:center}}
.hero-media{position:relative;aspect-ratio:4/3.4;border-radius:28px;overflow:hidden;background-size:cover;background-position:center;box-shadow:0 30px 70px color-mix(in srgb,var(--dark) 35%,transparent)}
.hero-media::after{content:'';position:absolute;inset:0;background:linear-gradient(200deg,transparent 52%,color-mix(in srgb,var(--dark) 55%,transparent));}
.hero-media .tag{position:absolute;inset-inline-start:18px;bottom:16px;z-index:2;background:color-mix(in srgb,var(--dark) 62%,transparent);backdrop-filter:blur(8px);color:#fff;padding:10px 16px;border-radius:999px;font-size:13.5px;font-weight:600}
.hero-art{aspect-ratio:4/3.4;border-radius:28px;background:radial-gradient(circle at 28% 24%,color-mix(in srgb,var(--accent2) 55%,transparent),transparent 50%),radial-gradient(circle at 74% 78%,color-mix(in srgb,var(--accent) 50%,transparent),transparent 55%),linear-gradient(160deg,var(--bg2),var(--surface));box-shadow:0 30px 70px color-mix(in srgb,var(--dark) 25%,transparent)}
.hero-cover{position:relative;min-height:560px;display:grid;align-items:end;background-size:cover;background-position:center;color:#fff}
.hero-cover::before{content:'';position:absolute;inset:0;background:linear-gradient(180deg,color-mix(in srgb,var(--dark) 30%,transparent) 0%,color-mix(in srgb,var(--dark) 78%,transparent) 88%)}
.hero-cover .inner{position:relative;z-index:2;padding-block:84px 64px;max-width:680px}
.hero-cover h1{color:#fff;font-size:clamp(42px,6.6vw,72px);margin-bottom:16px;text-wrap:balance}
.hero-cover .lead{color:rgba(255,255,255,.88);font-size:clamp(17px,2.1vw,20px);margin-bottom:30px;max-width:52ch}
.hero-cover .eyebrow{background:rgba(255,255,255,.14);color:#fff;border-color:rgba(255,255,255,.25)}
.hero-center{position:relative;text-align:center;padding-block:104px 88px}
.hero-center h1{font-size:clamp(42px,6.4vw,70px);max-width:18ch;margin-inline:auto;margin-bottom:18px;text-wrap:balance}
.hero-center .lead{color:var(--dim);font-size:clamp(17px,2.1vw,20px);max-width:56ch;margin:0 auto 32px}
.hero-center .hero-cta{justify-content:center}
.trustline{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:34px}
.trustline span{padding:9px 16px;border-radius:999px;background:var(--surface);border:1px solid color-mix(in srgb,var(--ink) 9%,transparent);font-size:13.5px;font-weight:600;color:var(--dim)}
section{padding-block:96px}
@media(max-width:760px){section{padding-block:64px}}
.sec-h{max-width:640px;margin-bottom:52px}
.sec-h.center{margin-inline:auto;text-align:center}
.sec-h .k{display:block;color:var(--accent);font-weight:700;text-transform:uppercase;letter-spacing:.12em;font-size:12.5px;margin-bottom:12px}
.sec-h h2{font-size:clamp(30px,4.2vw,44px);margin-bottom:14px;text-wrap:balance}
.sec-h p{color:var(--dim);font-size:17.5px}
.tint{background:linear-gradient(180deg,var(--bg2),var(--bg))}
.grid{display:grid;gap:22px;grid-template-columns:repeat(3,1fr)}
.grid.two{grid-template-columns:repeat(2,1fr)}
@media(max-width:860px){.grid,.grid.two{grid-template-columns:1fr 1fr}}
@media(max-width:560px){.grid,.grid.two{grid-template-columns:1fr}}
.card{background:var(--surface);border:1px solid color-mix(in srgb,var(--ink) 8%,transparent);border-radius:22px;padding:30px;transition:transform .2s ease,box-shadow .2s ease}
.card:hover{transform:translateY(-4px);box-shadow:0 22px 44px color-mix(in srgb,var(--dark) 14%,transparent)}
.card .ic{width:52px;height:52px;border-radius:16px;display:grid;place-items:center;font-size:26px;background:color-mix(in srgb,var(--accent) 11%,var(--bg));margin-bottom:18px}
.card h3{font-size:20px;margin-bottom:8px}
.card p{color:var(--dim);font-size:15.5px}
.card .price{display:inline-block;margin-top:16px;padding:7px 14px;border-radius:999px;font-weight:700;font-size:15px;color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent)}
.card .num{font-family:${hf};font-size:15px;font-weight:700;color:color-mix(in srgb,var(--accent) 70%,var(--dim));letter-spacing:.08em;margin-bottom:14px;display:block}
.prose{max-width:68ch;margin-inline:auto;text-align:center}
.prose h2{font-size:clamp(28px,4vw,40px);margin-bottom:18px}
.prose p{color:var(--dim);font-size:clamp(17px,2vw,19.5px);line-height:1.85}
.visit-grid{display:grid;grid-template-columns:1.1fr .9fr;gap:24px}
@media(max-width:860px){.visit-grid{grid-template-columns:1fr}}
.visit-card{background:var(--surface);border:1px solid color-mix(in srgb,var(--ink) 8%,transparent);border-radius:22px;padding:34px}
.visit-card h3{font-size:21px;margin-bottom:20px}
.vrow{display:flex;gap:14px;align-items:flex-start;padding-block:13px;border-bottom:1px solid color-mix(in srgb,var(--ink) 7%,transparent);font-size:15.5px}
.vrow:last-child{border-bottom:0}
.vrow .vi{width:38px;height:38px;flex:0 0 38px;border-radius:12px;display:grid;place-items:center;background:color-mix(in srgb,var(--accent) 10%,var(--bg));font-size:17px}
.vrow b{display:block;font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin-bottom:2px;font-weight:700}
.hours{font-size:17px;line-height:2;color:var(--ink);white-space:pre-line}
.cta-band{padding-block:0}
.cta-panel{position:relative;overflow:hidden;border-radius:30px;padding:72px 28px;text-align:center;color:#fff;background:linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent2) 80%,var(--accent)))}
.cta-panel::before{content:'';position:absolute;inset:0;background:radial-gradient(circle at 18% 16%,rgba(255,255,255,.18),transparent 42%),radial-gradient(circle at 86% 88%,rgba(255,255,255,.12),transparent 40%)}
.cta-panel>*{position:relative}
.cta-panel h2{color:#fff;font-size:clamp(30px,4.4vw,46px);margin-bottom:14px;text-wrap:balance}
.cta-panel p{opacity:.95;max-width:54ch;margin:0 auto 30px;font-size:18px}
.cta-panel .btn{background:#fff;color:var(--accent)}
.cta-panel .btn:hover{box-shadow:0 16px 34px rgba(0,0,0,.25)}
footer{background:var(--dark);color:color-mix(in srgb,var(--bg) 72%,#fff);padding-block:46px 0;margin-top:96px;font-size:14.5px}
.foot{display:flex;justify-content:space-between;gap:18px;flex-wrap:wrap;align-items:center;padding-bottom:34px}
.foot .brand{color:#fff}
.prov{border-top:1px solid rgba(255,255,255,.1);text-align:center;padding:14px;font-size:12.5px;color:color-mix(in srgb,var(--bg) 45%,#888)}
</style>`;
}

// ---- shared fragments -----------------------------------------------------------
function mark(spec) {
  const ch = String(spec.business || '•').trim().charAt(0).toUpperCase() || '•';
  return `<span class="mk" aria-hidden="true">${esc(ch)}</span>`;
}
function navBar(spec, links) {
  const ls = links.map(l => `<a class="lnk" href="#${l.id}">${esc(l.label)}</a>`).join('');
  return `<header class="nav"><div class="wrap nav-in">
  <a class="brand" href="#top">${mark(spec)} ${esc(spec.business)}</a>
  <nav aria-label="${L(spec, 'Main')}">${ls}<a class="btn" href="#cta">${esc(spec.cta_button || L(spec, 'Get in touch'))}</a></nav>
</div></header>`;
}
function secHead(spec, k, h, lead, center) {
  return `<div class="sec-h${center ? ' center' : ''}"><span class="k">${esc(k)}</span><h2>${esc(h)}</h2>${lead ? `<p>${esc(lead)}</p>` : ''}</div>`;
}
function itemsSection(spec, cols, tint) {
  const cards = (spec.items || []).map(it => `
    <div class="card"><div class="ic" aria-hidden="true">${esc(it.emoji || '•')}</div><h3>${esc(it.name)}</h3><p>${esc(it.desc)}</p>${it.price ? `<span class="price">${esc(it.price)}</span>` : ''}</div>`).join('');
  return `<section id="items"${tint ? ' class="tint"' : ''}><div class="wrap">
  ${secHead(spec, L(spec, 'What we offer'), spec.items_heading || L(spec, 'What we offer'), '', true)}
  <div class="grid${cols === 2 ? ' two' : ''}">${cards}</div></div></section>`;
}
function whySection(spec, tint, numbered) {
  const cards = (spec.why || []).map((w, i) => `
    <div class="card">${numbered ? `<span class="num">0${i + 1}</span>` : `<div class="ic" aria-hidden="true">${esc(w.emoji || '✦')}</div>`}<h3>${esc(w.title)}</h3><p>${esc(w.text)}</p></div>`).join('');
  return `<section id="why"${tint ? ' class="tint"' : ''}><div class="wrap">
  ${secHead(spec, L(spec, 'Why us'), spec.why_heading || L(spec, 'Why choose us'), '', true)}
  <div class="grid">${cards}</div></div></section>`;
}
function aboutSection(spec) {
  return `<section id="about"><div class="wrap prose">
  <span class="k" style="display:block;color:var(--accent);font-weight:700;text-transform:uppercase;letter-spacing:.12em;font-size:12.5px;margin-bottom:12px">${L(spec, 'About')}</span>
  <h2>${esc(spec.about_heading || L(spec, 'Our story'))}</h2>
  <p>${esc(spec.about)}</p></div></section>`;
}
function visitSection(spec, hoursFirst) {
  const raw = spec.contact || {};
  const c = { address: real(raw.address), phone: real(raw.phone), email: real(raw.email), hours: real(raw.hours) };
  const contactCard = `<div class="visit-card">
    <h3>${L(spec, 'Find us')}</h3>
    ${c.address ? `<div class="vrow"><span class="vi" aria-hidden="true">📍</span><div><b>${L(spec, 'Address')}</b>${esc(c.address)}</div></div>` : ''}
    ${c.phone ? `<div class="vrow"><span class="vi" aria-hidden="true">📞</span><div><b>${L(spec, 'Phone')}</b><a href="tel:${esc(String(c.phone).replace(/[^\d+]/g, ''))}">${esc(c.phone)}</a></div></div>` : ''}
    ${c.email ? `<div class="vrow"><span class="vi" aria-hidden="true">✉️</span><div><b>${L(spec, 'Email')}</b><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div></div>` : ''}
  </div>`;
  const hoursCard = `<div class="visit-card">
    <h3>${L(spec, 'Opening hours')}</h3>
    <p class="hours">${esc(c.hours || '')}</p>
  </div>`;
  return `<section id="visit"><div class="wrap">
  ${secHead(spec, L(spec, 'Come by'), L(spec, 'Visit & contact'), '', true)}
  <div class="visit-grid">${hoursFirst ? hoursCard + contactCard : contactCard + hoursCard}</div></div></section>`;
}
function ctaSection(spec) {
  const c = spec.contact || {};
  return `<section id="cta" class="cta-band"><div class="wrap"><div class="cta-panel">
  <h2>${esc(spec.cta_heading || L(spec, 'Ready when you are'))}</h2>
  <p>${esc(spec.cta_text || '')}</p>
  <a class="btn" href="${c.email ? 'mailto:' + esc(c.email) : '#visit'}">${esc(spec.cta_button || L(spec, 'Contact us'))}</a>
</div></div></section>`;
}
function footerBlock(spec) {
  const c = spec.contact || {};
  return `<footer><div class="wrap foot">
  <span class="brand">${mark(spec)} ${esc(spec.business)}</span>
  <div>${esc([real(c.address), real(c.phone)].filter(Boolean).join(' · '))}</div>
</div><div class="prov">${L(spec, 'Designed, written & shipped by an AI agent team · Rapid Site Builder demo')}</div></footer>`;
}

// ---- heroes ----------------------------------------------------------------------
function heroSplit(spec, img) {
  const media = img
    ? `<div class="hero-media" role="img" aria-label="${esc(spec.business)}" style="background-image:url('${img}')"><span class="tag">${esc(short(spec.tagline, 80))}</span></div>`
    : `<div class="hero-art" aria-hidden="true"></div>`;
  return `<div class="hero"><div class="wrap hero-grid">
  <div><span class="eyebrow">${esc(short(spec.tagline))}</span>
    <h1>${esc(spec.business)}</h1>
    <p class="lead">${esc(spec.about)}</p>
    <div class="hero-cta"><a class="btn" href="#cta">${esc(spec.cta_button || L(spec, 'Get started'))}</a><a class="btn ghost" href="#items">${esc(spec.items_heading || L(spec, 'See more'))}</a></div>
  </div>${media}</div></div>`;
}
function heroCover(spec, img, ctaHref, ctaLabel) {
  if (!img) return heroCenter(spec, ctaHref, ctaLabel, '');
  return `<div class="hero hero-cover" style="background-image:url('${img}')"><div class="wrap"><div class="inner">
  <span class="eyebrow">${esc(short(spec.tagline))}</span>
  <h1>${esc(spec.business)}</h1>
  <p class="lead">${esc(spec.about)}</p>
  <div class="hero-cta"><a class="btn" href="${ctaHref}">${esc(ctaLabel)}</a></div>
</div></div></div>`;
}
function heroCenter(spec, ctaHref, ctaLabel, trustline) {
  return `<div class="hero hero-center"><div class="wrap">
  <span class="eyebrow">${esc(short(spec.tagline))}</span>
  <h1>${esc(spec.business)}</h1>
  <p class="lead">${esc(spec.about)}</p>
  <div class="hero-cta"><a class="btn" href="${ctaHref}">${esc(ctaLabel)}</a><a class="btn ghost" href="#items">${esc(spec.items_heading || L(spec, 'Explore'))}</a></div>
  ${trustline}
</div></div>`;
}

// ---- layouts ----------------------------------------------------------------------
function layoutStandard(spec, img) {
  return navBar(spec, [
    { id: 'about', label: L(spec, 'About') },
    { id: 'items', label: spec.items_heading || L(spec, 'Offerings') },
    { id: 'visit', label: L(spec, 'Visit') }
  ]) + `<main id="top">` + heroSplit(spec, img) + aboutSection(spec) + itemsSection(spec, 3, true)
    + whySection(spec, false, false) + visitSection(spec, false) + ctaSection(spec) + `</main>` + footerBlock(spec);
}
function layoutServices(spec, img) {
  return navBar(spec, [
    { id: 'items', label: spec.items_heading || L(spec, 'Services') },
    { id: 'why', label: L(spec, 'Why us') },
    { id: 'about', label: L(spec, 'About') }
  ]) + `<main id="top">` + heroCover(spec, img, '#items', spec.cta_button || L(spec, 'See our services'))
    + itemsSection(spec, 2, false) + whySection(spec, true, true) + aboutSection(spec) + ctaSection(spec) + `</main>` + footerBlock(spec);
}
function layoutCatalog(spec, img) {
  return navBar(spec, [
    { id: 'items', label: spec.items_heading || L(spec, 'Menu') },
    { id: 'visit', label: L(spec, 'Visit') },
    { id: 'about', label: L(spec, 'About') }
  ]) + `<main id="top">` + heroCover(spec, img, '#items', spec.items_heading || L(spec, 'See the menu'))
    + itemsSection(spec, 3, false) + aboutSection(spec) + visitSection(spec, false) + ctaSection(spec) + `</main>` + footerBlock(spec);
}
function layoutBooking(spec, img) {
  const trust = (spec.why || []).slice(0, 3).map(w => `<span>${esc(w.emoji || '✓')} ${esc(w.title)}</span>`).join('');
  return navBar(spec, [
    { id: 'why', label: L(spec, 'Why us') },
    { id: 'items', label: spec.items_heading || L(spec, 'Services') },
    { id: 'visit', label: L(spec, 'Hours') }
  ]) + `<main id="top">` + heroCenter(spec, '#cta', spec.cta_button || L(spec, 'Book an appointment'),
      trust ? `<div class="trustline">${trust}</div>` : '')
    + whySection(spec, false, false) + itemsSection(spec, 2, true) + visitSection(spec, true) + ctaSection(spec) + `</main>` + footerBlock(spec);
}

const LAYOUTS = { standard: layoutStandard, services: layoutServices, catalog: layoutCatalog, booking: layoutBooking };

function jsonLd(spec) {
  const raw = spec.contact || {};
  const c = { address: real(raw.address), phone: real(raw.phone), email: real(raw.email) };
  const data = {
    '@context': 'https://schema.org', '@type': 'LocalBusiness',
    name: spec.business, description: spec.tagline,
    ...(c.address ? { address: c.address } : {}), ...(c.phone ? { telephone: c.phone } : {}),
    ...(c.email ? { email: c.email } : {})
  };
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

function render(spec, { heroImage } = {}) {
  const img = escUrl(heroImage);
  const lang = spec.lang === 'he' ? 'he' : 'en';
  const dir = (spec.dir === 'rtl' || lang === 'he') ? ' dir="rtl"' : '';
  const body = (LAYOUTS[spec.layout] || LAYOUTS.standard)(spec, img);
  return `<!DOCTYPE html><html lang="${lang}"${dir}><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(spec.business)} — ${esc(spec.tagline)}</title>
<meta name="description" content="${esc(spec.tagline)}"/>
<meta property="og:title" content="${esc(spec.business)}"/>
<meta property="og:description" content="${esc(spec.tagline)}"/>
${img ? `<meta property="og:image" content="${img}"/>` : ''}
${jsonLd(spec)}
${fonts(spec)}
${style(spec)}</head><body>
${body}
</body></html>`;
}

module.exports = { render, esc, PALETTES };
