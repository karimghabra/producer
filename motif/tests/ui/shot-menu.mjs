// Screenshot helper: opens a menu so it can be seen in a still.
//
//   node shot-menu.mjs track shots/manager.png
//   node shot-menu.mjs project shots/project.png
import { chromium } from 'playwright';

const which = process.argv[2] || 'track';
const path = process.argv[3] || `shots/${which}.png`;

const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = b.contexts().flatMap((c) => c.pages())
  .find((p) => p.url().startsWith('http://127.0.0.1:'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.track');

const send = (type, extra = {}) => page.evaluate(([t, e]) => fetch('/api/command', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: t, ...e }),
}).then(() => {}), [type, extra]);

if (which === 'track') {
  await send('addTrack', { kind: 'synth' });
  await page.waitForTimeout(400);
  await page.locator('.track').nth(2).locator('[data-more]').click();
} else {
  await send('save', { name: 'Night Drive' });
  await send('save', { name: 'Warehouse 2am' });
  await page.waitForTimeout(400);
  await page.locator('#project').click();
}

await page.waitForTimeout(400);
await page.screenshot({ path });
process.exit(0);
