// Screenshot helper: put every track on a different rate so the layout can be
// checked against the beat.
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

// Kick 1/4, Clap 1/8, Hats 1/16, Snare 1/8T, Bass 1/16T, Lead 1/32 - all four
// beats long, so every row should end at the same place.
const plan = [[0, 1, 4], [1, 2, 8], [2, 4, 16], [3, 3, 12], [4, 6, 24], [5, 8, 32]];
for (const [track, res, len] of plan) {
  await send('patternResolution', { track, value: res });
  await send('patternLength', { track, value: len });
}
await page.waitForTimeout(600);
// Something on every downbeat of every track, to see the alignment.
for (const [track, res, len] of plan) {
  for (let s = 0; s < len; s += res) await send('stepEdit', { track, step: s, what: 'on', value: 1 });
}
await page.waitForTimeout(700);
await page.locator('[data-view="grid"]').click();
await page.waitForTimeout(500);
await page.screenshot({ path: 'shots/rates.png' });
process.exit(0);
