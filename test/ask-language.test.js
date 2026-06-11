'use strict';
// Mirror-the-question language rule (card U8EzfNOL): an English question must get an
// English answer even when the bilingual crew replies fully in Hebrew. The old
// `englishOnly(reply) || reply` fallback un-guarded itself exactly in that case and
// shipped the raw Hebrew verbatim. Run with `npm test`.

const test = require('node:test');
const assert = require('node:assert');

const engine = require('../lib/engine');
engine.ENABLED = true;

const { app } = require('../server');

const HEBREW_RE = /[֐-׿]/;

async function askOnce(body) {
  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const port = server.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: r.status, json: await r.json() };
  } finally {
    server.close();
  }
}

test('fully-Hebrew engine reply + English question → English answer via translate retry', async () => {
  const calls = [];
  engine.oneTurn = async (prompt) => {
    calls.push(prompt);
    if (calls.length === 1) return 'שלום! אנחנו נטפל בזה מיד.\nליאו יתקן את השוליים הלבנים בתמונה.';
    return 'Hi! We will take care of it right away. Leo will fix the white margins in the picture.';
  };
  const { status, json } = await askOnce({ message: 'fix the white margins in the picture', business: 'Cafe Luna', lang: 'en' });
  assert.equal(status, 200);
  assert.ok(!HEBREW_RE.test(json.reply), `reply must contain no Hebrew characters, got: ${json.reply}`);
  assert.match(json.reply, /Leo will fix/);
  assert.equal(calls.length, 2, 'exactly one translate retry');
  assert.match(calls[1], /Translate this to English/);
});

test('translate retry also Hebrew → fixed English line, never the raw Hebrew', async () => {
  engine.oneTurn = async () => 'תשובה בעברית בלבד, גם בניסיון השני';
  const { status, json } = await askOnce({ message: 'make the header bigger', lang: 'en' });
  assert.equal(status, 200);
  assert.ok(!HEBREW_RE.test(json.reply), 'last-resort reply must be Hebrew-free');
  assert.ok(json.reply.length > 0, 'last-resort reply must not be empty');
});

test('Hebrew question keeps the Hebrew answer even when the client mislabels lang=en', async () => {
  let calls = 0;
  engine.oneTurn = async () => { calls++; return 'בטח! נואה תנסח מחדש את הכותרת ותחזור אלייך.'; };
  const { status, json } = await askOnce({ message: 'תתקני בבקשה את הכותרת הראשית', lang: 'en' });
  assert.equal(status, 200);
  assert.ok(HEBREW_RE.test(json.reply), 'mirror rule: Hebrew question → Hebrew answer survives');
  assert.equal(calls, 1, 'no translate retry on a Hebrew question');
});

test('English question with an already-English reply passes through untouched', async () => {
  engine.oneTurn = async () => 'Absolutely — Sam will tune the SEO and report back shortly.';
  const { status, json } = await askOnce({ message: 'improve my seo please', lang: 'en' });
  assert.equal(status, 200);
  assert.equal(json.reply, 'Absolutely — Sam will tune the SEO and report back shortly.');
});
