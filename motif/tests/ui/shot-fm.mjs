import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = b.contexts().flatMap((c) => c.pages())
  .find((p) => p.url().startsWith('http://127.0.0.1:'));
const send = (t, e = {}) => page.evaluate(([t, e]) => fetch('/api/command', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: t, ...e }) }).then(() => {}), [t, e]);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.track');
await send('newSong');
await send('selectTrack', { track: 4 });
await send('param', { track: 4, id: 'engine', value: 2 / 5 });   // FM
await page.waitForTimeout(600);
await page.locator('[data-view="sound"]').click();
await page.waitForTimeout(900);
await page.screenshot({ path: 'shots/sound-fm.png' });
process.exit(0);
