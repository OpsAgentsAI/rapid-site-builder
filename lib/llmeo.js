'use strict';
// LLM-EO: every published site ships AI-discoverable (card peIktfIK).
// llms.txt is the emerging convention (llmstxt.org) for handing AI assistants
// a small Markdown brief of what a site is about. Like the HTML renderer this
// is a pure function of the agent-produced spec — generated server-side at
// publish time, never from client-supplied content.

// drop unfilled "[Your Address Here]"-style placeholders the model sometimes emits
function real(v) {
  const s = String(v == null ? '' : v).trim();
  return /^\[.*\]$/.test(s) || /\[[^\]]{3,}\]/.test(s) ? '' : s;
}

function clean(s, n = 400) {
  return real(s).replace(/\s+/g, ' ').slice(0, n);
}

function llmsTxt(spec, url) {
  const business = clean(spec.business, 120) || 'This business';
  const tagline = clean(spec.tagline, 200);
  const about = clean(spec.about, 600);
  const lines = [`# ${business}`];
  if (tagline) lines.push('', `> ${tagline}`);
  if (about) lines.push('', about);

  const items = Array.isArray(spec.items) ? spec.items.filter(i => i && clean(i.name, 80)) : [];
  if (items.length) {
    lines.push('', `## ${clean(spec.items_heading, 80) || 'Offerings'}`);
    for (const i of items.slice(0, 12)) {
      const name = clean(i.name, 80);
      const desc = clean(i.desc, 160);
      const price = clean(i.price, 40);
      lines.push(`- ${name}${desc ? `: ${desc}` : ''}${price ? ` (${price})` : ''}`);
    }
  }

  const c = spec.contact || {};
  const contact = [
    ['Address', clean(c.address, 160)],
    ['Phone', clean(c.phone, 60)],
    ['Email', clean(c.email, 120)],
    ['Hours', clean(c.hours, 160)]
  ].filter(([, v]) => v);
  if (contact.length) {
    lines.push('', '## Contact');
    for (const [k, v] of contact) lines.push(`- ${k}: ${v}`);
  }

  if (url) lines.push('', '## Links', `- [Website](${url})`);
  lines.push('', '_Site built and operated by an AI agent team via Rapid Site Builder._', '');
  return lines.join('\n');
}

module.exports = { llmsTxt };
