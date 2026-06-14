'use strict';
// LLM-EO (card peIktfIK): published sites ship AI-discoverable. llms.txt is a
// pure function of the spec; the builder's own surface serves /robots.txt and
// /llms.txt as static files. Run with `npm test`.

const test = require('node:test');
const assert = require('node:assert');

const { llmsTxt } = require('../lib/llmeo');
const { app } = require('../server');

const SPEC = {
  business: 'Maple & Crumb Bakery',
  tagline: 'Small-batch sourdough and pastry, baked at dawn.',
  about: 'A neighborhood bakery in Haifa.',
  items_heading: 'From the oven',
  items: [
    { name: 'Sourdough loaf', desc: 'Naturally leavened', price: '₪24' },
    { name: 'Almond croissant', desc: '', price: '' },
    { name: '[Item Name Here]', desc: 'placeholder row' }
  ],
  contact: { address: '12 Carmel St, Haifa', phone: '[Your Phone Here]', email: 'hi@maple.example', hours: 'Sun–Fri 7–14' }
};

test('llmsTxt: business brief with offerings, contact, and link', () => {
  const txt = llmsTxt(SPEC, 'https://rapid-site-builder.web.app/sites/abcd1234');
  assert.match(txt, /^# Maple & Crumb Bakery/m);
  assert.match(txt, /^> Small-batch sourdough/m);
  assert.match(txt, /^## From the oven/m);
  assert.match(txt, /Sourdough loaf: Naturally leavened \(₪24\)/);
  assert.match(txt, /- Almond croissant\s*$/m);
  assert.match(txt, /^## Contact/m);
  assert.match(txt, /Address: 12 Carmel St, Haifa/);
  assert.match(txt, /Email: hi@maple\.example/);
  assert.match(txt, /\[Website\]\(https:\/\/rapid-site-builder\.web\.app\/sites\/abcd1234\)/);
});

test('llmsTxt: drops unfilled [placeholder] values instead of publishing them', () => {
  const txt = llmsTxt(SPEC, '');
  assert.ok(!txt.includes('[Item Name Here]'), 'placeholder item leaked');
  assert.ok(!txt.includes('[Your Phone Here]'), 'placeholder phone leaked');
  assert.ok(!txt.includes('Phone:'), 'phone row should be dropped entirely');
});

test('llmsTxt: minimal spec still yields a valid brief', () => {
  const txt = llmsTxt({ business: 'Solo Studio' });
  assert.match(txt, /^# Solo Studio/m);
  assert.ok(!txt.includes('## Contact'));
});

function listen() {
  return new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
}

test('builder surface serves /robots.txt with AI-crawler allows', async () => {
  const server = await listen();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/robots.txt`);
    assert.strictEqual(res.status, 200);
    const body = await res.text();
    assert.match(body, /User-agent: \*\s+Allow: \//);
    assert.match(body, /User-agent: GPTBot/);
    assert.match(body, /User-agent: ClaudeBot/);
    assert.match(body, /User-agent: Google-Extended/);
  } finally {
    server.close();
  }
});

test('builder surface serves its own /llms.txt', async () => {
  const server = await listen();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/llms.txt`);
    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /^# Rapid Site Builder/);
  } finally {
    server.close();
  }
});
