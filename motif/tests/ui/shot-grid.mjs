// Screenshot helper for the all-tracks grid, with a track of a different
// length so the drift is visible.
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
await send('selectTrack', { track: 2 });
await send('patternLength', { track: 2, value: 12 });   // hats against the rest
await page.waitForTimeout(300);
await send('selectTrack', { track: 0 });
await send('play');
await page.waitForTimeout(1200);
await page.screenshot({ path: 'shots/grid.png' });
await send('stop');
process.exit(0);
