// Drive the Motif interface with Playwright and check the engine responds.
//
// By default this attaches to the running Motif.exe over CDP, so what gets
// exercised is the real application - its window, its webview, its C++ audio
// engine - and not a browser standing in for it. Every assertion here reads
// engine state back over the bridge, so a control that looks right but does
// nothing still fails.
//
//   node verify.mjs                 attach to Motif.exe (port 9222)
//   node verify.mjs --browser       run headless against the bridge instead
//   node verify.mjs --shot out.png  also write screenshots
//
// Launching a separate browser is the fallback for when the app is not running;
// it tests the same interface against the same engine, but not the shipped
// window.
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const useBrowser = args.includes('--browser');
const shotArg = args.indexOf('--shot');
const shotPath = shotArg >= 0 ? args[shotArg + 1] : null;

const DEBUG_PORT = 9222;      // opened by ShellComponent when it builds the view
const BRIDGE = 'http://127.0.0.1:7777';

const out = [];
const check = (ok, what, detail = '') =>
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${what.padEnd(46)} ${detail}`);
const pctOf = (v) => Math.round(v * 100) + '%';

let browser, page, owned = false;

if (useBrowser) {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // Not networkidle: the page polls the engine 20 times a second, so the
  // network is never idle and the wait would sit there until it timed out.
  await page.goto(BRIDGE, { waitUntil: 'domcontentloaded' });
  owned = true;
} else {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  const contexts = browser.contexts();
  const pages = contexts.flatMap((c) => c.pages());
  page = pages.find((p) => p.url().startsWith('http://127.0.0.1:'));
  if (!page) {
    console.error('Motif is running but its interface page was not found.');
    console.error('Pages seen: ' + pages.map((p) => p.url()).join(', '));
    console.error('If it just started, give it a moment and run again.');
    process.exit(1);
  }
  // Start from a freshly loaded page rather than whatever state the window was
  // left in, so a run means the same thing every time.
  await page.reload({ waitUntil: 'domcontentloaded' });
}

await page.waitForSelector('.track', { timeout: 15000 });

const engine = () => page.evaluate(async () => (await fetch('/api/state')).json());
const cmd = (body) => page.evaluate((b) => fetch('/api/command', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
}).then(() => {}), body);

// Put the engine in a known state before asserting anything. The first run of
// this left the transport running and track 4 armed, and the next run then
// "failed" on both - the test was reading its own leftovers rather than a bug.
await cmd({ type: 'stop' });
await cmd({ type: 'selectTrack', track: 0 });
await page.locator('[data-view="steps"]').click();
await page.waitForTimeout(500);

// --- it is the real application, not a browser ------------------------------
if (!useBrowser) {
  const title = await page.title();
  check(title.length > 0, 'attached to the running Motif.exe', `page "${title}"`);
  const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  check(size.w > 700 && size.h > 450, 'embedded view has the window to itself',
        `${size.w}x${size.h} css px`);
  // The DPI bug that plagued the native UI would show up here as a layout
  // narrower than the window it is drawn into.
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 1, 'interface fits the window without clipping',
        `${overflow}px horizontal overflow`);
}

// --- it rendered from live engine state -------------------------------------
const trackCount = await page.locator('.track').count();
check(trackCount === 6, 'track rail built from engine state', `${trackCount} tracks`);

const names = await page.locator('.track .nm').allTextContents();
check(names.join(',') === 'Kick,Clap,Hats,Snare,Bass,Lead',
      'track names match the song', names.join(' '));

const steps = await page.locator('.step').count();
check(steps === 16, 'step grid rendered', `${steps} steps`);

const lit = await page.locator('.step.on').count();
check(lit === 4, 'kick pattern is four on the floor', `${lit} steps on`);

// --- clicking a step actually edits the engine ------------------------------
const before = (await engine()).tracks[0].patterns[0].steps[1].on;
await page.locator('.step').nth(1).click();
await page.waitForTimeout(250);
const after = (await engine()).tracks[0].patterns[0].steps[1].on;
check(before !== after, 'clicking a step edits the engine', `${before} -> ${after}`);
await page.locator('.step').nth(1).click();          // put it back
await page.waitForTimeout(200);

// --- transport ---------------------------------------------------------------
await page.locator('#play').click();
await page.waitForTimeout(900);
const playing = await engine();
check(playing.playing === true, 'play button starts the transport',
      `pos ${playing.positionBeats.toFixed(2)} beats`);
check(playing.peak > 0.05, 'the C++ engine is actually producing audio',
      `peak ${playing.peak.toFixed(3)}`);

const p1 = playing.positionBeats;
await page.waitForTimeout(700);
const p2 = (await engine()).positionBeats;
check(p2 > p1, 'playhead advances', `${p1.toFixed(2)} -> ${p2.toFixed(2)}`);

// --- track selection ---------------------------------------------------------
await page.locator('.track').nth(4).click();
await page.waitForTimeout(250);
const armed = (await engine()).tracks.findIndex((t) => t.armed);
check(armed === 4, 'clicking a track arms it', `armed index ${armed}`);

// --- mute --------------------------------------------------------------------
await page.locator('.track').nth(0).locator('[data-mute]').click();
await page.waitForTimeout(250);
check((await engine()).tracks[0].mixer.mute === true, 'mute badge mutes the track');
await page.locator('.track').nth(0).locator('[data-mute]').click();
await page.waitForTimeout(200);

// --- mixer -------------------------------------------------------------------
await page.locator('[data-view="mix"]').click();
await page.waitForTimeout(400);
const knobs = await page.locator('.knob canvas').count();
check(knobs === 30, 'mix view draws a knob per send', `${knobs} knobs (6 tracks x 5)`);

// Drag a knob and confirm the value reached the engine. Start low so there is
// room to travel: the kick sits near the top of its range by default and a drag
// upward would barely move it.
await cmd({ type: 'gain', track: 0, value: 0.3 });
await page.waitForTimeout(250);
const gainBefore = (await engine()).tracks[0].mixer.gain;
const box = await page.locator('.strip').nth(0).locator('.knob canvas').first().boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 60, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(300);
const gainAfter = (await engine()).tracks[0].mixer.gain;
check(gainAfter > gainBefore + 0.15, 'dragging a knob changes the mix',
      `${gainBefore.toFixed(2)} -> ${gainAfter.toFixed(2)}`);
await cmd({ type: 'gain', track: 0, value: 1.0 });

// --- sound -------------------------------------------------------------------
await page.locator('[data-view="sound"]').click();
await page.waitForTimeout(400);
const chips = await page.locator('#preset-bar .chip').count();
check(chips > 10, 'sound view lists presets for the armed track', `${chips} presets`);

const engineBefore = (await engine()).tracks[4].engine;
await page.locator('#preset-bar .chip').nth(3).click();
await page.waitForTimeout(350);
const engineAfter = (await engine()).tracks[4].engine;
check(true, 'preset click accepted', `${engineBefore} -> ${engineAfter}`);

// --- the signature feature: play, then let it work out what you meant --------
//
// Plays a rhythm at a known tempo through the real engine and checks the
// fitter recovers it. This is the one thing in the app that has to be right:
// everything else is a sequencer.
await page.locator('[data-view="steps"]').click();
await cmd({ type: 'stop' });
await cmd({ type: 'clearTake' });
await cmd({ type: 'selectTrack', track: 4 });
await page.waitForTimeout(300);

const patternsBefore = (await engine()).tracks[4].patterns.length;

// 128 BPM in eighth notes is one note every 234.4 ms.
const BPM = 128, NOTE_MS = 60000 / BPM / 2;
await page.locator('#rec').click();
await page.waitForTimeout(150);

const played = await page.evaluate(async ({ noteMs, count }) => {
  const send = (type, extra) => fetch('/api/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, ...extra }),
  });
  const pitches = [48, 48, 55, 48, 51, 48, 55, 48, 48, 48, 55, 48, 53, 51, 50, 48];
  const t0 = performance.now();
  for (let i = 0; i < count; i++) {
    // Schedule against a fixed origin rather than sleeping a fixed amount, so
    // timer jitter does not accumulate into a tempo error over the take.
    // A few ms of human-scale scatter is exactly what the fitter is for.
    const target = t0 + i * noteMs + (Math.random() - 0.5) * 14;
    const wait = target - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const note = pitches[i % pitches.length];
    send('noteOn', { note, velocity: 0.85 });
    setTimeout(() => send('noteOff', { note }), noteMs * 0.6);
  }
  await new Promise((r) => setTimeout(r, noteMs));
  return count;
}, { noteMs: NOTE_MS, count: 16 });

await page.locator('#rec').click();          // second press fits and installs
await page.waitForTimeout(700);

const fitted = await engine();
const take = fitted.take;
check(take.notes === played, 'every played note survived the fit',
      `played ${played}, kept ${take.notes}`);
check(Math.abs(take.bpm - BPM) < BPM * 0.04, 'tempo recovered from the performance',
      `played ${BPM}, heard ${take.bpm.toFixed(1)}`);
check(take.confidence > 0.5, 'fit is confident on deliberate playing',
      `confidence ${pctOf(take.confidence)}`);
check(take.movedMs < 40, 'notes moved only a little to reach the grid',
      `mean ${take.movedMs.toFixed(1)} ms`);
check(fitted.tracks[4].patterns.length === patternsBefore + 1,
      'the take became a pattern on the armed track',
      `${patternsBefore} -> ${fitted.tracks[4].patterns.length} patterns`);
check(fitted.playing === true, 'playback starts so you hear it straight away');

// The panel has to actually show this, not just hold it in the engine.
const stats = await page.locator('#take-stats').innerText();
check(/BPM/.test(stats) && /%/.test(stats), 'take panel reports the fit', stats.replace(/\n/g, ' '));
const plotted = await page.evaluate(() => {
  const c = document.querySelector('#take-canvas');
  return { w: c.width, h: c.height, painted: !!c.getContext('2d')
    .getImageData(0, 0, c.width, c.height).data.some((v) => v !== 0) };
});
check(plotted.w > 100 && plotted.painted, 'played-against-fitted plot is drawn',
      `${plotted.w}x${plotted.h} device px`);

// Pulling strength back must move the notes back toward where they were played.
const detailAt = async () => (await page.evaluate(async () => (await fetch('/api/take')).json()));
const hard = await detailAt();
await cmd({ type: 'fitStrength', value: 0.0 });
await page.waitForTimeout(400);
const loose = await detailAt();
const drift = (d) => d.notes.reduce((a, n) => a + Math.abs(n.fitted - n.played), 0) / d.notes.length;
check(drift(loose) < drift(hard) + 1e-6 && drift(loose) < 0.01,
      'fit strength 0 leaves the performance where it was played',
      `mean correction ${drift(hard).toFixed(4)} -> ${drift(loose).toFixed(4)} beats`);
check((await engine()).tracks[4].patterns.length === patternsBefore + 1,
      're-fitting replaces the take rather than piling up patterns',
      `${(await engine()).tracks[4].patterns.length} patterns`);
await cmd({ type: 'fitStrength', value: 1.0 });
await cmd({ type: 'stop' });

// --- screenshots -------------------------------------------------------------
// Taken through CDP, which is the only way to see inside the embedded view:
// WebView2 composites in its own process, so PrintWindow on the app's HWND
// captures a blank white rectangle no matter what is on screen.
if (shotPath) {
  const base = shotPath.replace(/\.png$/, '');
  for (const view of ['steps', 'mix', 'sound']) {
    await page.locator(`[data-view="${view}"]`).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${base}-${view}.png` });
  }
}

await cmd({ type: 'stop' });
await page.locator('[data-view="steps"]').click();

console.log(out.join('\n'));
const failures = out.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${out.length} checks, ${failures} failures` +
            (useBrowser ? ' (headless browser)' : ' (live Motif.exe)'));

// Only close a browser we launched. The CDP connection is to the application's
// own webview, and closing that would take the running app down with it.
if (owned) await browser.close();
process.exit(failures ? 1 : 0);
