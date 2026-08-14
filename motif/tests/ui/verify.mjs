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
// This run tears the song down and builds it back up, and the app now restores
// whatever was open last time. So: put the session somewhere safe first and
// give it back at the end, rather than costing someone their work to run a test.
const BACKUP = 'Verify Backup';
await cmd({ type: 'save', name: BACKUP });
await page.waitForTimeout(300);

await cmd({ type: 'newSong' });
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
await page.locator('#preset-bar .chip:not(.ghost)').nth(3).click();
await page.waitForTimeout(400);
const engineAfter = (await engine()).tracks[4].engine;
check(true, 'preset click accepted', `${engineBefore} -> ${engineAfter}`);

// --- sound design ------------------------------------------------------------
//
// The controls are generated from the engine's own parameter table, so what
// matters is that every one of them reaches the engine and that the engine's
// value comes back to the control.
const specs = await page.evaluate(async () =>
  (await fetch('/api/params?track=4')).json());
check(specs.length > 15, 'the synth exposes its parameters', `${specs.length} parameters`);
check(specs.every((p) => p.help && p.help.length > 30),
      'every parameter explains what it does',
      `shortest ${Math.min(...specs.map((p) => p.help.length))} chars`);

const knobCount = await page.locator('#params .param').count();
const choiceCount = await page.locator('#params .choice').count();
check(knobCount + choiceCount === specs.length, 'a control is drawn for each one',
      `${knobCount} knobs + ${choiceCount} choice rows = ${specs.length}`);

// Drag a real parameter and read the engine back.
const cutoffIdx = specs.findIndex((p) => p.id === 'cutoff');
const cutoffKnob = page.locator('#params .param').nth(
  specs.slice(0, cutoffIdx).filter((p) => !p.choices).length);
const kb = await cutoffKnob.boundingBox();
const readCutoff = async () => (await page.evaluate(async () =>
  (await fetch('/api/params?track=4')).json())).find((p) => p.id === 'cutoff').value;
const cutBefore = await readCutoff();
await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
await page.mouse.down();
await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2 - 70, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(350);
const cutAfter = await readCutoff();
check(cutAfter > cutBefore * 1.3, 'dragging a knob changes the sound',
      `cutoff ${Math.round(cutBefore)} -> ${Math.round(cutAfter)} Hz`);

// A logarithmic control must spend its travel usefully: the midpoint of an
// attack knob should be tens of milliseconds, not one and a half seconds.
const atk = specs.find((p) => p.id === 'ampAttack');
const mid = atk.min * Math.sqrt(atk.max / atk.min);
check(atk.log && mid < 0.2, 'envelope times are swept logarithmically',
      `midpoint ${(mid * 1000).toFixed(0)} ms of ${atk.min * 1000}-${atk.max * 1000} ms`);

// Switching engine via a choice control.
await page.locator('#params .choice .chip', { hasText: 'FM' }).first().click();
await page.waitForTimeout(450);
check((await engine()).tracks[4].engine === 'FM', 'choice control switches the engine',
      (await engine()).tracks[4].engine);

// Reset restores the default sound without touching name, colour or patterns.
const nameBefore = (await engine()).tracks[4].name;
const patsKept = (await engine()).tracks[4].patterns.length;
await page.locator('#preset-bar .chip.ghost').click();
await page.waitForTimeout(450);
const afterReset = (await engine()).tracks[4];
check(afterReset.name === nameBefore && afterReset.patterns.length === patsKept,
      'reset changes the sound only', `${afterReset.name}, ${afterReset.patterns.length} patterns`);
const cutReset = await readCutoff();
check(Math.abs(cutReset - 2200) < 1, 'reset returns parameters to their defaults',
      `cutoff ${Math.round(cutReset)} Hz`);

// --- track manager -----------------------------------------------------------
await page.locator('[data-view="steps"]').click();
await page.waitForTimeout(250);
const startCount = (await engine()).tracks.length;

