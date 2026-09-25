'use strict';
// The OTHER half of the KjHpbn3J retirement — the half nothing has ever tested.
//
// `retire.test.js` exercises `server.js` under RETIRE_UNGATED=1 and asserts the
// proxy 301s `/`, `/board`, `/campfire`. That is real coverage of the Cloud Run
// layer, and on Firebase Hosting it is also DEAD CODE for those three paths.
// Hosting resolves, in order:
//
//     1. /__/*   2. redirects   3. static content   4. rewrites   5. 404
//
// The retired sites are configured `"public": "web"` with a `**` rewrite to the
// proxy. `web/index.html` (53 KB, <title>Rapid Site Builder — your AI web team,
// live</title>), `web/board/index.html` and `web/campfire/index.html` are all
// still in the repo. So static content (3) beats the rewrite (4): the request
// never reaches `server.js`, and the ONLY thing standing between a visitor and
// the retired hackathon UI is the `redirects` block in firebase.json.
//
// Measured live 2026-08-23 on rapid-site-builder.web.app, not inferred:
//     /            301 → builder.opsagents.agency/
//     /llms.txt    200  1220 B, byte-identical to web/llms.txt
//     /og.png      200  343369 B
//     /auth.js     200  5080 B
// Static serving from `web/` is demonstrably live on that site. Remove one
// redirect line and the retired UI is back up — with `npm test` still green,
// because no test in this repo has ever read firebase.json.
//
// That is not hypothetical: card rQunsPko's AC1 asks for exactly that edit
// ("serve the staging build directly — 200, not a 301"), and its own AC4
// re-probe would see 200 and record SUCCESS while serving the retired surface.
// This file makes that PR go red instead.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const hosting = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8')
).hosting;

/** The canonical product surface every retired path must be sent to. */
const CANONICAL = 'https://builder.opsagents.agency';

/**
 * Sites whose hackathon surface was retired by KjHpbn3J (PR #49, re-confirmed
 * by #57 after an 8-day soak against a 7-day gate).
 *
 * NAMING TRAP, carried from g0pH1JZX: `rapid-site-builder` is STAGING and
 * `rapid-site-builder-app` is PROD. The names read backwards.
 */
const RETIRED_SITES = ['rapid-site-builder', 'rapid-site-builder-he'];

/** The prod product surface. Retirement redirects here would be a loop. */
const PROD_SITE = 'rapid-site-builder-app';

/**
 * The QA tier stood up by card rQunsPko. It exists precisely BECAUSE the sites
 * above are retired: authenticated flows had nowhere to be exercised except
 * PROD. It must therefore inherit none of the retirement.
 */
const APP_STAGING_SITE = 'rapid-builder-stg';
const APP_STAGING_SERVICE = 'rapid-builder-app-stg';

/**
 * Paths retired by KjHpbn3J, and the static file each would fall through to if
 * its redirect were removed. Kept in step with `server.js`'s RETIRE_UNGATED
 * block and with `retire.test.js`.
 */
const RETIRED_PATHS = [
  { path: '/', file: 'index.html' },
  { path: '/index.html', file: 'index.html' },
  { path: '/board', file: path.join('board', 'index.html') },
  { path: '/campfire', file: path.join('campfire', 'index.html') },
];

const siteConfig = (name) => {
  const s = hosting.find((h) => h.site === name);
  assert.ok(s, `firebase.json must configure the "${name}" site`);
  return s;
};

/** Does `source` cover `p`? Handles the exact and `/x/**` forms in use here. */
const covers = (source, p) =>
  source === p || (source.endsWith('/**') && p === source.slice(0, -3));

test('every retired path is unreachable on the retired sites', () => {
  for (const site of RETIRED_SITES) {
    const cfg = siteConfig(site);
    const publicDir = path.join(ROOT, cfg.public);

    for (const { path: p, file } of RETIRED_PATHS) {
      const redirect = (cfg.redirects ?? []).find((r) => covers(r.source, p));
      const staticFile = path.join(publicDir, file);
      const servable = fs.existsSync(staticFile);

      // The invariant is "not reachable", satisfied EITHER way — so deleting
      // the static file is still a legitimate (stronger) retirement and this
      // test will not stand in its way. What it refuses is the combination
      // that quietly puts the hackathon UI back: no redirect, file present.
      assert.ok(
        redirect || !servable,
        `${site}${p} would serve the retired ${cfg.public}/${file} — no ` +
          `redirect covers it and the file is still there. Hosting resolves ` +
          `static content BEFORE the "**" rewrite, so server.js's ` +
          `RETIRE_UNGATED 301 never runs for this path.`,
      );

      if (redirect) {
        assert.strictEqual(
          redirect.type, 301,
          `${site}${p} must redirect 301 (permanent) — launch posts link ` +
            `these URLs; a 302 tells crawlers the retirement is temporary.`,
        );
        assert.ok(
          String(redirect.destination).startsWith(CANONICAL),
          `${site}${p} must redirect to ${CANONICAL}, got ` +
            `${redirect.destination}. REDIRECT, never 404 (KjHpbn3J step 2).`,
        );
      }
    }
  }
});

