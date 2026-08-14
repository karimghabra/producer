// Screenshot helper: build a small arrangement with a partial filter ramp
// driving several tracks, then capture the song view.
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

// Intro: drums only.
await send('seqEnabled', { track: 4, value: 0 });
await send('seqEnabled', { track: 5, value: 0 });
await send('addScene');
await send('renameScene', { scene: 0, name: 'Intro' });
// Full.
await send('seqEnabled', { track: 4, value: 1 });
await send('seqEnabled', { track: 5, value: 1 });
await send('addScene');
await send('renameScene', { scene: 1, name: 'Drop' });
await page.waitForTimeout(400);

await send('addSection', { scene: 0, bars: 4 });
await send('addSection', { scene: 1, bars: 8 });
await send('addSection', { scene: 0, bars: 4 });
await page.waitForTimeout(400);

// Filters to sweep.
for (const t of [0, 1, 2]) await send('filter', { track: t, what: 'type', value: 1 });

await page.locator('[data-view="song"]').click();
await page.waitForTimeout(300);
await page.locator('#song-lane .section').nth(1).click();
await page.waitForTimeout(300);
await send('addLane', { section: 1, laneTrack: 0, param: 'cutoff' });
await page.waitForTimeout(300);
await send('laneTrack', { section: 1, lane: 0, laneTrack: 1, value: 1 });
await send('laneTrack', { section: 1, lane: 0, laneTrack: 2, value: 1 });
// A ramp over bars 3-6 of the 8, not the whole section.
await send('laneCurve', { section: 1, lane: 0, points: '2:0.15,3:0.35,4:0.8,5:0.95' });
await send('addLane', { section: 1, laneTrack: -1, param: 'mRevMix' });
await page.waitForTimeout(300);
await send('laneCurve', { section: 1, lane: 1, points: '0:0.7,5.5:0.15,8:0.15' });
await send('songMode', { value: 1 });
await send('rewindSong');
await send('play');
await page.waitForTimeout(2200);
await page.screenshot({ path: 'shots/song.png' });
await send('stop');
await send('songMode', { value: 0 });
process.exit(0);
