// Screenshot helper: opens the track options menu so the manager can be seen.
import { chromium } from 'playwright';

const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = b.contexts().flatMap((c) => c.pages())
  .find((p) => p.url().startsWith('http://127.0.0.1:'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.track');

const send = (type, extra = {}) => page.evaluate(([t, e]) => fetch('/api/command', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: t, ...e }),
}).then(() => {}), [type, extra]);

await send('addTrack', { kind: 'synth' });
await page.waitForTimeout(400);
await page.locator('.track').nth(2).locator('[data-more]').click();
await page.waitForTimeout(400);
await page.screenshot({ path: process.argv[2] || 'shots/manager.png' });
await send('newSong');
process.exit(0);