test('the prod site carries no retirement redirect — that would be a loop', () => {
  // AC2 of rQunsPko asks for this to be confirmed rather than assumed. The
  // hazard is concrete: builder.opsagents.agency is served by PROD_SITE, so a
  // redirect there pointing at the canonical origin would send the product
  // surface to itself.
  const cfg = siteConfig(PROD_SITE);
  for (const r of cfg.redirects ?? []) {
    assert.ok(
      !String(r.destination).startsWith(CANONICAL),
      `${PROD_SITE} redirects ${r.source} → ${r.destination}; that origin IS ` +
        `this site, so the redirect loops.`,
    );
  }
});

test('the two retirement layers name the same paths', () => {
  // Hosting is what actually runs on the retired sites, but server.js still
  // covers the proxy's direct URL. If one layer is edited and the other is
  // not, the surface is retired in one place and open in the other — which is
  // how a "half-fix" leaves the two disagreeing.
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const block = server.slice(server.indexOf('if (RETIRE_UNGATED)'));
  assert.ok(block, 'server.js must still carry a RETIRE_UNGATED block');

  for (const { path: p } of RETIRED_PATHS) {
    assert.ok(
      block.includes(`'${p}'`),
      `server.js's RETIRE_UNGATED block no longer mentions ${p}, but ` +
        `firebase.json still retires it. The layers have drifted.`,
    );
  }
});

test('the APP-STAGING tier inherits NO part of the retirement', () => {
  // The failure this exists for is a copy-paste, not a misunderstanding: the
  // three retired/prod blocks sit immediately above this one in firebase.json,
  // and two of the three carry a `redirects` array. A block copied from the
  // wrong neighbour produces a "staging tier" whose every human-facing path
  // 301s to PROD — which is the exact symptom that made card rQunsPko read, for
  // three consecutive ticks, as though the retirement were the bug.
  const cfg = siteConfig(APP_STAGING_SITE);

  assert.deepStrictEqual(
    cfg.redirects ?? [],
    [],
    `${APP_STAGING_SITE} must carry NO redirects. It is the QA surface for the ` +
      `real app; a redirect here sends QA to PROD and the tier tests nothing.`,
  );

  // Static content beats the "**" rewrite on Hosting, so `/` is served from
  // web/index.html. That is correct HERE and is the whole difference from the
  // retired sites — assert the file is actually present, or `/` 404s and the
  // deploy smoke test is the first thing to find out.
  const index = path.join(ROOT, cfg.public, 'index.html');
  assert.ok(
    fs.existsSync(index),
    `${APP_STAGING_SITE} serves ${cfg.public}/ statically, but ${cfg.public}/index.html ` +
      `does not exist — "/" would 404.`,
  );

  // And it must point at its OWN Cloud Run service. Pointing it at
  // rapid-builder-proxy would silently make the QA tier the retired app.
  const rw = (cfg.rewrites ?? []).find((r) => r.source === '**');
  assert.ok(rw && rw.run, `${APP_STAGING_SITE} needs a "**" rewrite to Cloud Run`);
  assert.strictEqual(
    rw.run.serviceId, APP_STAGING_SERVICE,
    `${APP_STAGING_SITE} must rewrite to ${APP_STAGING_SERVICE}, not ${rw.run.serviceId}.`,
  );
  assert.strictEqual(rw.run.region, 'us-central1');
});

test('the retired sites and the QA tier are four distinct sites', () => {
  // A vacuity floor for both files: if firebase.json were emptied or a site
  // renamed, every "site X must not do Y" assertion above would pass on nothing.
  const names = hosting.map((h) => h.site);
  assert.strictEqual(new Set(names).size, names.length, `duplicate site blocks in firebase.json: ${names}`);
  for (const s of [...RETIRED_SITES, PROD_SITE, APP_STAGING_SITE]) {
    assert.ok(names.includes(s), `firebase.json no longer configures ${s} (has: ${names.join(', ')})`);
  }
});
