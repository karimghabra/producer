// Screenshot helper: sets up a step worth inspecting, then captures it.
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
await send('selectTrack', { track: 2 });
await page.waitForTimeout(400);
await send('stepEdit', { track: 2, step: 6, what: 'on', value: 1 });
await send('stepEdit', { track: 2, step: 6, what: 'ratchet', value: 3 });
await send('stepEdit', { track: 2, step: 10, what: 'nudge', value: 0.12 });
await send('stepEdit', { track: 2, step: 14, what: 'condType', value: 2 });
await page.waitForTimeout(500);
await page.locator('.step').nth(6).click();
await page.waitForTimeout(200);
await page.locator('.step').nth(6).click();     // back on, still selected
await page.waitForTimeout(500);
await page.screenshot({ path: 'shots/steps-detail.png' });
process.exit(0);
