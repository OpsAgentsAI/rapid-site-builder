// Pre-seed the hero-image cache: one Gemini-generated image per category so
// demo builds are pure cache hits. Run locally with ADC:
//   SITE_IMAGES_BUCKET=... IMAGE_PROJECT=... node scripts/seed_images.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { heroImageUrl, CATEGORIES } = require('../lib/images.js');

const cats = Object.keys(CATEGORIES);
console.log(`Seeding ${cats.length} categories into ${process.env.SITE_IMAGES_BUCKET} …`);
let ok = 0, fail = 0;
for (const c of cats) {
  process.stdout.write(`  ${c} … `);
  try {
    const url = await heroImageUrl(c, 'default');
    if (url) { ok++; console.log('✓', url); }
    else { fail++; console.log('✗ (no url)'); }
  } catch (e) {
    fail++; console.log('✗', e.message);
  }
}
console.log(`Done: ${ok} ok, ${fail} failed.`);
process.exit(fail && !ok ? 1 : 0);
