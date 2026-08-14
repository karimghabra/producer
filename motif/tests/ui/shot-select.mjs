// Screenshot helper: shift-drag a block in the grid so the selection shows.
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
await page.waitForTimeout(400);
await page.locator('[data-view="grid"]').click();
await page.waitForTimeout(300);

const box = async (t, s) =>
  page.locator('#grid-rows .grow').nth(t).locator('.gcell').nth(s).boundingBox();
const a = await box(0, 4);
const c = await box(3, 11);
await page.keyboard.down('Shift');
await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
await page.mouse.down();
await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2, { steps: 12 });
await page.mouse.up();
await page.keyboard.up('Shift');
await page.waitForTimeout(500);
await page.screenshot({ path: 'shots/select.png' });
await send('newSong');
process.exit(0);