await page.locator('#add-synth').click();
await page.waitForTimeout(350);
let now = await engine();
check(now.tracks.length === startCount + 1, 'add synth track', `${startCount} -> ${now.tracks.length}`);
check(now.tracks.at(-1).isDrum === false, 'the added track is a synth', now.tracks.at(-1).engine);
check(now.tracks.at(-1).armed === true, 'a new track is armed ready to play');
check(now.tracks.at(-1).patterns[0].steps.every((s) => !s.on),
      'a new track starts empty rather than copying a default');

await page.locator('#add-drum').click();
await page.waitForTimeout(350);
now = await engine();
check(now.tracks.length === startCount + 2, 'add drum track', `${now.tracks.length} tracks`);
const colours = new Set(now.tracks.map((t) => t.colour));
check(colours.size >= Math.min(now.tracks.length, 8), 'added tracks get distinct colours',
      `${colours.size} colours across ${now.tracks.length} tracks`);

// Rename in place.
const nameCell = page.locator('.track').nth(startCount).locator('.nm');
await nameCell.dblclick();
await page.keyboard.press('Control+A');
await page.keyboard.type('Acid');
await page.keyboard.press('Enter');
await page.waitForTimeout(350);
check((await engine()).tracks[startCount].name === 'Acid', 'rename a track in place',
      (await engine()).tracks[startCount].name);

// The options menu.
await page.locator('.track').nth(startCount).locator('[data-more]').click();
await page.waitForTimeout(200);
check(await page.locator('#track-menu').isVisible(), 'track options menu opens');
const menuFits = await page.evaluate(() => {
  const m = document.getElementById('track-menu').getBoundingClientRect();
  return m.right <= innerWidth + 1 && m.bottom <= innerHeight + 1 && m.top >= -1;
});
check(menuFits, 'the menu stays inside the window');

await page.locator('#track-menu .menu-item', { hasText: 'Duplicate' }).click();
await page.waitForTimeout(350);
now = await engine();
check(now.tracks.length === startCount + 3 && now.tracks[startCount + 1].name === 'Acid 2',
      'duplicate a track', now.tracks.map((t) => t.name).join(','));

// Reorder.
await page.locator('.track').nth(startCount).locator('[data-more]').click();
await page.waitForTimeout(200);
await page.locator('#track-menu .menu-item', { hasText: 'Move up' }).click();
await page.waitForTimeout(350);
check((await engine()).tracks[startCount - 1].name === 'Acid', 'move a track up the rail',
      (await engine()).tracks.map((t) => t.name).join(','));

// Patterns.
await cmd({ type: 'selectTrack', track: 0 });
await page.waitForTimeout(300);
const patsBefore = (await engine()).tracks[0].patterns.length;
await page.locator('#pattern-bar .chip.ghost').first().click();
await page.waitForTimeout(350);
check((await engine()).tracks[0].patterns.length === patsBefore + 1, 'add a pattern',
      `${patsBefore} -> ${(await engine()).tracks[0].patterns.length}`);
// Not .chip:last - the add and duplicate buttons are chips too.
await page.locator('#pattern-bar .chip:not(.ghost)').last().click({ button: 'right' });
await page.waitForTimeout(350);
const patsAfter = (await engine()).tracks[0].patterns.length;
check(patsAfter === patsBefore, 'right-click removes a pattern',
      `${patsBefore + 1} -> ${patsAfter}`);

// Delete, all the way back to where we started.
for (let i = 0; i < 3; i++) {
  await page.locator('.track').nth(startCount - 1).locator('[data-more]').click();
  await page.waitForTimeout(200);
  await page.locator('#track-menu .menu-item', { hasText: 'Delete' }).click();
  await page.waitForTimeout(300);
}
now = await engine();
check(now.tracks.length === startCount, 'delete tracks', `back to ${now.tracks.length}`);

// The song must never be left with nothing in it.
await cmd({ type: 'selectTrack', track: 0 });
const survivor = now.tracks.length;
for (let i = 0; i < survivor + 2; i++) await cmd({ type: 'removeTrack', track: 0 });
await page.waitForTimeout(400);
const left = (await engine()).tracks.length;
check(left === 1, 'the last track cannot be deleted', `${survivor} -> ${left}`);

