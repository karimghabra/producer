// Screenshot helper: writes a bassline with actual movement so the contour
// bars and note names have something to show.
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

// A rolling bassline: root, root, fifth, root, flat-seventh, fourth...
const line = [0, 0, 4, 0, 6, 0, 3, 2, 0, 0, 4, 5, 6, 4, 2, 0];
for (let i = 0; i < 16; i++) {
  await send('stepEdit', { track: 4, step: i, what: 'on', value: 1 });
  await send('stepEdit', { track: 4, step: i, what: 'deg', value: line[i] });
}
// And a lead an octave up, sparser.
for (const [i, d] of [[0, 7], [3, 9], [6, 11], [8, 7], [11, 12], [14, 9]]) {
  await send('stepEdit', { track: 5, step: i, what: 'on', value: 1 });
  await send('stepEdit', { track: 5, step: i, what: 'deg', value: d });
}
await page.waitForTimeout(700);
await send('play');
await page.waitForTimeout(1100);
await page.screenshot({ path: 'shots/notes.png' });
await send('stop');
process.exit(0);
