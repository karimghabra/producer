// Screenshot helper for the mixer: a couple of filters engaged, playing.
import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = b.contexts().flatMap((c) => c.pages())
  .find((p) => p.url().startsWith('http://127.0.0.1:'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.track');
const send = (t, e = {}) => page.evaluate(([t, e]) => fetch('/api/command', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: t, ...e }) }).then(() => {}), [t, e]);
await send('newSong');
await page.waitForTimeout(400);
await send('filter', { track: 4, what: 'type', value: 1 });     // lowpass the bass
await send('filter', { track: 4, what: 'cutoff', value: 700 });
await send('filter', { track: 2, what: 'type', value: 2 });     // highpass the hats
await send('filter', { track: 2, what: 'cutoff', value: 900 });
await page.locator('[data-view="mix"]').click();
await send('play');
await page.waitForTimeout(1400);
await page.screenshot({ path: 'shots/mix.png' });
await send('stop');
process.exit(0);