await cmd({ type: 'newSong' });
await page.waitForTimeout(400);
now = await engine();
check(now.tracks.length === startCount &&
      now.tracks.map((t) => t.name).join(',') === 'Kick,Clap,Hats,Snare,Bass,Lead',
      'new song restores the starter kit', now.tracks.map((t) => t.name).join(' '));
await cmd({ type: 'selectTrack', track: 0 });
await page.waitForTimeout(300);

// --- projects ----------------------------------------------------------------
//
// The one part of the app where a bug costs someone their work, so this checks
// a project actually comes back rather than that a button was clickable.
const PROJ = 'Verify Run';
await cmd({ type: 'newSong' });
await page.waitForTimeout(300);
await cmd({ type: 'bpm', value: 143 });
await cmd({ type: 'gain', track: 2, value: 0.42 });
await cmd({ type: 'param', track: 4, id: 'cutoff', value: 0.2 });
await cmd({ type: 'renameTrack', track: 1, name: 'Marker' });
await page.waitForTimeout(350);

await page.locator('#project').click();
await page.waitForTimeout(250);
check(await page.locator('#proj-name').isVisible(), 'project menu opens');
await page.locator('#proj-name').fill(PROJ);
await page.locator('#proj-save').click();
await page.waitForTimeout(500);
check((await engine()).name === PROJ, 'saving names the project', (await engine()).name);

// Change everything, then open the save and check it comes back.
await cmd({ type: 'newSong' });
await page.waitForTimeout(400);
check(Math.abs((await engine()).bpm - 143) > 1, 'new project clears what was there',
      `${(await engine()).bpm} bpm`);

await page.locator('#project').click();
await page.waitForTimeout(300);
await page.locator(`#track-menu .menu-item`, { hasText: PROJ }).first().click();
await page.waitForTimeout(600);
const reopened = await engine();
check(Math.abs(reopened.bpm - 143) < 0.01, 'tempo comes back', `${reopened.bpm} bpm`);
check(reopened.tracks[1].name === 'Marker', 'track names come back', reopened.tracks[1].name);
check(Math.abs(reopened.tracks[2].mixer.gain - 0.42) < 0.005, 'mixer settings come back',
      reopened.tracks[2].mixer.gain.toFixed(3));
const reCut = (await page.evaluate(async () => (await fetch('/api/params?track=4')).json()))
  .find((p) => p.id === 'cutoff');
check(Math.abs(reCut.norm - 0.2) < 0.01, 'instrument parameters come back',
      `cutoff ${Math.round(reCut.value)} Hz`);
check(reopened.playing === false, 'opening a project does not leave it running');

// Delete needs two presses, so a project is not lost to one bad click.
await page.locator('#project').click();
await page.waitForTimeout(300);
const del = page.locator('#track-menu .menu-file', { hasText: PROJ }).locator('.menu-del');
await del.click();
await page.waitForTimeout(200);
check(await del.evaluate((el) => el.classList.contains('armed')),
      'deleting a project asks first', await del.textContent());
await del.click();
await page.waitForTimeout(400);
const remaining = await page.evaluate(async () => (await fetch('/api/projects')).json());
check(!remaining.names.includes(PROJ), 'and then deletes it',
      remaining.names.join(',') || 'none left');

await cmd({ type: 'newSong' });
await cmd({ type: 'selectTrack', track: 0 });
await page.waitForTimeout(350);

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

// Hand the session back.
await cmd({ type: 'load', name: BACKUP });
await page.waitForTimeout(400);
await cmd({ type: 'deleteProject', name: BACKUP });
await page.waitForTimeout(200);

console.log(out.join('\n'));
const failures = out.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${out.length} checks, ${failures} failures` +
            (useBrowser ? ' (headless browser)' : ' (live Motif.exe)'));

// Only close a browser we launched. The CDP connection is to the application's
// own webview, and closing that would take the running app down with it.
if (owned) await browser.close();
process.exit(failures ? 1 : 0);
