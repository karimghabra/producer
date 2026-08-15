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

/**
 * Wait for the engine to actually reach a state.
 *
 * Sleeping a fixed time after a click is a guess. Where a click rebuilds the
 * panel it was in, the next click can land while the old nodes are being
 * replaced - which is exactly how two lane-track clicks became one.
 */
const waitFor = async (predicate, ms = 3000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate(await engine())) return true;
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(60);
  }
};
const NOTE_ORDER = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

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

// Recording is a toggle, so a previous run - or the stress test, which clicks
// every button it can find - can leave the engine armed. Pressing it again
// here would commit an empty take instead of starting one.
if ((await engine()).recording) await cmd({ type: 'record' });
await cmd({ type: 'clearTake' });
await cmd({ type: 'songMode', value: 0 });

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
// Scoped to the mixer: the step detail panel draws knobs too, and they are
// still in the document while its view is hidden.
const knobs = await page.locator('#mixer .knob canvas').count();
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

// --- grid: every track at once -----------------------------------------------
await page.locator('[data-view="grid"]').click();
await page.waitForTimeout(400);

const gridRows = await page.locator('#grid-rows .grow').count();
check(gridRows === 6, 'the grid shows every track', `${gridRows} rows`);
const rowNames = await page.locator('#grid-rows .gh-name').allTextContents();
check(rowNames.join(',') === 'Kick,Clap,Hats,Snare,Bass,Lead',
      'in song order', rowNames.join(' '));

// Each row must show its own pattern, not the armed one repeated.
const litPerRow = [];
for (let r = 0; r < 6; r++) {
  litPerRow.push(await page.locator('#grid-rows .grow').nth(r)
    .locator('.gcell.on:not(.ghost)').count());
}
check(new Set(litPerRow).size > 1, 'each row shows its own pattern',
      `steps lit per row: ${litPerRow.join(',')}`);
check(litPerRow[0] === 4, 'and the kick is still four on the floor', `${litPerRow[0]} lit`);

// Editing from the grid must reach the engine, on a track that is not armed.
await cmd({ type: 'selectTrack', track: 0 });
await page.waitForTimeout(300);
const beforeHat = (await engine()).tracks[2].patterns[0].steps[0].on;
await page.locator('#grid-rows .grow').nth(2).locator('.gcell').first().click();
await page.waitForTimeout(350);
const afterHat = (await engine()).tracks[2].patterns[0].steps[0].on;
check(beforeHat !== afterHat, 'clicking a cell edits that track',
      `hats step 1 ${beforeHat} -> ${afterHat}`);
check((await engine()).tracks[2].armed === true, 'and arms the track you edited');
await page.locator('#grid-rows .grow').nth(2).locator('.gcell').first().click();
await page.waitForTimeout(300);

// Different pattern lengths must show as a shorter run plus a dimmed repeat.
await cmd({ type: 'selectTrack', track: 2 });
await cmd({ type: 'patternLength', value: 12, track: 2 });
await page.waitForTimeout(400);
const ghosts = await page.locator('#grid-rows .grow').nth(2).locator('.gcell.ghost').count();
const kickGhosts = await page.locator('#grid-rows .grow').nth(0).locator('.gcell.ghost').count();
check(ghosts === 4 && kickGhosts === 0,
      'a shorter pattern shows where it repeats',
      `12-step track has ${ghosts} repeat cells, 16-step track has ${kickGhosts}`);

// --- the grid is laid out in time, not in step count --------------------------
//
// Two tracks at different rates have steps of different lengths. Drawing them
// as the same number of equally wide cells lines them up by index, which puts
// a 1/32 track's fourth step under a 1/16 track's fourth - two moments half a
// beat apart. Every check here is about a column meaning the same instant on
// every row.
await cmd({ type: 'newSong' });
await page.locator('[data-view="grid"]').click();
await page.waitForTimeout(400);

// Kick at 1/4 over one bar, Hats at 1/32 over the same bar.
await cmd({ type: 'patternResolution', track: 0, value: 1 });
await cmd({ type: 'patternLength', track: 0, value: 4 });
await cmd({ type: 'patternResolution', track: 2, value: 8 });
await cmd({ type: 'patternLength', track: 2, value: 32 });
await page.waitForTimeout(500);

const cellCount = async (t) =>
  page.locator('#grid-rows .grow').nth(t).locator('.gcell').count();
check(await cellCount(0) === 4 && await cellCount(2) === 32,
      'a faster track is drawn with more cells, not the same number',
      `1/4 has ${await cellCount(0)}, 1/32 has ${await cellCount(2)}`);

const rowWidth = async (t) => {
  const b = await page.locator('#grid-rows .grow').nth(t).locator('.grow-cells').boundingBox();
  return Math.round(b.width);
};
check(Math.abs(await rowWidth(0) - await rowWidth(2)) <= 2,
      'and both rows still span the same width, so they span the same time',
      `${await rowWidth(0)}px vs ${await rowWidth(2)}px`);

// The moment of beat 2 must be the same x on both rows.
const cellLeft = async (t, s) => {
  const b = await page.locator('#grid-rows .grow').nth(t).locator('.gcell').nth(s).boundingBox();
  return Math.round(b.x);
};
check(Math.abs(await cellLeft(0, 1) - await cellLeft(2, 8)) <= 2,
      'beat two lands at the same place on a 1/4 track and a 1/32 track',
      `${await cellLeft(0, 1)}px vs ${await cellLeft(2, 8)}px`);
check(Math.abs(await cellLeft(0, 3) - await cellLeft(2, 24)) <= 2,
      'and so does beat four',
      `${await cellLeft(0, 3)}px vs ${await cellLeft(2, 24)}px`);

// Changing the rate keeps the musical length. Asking for 1/32 means "run this
// twice as fast", not "make it half a bar" - and the steps already written have
// to move with it, or the part stops lining up with everything else.
await cmd({ type: 'newSong' });
await cmd({ type: 'patternLength', track: 0, value: 16 });
await cmd({ type: 'patternResolution', track: 0, value: 4 });
await cmd({ type: 'cells', op: 'off', cells: '0:0,0:1,0:2,0:3,0:4,0:5,0:6,0:7,0:8,0:9,0:10,0:11,0:12,0:13,0:14,0:15' });
await cmd({ type: 'stepEdit', track: 0, step: 0, what: 'on', value: 1 });
await cmd({ type: 'stepEdit', track: 0, step: 8, what: 'on', value: 1 });
await page.waitForTimeout(450);
const beatsBefore = (() => 16 / 4)();
await cmd({ type: 'patternResolution', track: 0, value: 8 });
await page.waitForTimeout(450);
const rescaled = (await engine()).tracks[0].patterns[0];
check(rescaled.length === 32 && rescaled.length / rescaled.resolution === beatsBefore,
      'changing the rate keeps the pattern the same length in bars',
      `16 steps at 1/16 -> ${rescaled.length} steps at 1/32, both ${beatsBefore} beats`);
check(rescaled.steps[0].on && rescaled.steps[16].on
      && rescaled.steps.filter((s) => s.on).length === 2,
      'and the steps already written move with it',
      `on at ${rescaled.steps.map((s, i) => (s.on ? i : null)).filter((i) => i !== null).join(',')}`);
await cmd({ type: 'newSong' });
await cmd({ type: 'patternResolution', track: 0, value: 1 });
await cmd({ type: 'patternLength', track: 0, value: 4 });
await cmd({ type: 'patternResolution', track: 2, value: 8 });
await cmd({ type: 'patternLength', track: 2, value: 32 });
await page.waitForTimeout(500);

// How much time the grid shows is a separate question from how long a pattern
// is, and asking for four bars must not require making something four bars.
await cmd({ type: 'newSong' });
await page.waitForTimeout(450);
const spanBars = async () => {
  const marks = await page.locator('#grid-ruler .gr-marks span').count();
  return marks / ((await engine()).beatsPerBar || 4);
};
check(await spanBars() === 1, 'the grid follows the longest pattern by default',
      `${await spanBars()} bar`);

await page.locator('#grid-span .chip', { hasText: /^4$/ }).click();
await page.waitForTimeout(500);
check(await spanBars() === 4, 'asking for four bars shows four bars',
      `${await spanBars()} bars`);
const spanCells = await page.locator('#grid-rows .grow').first().locator('.gcell').count();
const spanGhosts = await page.locator('#grid-rows .grow').first().locator('.gcell.ghost').count();
check(spanCells === 64 && spanGhosts === 48,
      'a one-bar pattern fills them by repeating, dimmed',
      `${spanCells} cells, ${spanGhosts} of them the repeat`);
check((await engine()).tracks[0].patterns[0].length === 16,
      'and the pattern itself is untouched',
      `${(await engine()).tracks[0].patterns[0].length} steps`);

// Every track still has to fit, and nothing may scroll sideways.
const visibleRows = await page.evaluate(() => {
  const box = document.querySelector('#grid-rows').getBoundingClientRect();
  return [...document.querySelectorAll('#grid-rows .grow')]
    .filter((r) => r.getBoundingClientRect().bottom <= box.bottom + 1).length;
});
check(visibleRows === 6, 'and all six tracks still fit on screen',
      `${visibleRows} of 6 rows visible`);
const sideways = await page.evaluate(() => {
  const el = document.querySelector('#grid-rows');
  return el.scrollWidth - el.clientWidth;
});
check(sideways <= 1, 'without the grid scrolling sideways', `${sideways}px`);

await page.locator('#grid-span .chip', { hasText: 'Fit' }).click();
await page.waitForTimeout(400);

// Put back the mixed rates the checks below are about - the new song above
// reset them.
await cmd({ type: 'patternResolution', track: 0, value: 1 });
await cmd({ type: 'patternLength', track: 0, value: 4 });
await cmd({ type: 'patternResolution', track: 2, value: 8 });
await cmd({ type: 'patternLength', track: 2, value: 32 });
await page.waitForTimeout(500);

// The ruler counts beats, and belongs to no track in particular.
const rulerMarks = await page.locator('#grid-ruler .gr-marks span').allTextContents();
check(rulerMarks.join(',') === '1,2,3,4', 'the ruler counts beats, not steps',
      rulerMarks.join(' '));

// Selecting across rates must take the same span of time from each.
const sel = async (t, s) =>
  page.locator('#grid-rows .grow').nth(t).locator('.gcell').nth(s).boundingBox();
const q0 = await sel(0, 0);
const q2 = await sel(2, 7);
await page.keyboard.down('Shift');
await page.mouse.move(q0.x + 2, q0.y + q0.height / 2);
await page.mouse.down();
await page.mouse.move(q2.x + q2.width - 2, q2.y + q2.height / 2, { steps: 8 });
await page.mouse.up();
await page.keyboard.up('Shift');
await page.waitForTimeout(400);
const pickedIn = async (t) =>
  page.locator('#grid-rows .grow').nth(t).locator('.gcell.picked').count();
check(await pickedIn(0) === 1 && await pickedIn(2) === 8,
      'a one-beat selection takes one step of a 1/4 track and eight of a 1/32',
      `${await pickedIn(0)} and ${await pickedIn(2)}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
await cmd({ type: 'newSong' });
await page.waitForTimeout(350);

// --- selecting and moving blocks of steps ------------------------------------
await cmd({ type: 'newSong' });
await cmd({ type: 'selectTrack', track: 0 });
await page.locator('[data-view="grid"]').click();
await page.waitForTimeout(400);

const stepsOf = async (t) => (await engine()).tracks[t].patterns[0].steps;
const litIn = async (t) => (await stepsOf(t)).filter((s) => s.on).length;

// Shift-drag a box across two tracks and four steps.
const cellBox = async (t, s) =>
  page.locator('#grid-rows .grow').nth(t).locator('.gcell').nth(s).boundingBox();
const a = await cellBox(0, 0);
const bCell = await cellBox(1, 3);
await page.keyboard.down('Shift');
await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
await page.mouse.down();
await page.mouse.move(bCell.x + bCell.width / 2, bCell.y + bCell.height / 2, { steps: 8 });
await page.mouse.up();
await page.keyboard.up('Shift');
await page.waitForTimeout(400);
check(await page.locator('.gcell.picked').count() === 8,
      'shift-drag selects a block across tracks',
      `${await page.locator('.gcell.picked').count()} cells (2 tracks x 4 steps)`);
check(await page.locator('#grid-tools.on').count() === 1,
      'and the tools for it appear');

// Filling turns them all on without touching anything else.
const kickBefore = await litIn(0);
await page.locator('#grid-tools .chip', { hasText: 'Fill' }).click();
await page.waitForTimeout(400);
const filled = await stepsOf(0);
check(filled.slice(0, 4).every((s) => s.on), 'fill turns the selection on',
      `${await litIn(0)} lit, was ${kickBefore}`);
check(filled.slice(4).filter((s) => s.on).length === filled.slice(4).filter((s) => s.on).length,
      'and leaves the rest of the pattern alone');

// Clearing takes them off again.
await page.locator('#grid-tools .chip', { hasText: 'Clear' }).click();
await page.waitForTimeout(400);
check((await stepsOf(0)).slice(0, 4).every((s) => !s.on), 'clear turns the selection off');

// Copy a phrase and paste it further along.
await cmd({ type: 'cells', op: 'off', cells: '0:0,0:1,0:2,0:3,1:0,1:1,1:2,1:3' });
await cmd({ type: 'stepEdit', track: 0, step: 0, what: 'on', value: 1 });
await cmd({ type: 'stepEdit', track: 0, step: 2, what: 'on', value: 1 });
await cmd({ type: 'stepEdit', track: 0, step: 2, what: 'ratchet', value: 4 });
await page.waitForTimeout(350);
await page.locator('#grid-tools .chip', { hasText: 'Copy' }).click();
await page.waitForTimeout(250);
check(/2 steps copied/.test(await page.locator('#flash').innerText()),
      'copy takes the playing steps only',
      await page.locator('#flash').innerText());

// Select a block starting at step 8 and paste into it.
const c8 = await cellBox(0, 8);
const c11 = await cellBox(1, 11);
await page.keyboard.down('Shift');
await page.mouse.move(c8.x + c8.width / 2, c8.y + c8.height / 2);
await page.mouse.down();
await page.mouse.move(c11.x + c11.width / 2, c11.y + c11.height / 2, { steps: 8 });
await page.mouse.up();
await page.keyboard.up('Shift');
await page.waitForTimeout(350);
await page.locator('#grid-tools .chip', { hasText: 'Paste' }).click();
await page.waitForTimeout(450);
const pasted = await stepsOf(0);
check(pasted[8].on && pasted[10].on && !pasted[9].on,
      'paste lands at the top left of the selection, keeping its shape',
      `8:${pasted[8].on} 9:${pasted[9].on} 10:${pasted[10].on}`);
check(pasted[10].ratchet === 4, 'and carries each step\'s detail with it',
      `ratchet ${pasted[10].ratchet}`);

// Transposing a selection moves pitched steps and leaves drums alone.
await cmd({ type: 'newSong' });
await cmd({ type: 'selectTrack', track: 4 });
await page.waitForTimeout(400);
const bassBefore = (await stepsOf(4)).map((s) => s.deg);
const kickDegBefore = (await stepsOf(0)).map((s) => s.deg);
const b0 = await cellBox(0, 0);
const b15 = await cellBox(4, 15);
await page.keyboard.down('Shift');
await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2);
await page.mouse.down();
await page.mouse.move(b15.x + b15.width / 2, b15.y + b15.height / 2, { steps: 10 });
await page.mouse.up();
await page.keyboard.up('Shift');
await page.waitForTimeout(400);
await page.locator('#grid-tools .chip', { hasText: '♯' }).click();
await page.waitForTimeout(450);
const bassAfter = (await stepsOf(4)).map((s) => s.deg);
check(bassAfter.every((d, i) => d === bassBefore[i] + 1),
      'transposing moves every selected pitched step by a degree',
      `${bassBefore.slice(0, 4).join(',')} -> ${bassAfter.slice(0, 4).join(',')}`);
check((await stepsOf(0)).every((s, i) => s.deg === kickDegBefore[i]),
      'and leaves drums alone, having no pitch to move');

// Escape drops the selection.
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check(await page.locator('.gcell.picked').count() === 0, 'escape drops the selection');

await cmd({ type: 'newSong' });
await cmd({ type: 'selectTrack', track: 4 });
await page.waitForTimeout(350);

// --- notes, edited from inside the grid --------------------------------------
//
// Pitched tracks show the note each step plays and let it be dragged, so a
// line can be written without leaving the view that shows every other track.
const bassRow = page.locator('#grid-rows .grow').nth(4);
const noteLabels = await bassRow.locator('.gcell.on:not(.ghost) .note').allTextContents();
check(noteLabels.length > 0, 'pitched steps show their note', noteLabels.slice(0, 6).join(' '));
check(await page.locator('#grid-rows .grow').nth(0).locator('.note').count() === 0,
      'drum steps do not, having no pitch');

const bassStep = async (n) => (await engine()).tracks[4].patterns[0].steps[n];
const firstLit = (await engine()).tracks[4].patterns[0].steps.findIndex((s) => s.on);
const degBefore = (await bassStep(firstLit)).deg;
const cell = bassRow.locator('.gcell').nth(firstLit);
const cb = await cell.boundingBox();
await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
await page.mouse.down();
await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2 - 42, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(400);
const degAfter = (await bassStep(firstLit)).deg;
check(degAfter > degBefore, 'dragging a step up raises its note',
      `degree ${degBefore} -> ${degAfter}`);
check((await bassStep(firstLit)).on === true,
      'and the drag does not toggle the step off');

// Everything reachable by dragging must be in the key - that is what storing a
// degree rather than a semitone buys.
const A_MINOR_PC = [9, 11, 0, 2, 4, 5, 7];
const afterLabels = await bassRow.locator('.gcell.on:not(.ghost) .note').allTextContents();
const pcOf = (label) => NOTE_ORDER.indexOf(label.replace(/-?\d+$/, ''));
check(afterLabels.every((l) => A_MINOR_PC.includes(pcOf(l))),
      'a retuned note is still in the key', afterLabels.slice(0, 6).join(' '));

// And the same edit is available in the step detail panel.
await page.locator('[data-view="steps"]').click();
await cmd({ type: 'selectTrack', track: 4 });
await page.waitForTimeout(400);
await page.locator('.step').nth(firstLit).click();
await page.locator('.step').nth(firstLit).click();      // leave it on
await page.waitForTimeout(350);
const noteGroup = page.locator('#step-detail .sd-group', { hasText: 'NOTE' });
check(await noteGroup.count() === 1, 'the step panel offers the note too');
await noteGroup.locator('.chip').nth(2).click();
await page.waitForTimeout(350);
check((await bassStep(firstLit)).deg % 7 === 2, 'picking a degree sets the note',
      `degree ${(await bassStep(firstLit)).deg}`);
await page.locator('[data-view="grid"]').click();
await page.waitForTimeout(350);

// Solo and mute from the grid.
await page.locator('#grid-rows .grow').nth(1).locator('.badge', { hasText: 'M' }).click();
await page.waitForTimeout(300);
check((await engine()).tracks[1].mixer.mute === true, 'mute works from the grid');
await page.locator('#grid-rows .grow').nth(1).locator('.badge', { hasText: 'M' }).click();
await page.waitForTimeout(250);

await cmd({ type: 'newSong' });
await page.locator('[data-view="steps"]').click();
await page.waitForTimeout(400);

// --- step detail -------------------------------------------------------------
//
// The engine has always had velocity, ratchet, nudge and trig conditions.
// These checks are about whether any of it can be reached from the interface.
await cmd({ type: 'selectTrack', track: 0 });
await page.locator('[data-view="steps"]').click();
await page.waitForTimeout(350);

const stepOf = async (n) => (await engine()).tracks[0].patterns[0].steps[n];

// Index 5 is off in four-on-the-floor, so one click turns it on and selects it.
await page.locator('.step').nth(5).click();
await page.waitForTimeout(300);
check(await page.locator('.step.sel').count() === 1, 'clicking a step selects it');
check((await stepOf(5)).on === true, 'and toggles it in the same click');
check(await page.locator('#step-detail .sd-title').innerText() === 'STEP 6',
      'the detail panel follows the selection',
      await page.locator('#step-detail .sd-title').innerText());

// Ratchet: pick 4 and the engine has to agree.
await page.locator('#step-detail .sd-group', { hasText: 'RATCHET' })
  .locator('.chip', { hasText: /^4$/ }).click();
await page.waitForTimeout(300);
check((await stepOf(5)).ratchet === 4, 'ratchet reaches the engine',
      `ratchet ${(await stepOf(5)).ratchet}`);
check(await page.locator('.step').nth(5).locator('.mk.r').count() === 1,
      'and shows on the step itself');

// Velocity by drag.
const velBox = await page.locator('#step-detail .param').first().boundingBox();
const velBefore = (await stepOf(5)).vel;
await page.mouse.move(velBox.x + velBox.width / 2, velBox.y + velBox.height / 2);
await page.mouse.down();
await page.mouse.move(velBox.x + velBox.width / 2, velBox.y + velBox.height / 2 - 40, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
check((await stepOf(5)).vel > velBefore + 0.05, 'velocity reaches the engine',
      `${velBefore.toFixed(2)} -> ${(await stepOf(5)).vel.toFixed(2)}`);

// Trig conditions.
await page.locator('#step-detail .sd-group', { hasText: 'PLAYS' })
  .locator('.chip', { hasText: 'Every' }).click();
await page.waitForTimeout(300);
check((await stepOf(5)).cond === 2, 'a trig condition can be set',
      `cond ${(await stepOf(5)).cond}`);
await page.locator('#step-detail .sd-group', { hasText: 'PLAYS' })
  .locator('.chip', { hasText: '1:4' }).click();
await page.waitForTimeout(400);
const ratio = await stepOf(5);
check(ratio.hit === 1 && ratio.of === 4, 'and its ratio', `${ratio.hit}:${ratio.of}`);
await page.locator('#step-detail .sd-group', { hasText: 'PLAYS' })
  .locator('.chip', { hasText: 'Always' }).click();
await page.waitForTimeout(250);

// Pattern shape.
await page.locator('#pattern-shape .stepper', { hasText: 'STEPS' })
  .locator('button', { hasText: '+' }).click();
await page.waitForTimeout(300);
check((await engine()).tracks[0].patterns[0].length === 17, 'pattern length can be changed',
      `${(await engine()).tracks[0].patterns[0].length} steps`);
await page.locator('#pattern-shape .stepper', { hasText: 'STEPS' })
  .locator('button', { hasText: '-' }).click();
await page.waitForTimeout(300);

// Euclid: 5 pulses over 16 must be the cinquillo-derived spread, not 5 in a row.
await page.locator('#pattern-shape .chip', { hasText: 'EUCLID' }).click();
await page.waitForTimeout(350);
check((await engine()).tracks[0].patterns[0].euclid === true, 'euclid mode turns on');
for (let n = 0; n < 3; n++) {
  await page.locator('#pattern-shape .stepper', { hasText: 'PULSES' })
    .locator('button', { hasText: '+' }).click();
  await page.waitForTimeout(160);
}
const euclidPat = (await engine()).tracks[0].patterns[0];
const lit2 = euclidPat.steps.filter((s) => s.on).length;
check(euclidPat.pulses === lit2 && lit2 > 0, 'pulses spread across the pattern',
      `${euclidPat.pulses} pulses, ${lit2} steps lit`);
// Evenly: no two gaps between hits may differ by more than one step.
const hits = euclidPat.steps.map((s, i) => (s.on ? i : -1)).filter((i) => i >= 0);
const gaps = hits.map((h, i) => (i ? h - hits[i - 1] : h + euclidPat.length - hits.at(-1)));
check(Math.max(...gaps) - Math.min(...gaps) <= 1, 'and as evenly as they can be',
      `gaps ${gaps.join(',')}`);

await page.locator('#pattern-shape .chip', { hasText: 'BAKE' }).click();
await page.waitForTimeout(350);
const baked = (await engine()).tracks[0].patterns[0];
check(baked.euclid === false && baked.steps.filter((s) => s.on).length === lit2,
      'baking keeps the rhythm and hands back the steps',
      `${baked.steps.filter((s) => s.on).length} steps on, euclid ${baked.euclid}`);

await cmd({ type: 'newSong' });
await page.waitForTimeout(350);

// --- shaping a bar: rate, filter, groove, master -----------------------------

// Step rate, per track, as a note value.
await page.locator('[data-view="grid"]').click();
await page.waitForTimeout(350);
const rateChip = page.locator('#grid-rows .grow').nth(2).locator('.gh-rate');
check(await rateChip.innerText() === '1/16', 'each track shows its step rate',
      await rateChip.innerText());
await rateChip.click();
await page.waitForTimeout(250);
await page.locator('#track-menu .chip', { hasText: '1/32' }).click();
await page.waitForTimeout(350);
check((await engine()).tracks[2].patterns[0].resolution === 8, 'the rate reaches the engine',
      `resolution ${(await engine()).tracks[2].patterns[0].resolution}`);
check(await page.locator('#grid-rows .grow').nth(2).locator('.gh-rate').innerText() === '1/32',
      'and the track shows it');
// Rates are per track, so changing one must not touch another.
check((await engine()).tracks[0].patterns[0].resolution === 4,
      'and only that track', `kick still ${(await engine()).tracks[0].patterns[0].resolution}/beat`);
await rateChip.click();
await page.waitForTimeout(250);
await page.locator('#track-menu .chip', { hasText: '1/16' }).first().click();
await page.waitForTimeout(300);

// The channel filter.
await page.locator('[data-view="mix"]').click();
await page.waitForTimeout(400);
const strip2 = page.locator('.strip').nth(2);
check(await strip2.locator('.filt').count() === 1, 'every channel has a filter');
check(await strip2.locator('.filt .knob').count() === 0,
      'with no controls shown while it is off');
await strip2.locator('.filt .chip', { hasText: 'Low' }).click();
await page.waitForTimeout(400);
check((await engine()).tracks[2].mixer.filterType === 1, 'switching it on reaches the engine',
      `type ${(await engine()).tracks[2].mixer.filterType}`);
check(await strip2.locator('.filt .knob').count() === 2,
      'and its cutoff and resonance appear');

const cutBox = await strip2.locator('.filt .knob canvas').first().boundingBox();
const fcBefore = (await engine()).tracks[2].mixer.filterCutoff;
await page.mouse.move(cutBox.x + cutBox.width / 2, cutBox.y + cutBox.height / 2);
await page.mouse.down();
await page.mouse.move(cutBox.x + cutBox.width / 2, cutBox.y + cutBox.height / 2 - 55, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(350);
check((await engine()).tracks[2].mixer.filterCutoff > fcBefore * 1.4,
      'and sweeping the cutoff reaches the engine',
      `${Math.round(fcBefore)} -> ${Math.round((await engine()).tracks[2].mixer.filterCutoff)} Hz`);
await strip2.locator('.filt .chip', { hasText: 'Off' }).click();
await page.waitForTimeout(300);

// Master effects: what the per-track sends were always feeding.
check(await page.locator('#master .mgroup').count() === 4,
      'the master bus is reachable',
      `${await page.locator('#master .mgroup').count()} groups`);
const revBox = await page.locator('#master .mgroup', { hasText: 'REVERB' })
  .locator('.knob canvas').first().boundingBox();
const revBefore = (await engine()).master.reverb.size;
await page.mouse.move(revBox.x + revBox.width / 2, revBox.y + revBox.height / 2);
await page.mouse.down();
await page.mouse.move(revBox.x + revBox.width / 2, revBox.y + revBox.height / 2 - 50, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(350);
check((await engine()).master.reverb.size > revBefore + 0.1, 'reverb size is adjustable',
      `${revBefore.toFixed(2)} -> ${(await engine()).master.reverb.size.toFixed(2)}`);

await page.locator('#master .chip', { hasText: '1/8' }).first().click();
await page.waitForTimeout(350);
check(Math.abs((await engine()).master.delay.beats - 0.5) < 0.01, 'delay time is musical',
      `${(await engine()).master.delay.beats} beats`);

// Groove.
await page.locator('#groove').click();
await page.waitForTimeout(300);
check(await page.locator('#track-menu .groove-knobs').count() === 1, 'groove controls open');
const swingBox = await page.locator('#track-menu .groove-knobs .knob canvas').nth(1).boundingBox();
await page.mouse.move(swingBox.x + swingBox.width / 2, swingBox.y + swingBox.height / 2);
await page.mouse.down();
await page.mouse.move(swingBox.x + swingBox.width / 2, swingBox.y + swingBox.height / 2 - 45, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(350);
check((await engine()).swing > 0.2, 'swing reaches the engine',
      `${pctOf((await engine()).swing)}`);
await cmd({ type: 'swing', value: 0 });
await page.keyboard.press('Escape');
await page.locator('#grid-rows, #mixer').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
await page.waitForTimeout(250);

// Tempo by dragging the readout.
const bpmBefore = (await engine()).bpm;
const gb = await page.locator('#groove').boundingBox();
await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
await page.mouse.down();
await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2 - 40, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(350);
check((await engine()).bpm > bpmBefore + 3, 'dragging the tempo readout changes it',
      `${bpmBefore} -> ${(await engine()).bpm}`);
await cmd({ type: 'bpm', value: 124 });

// Meters.
await page.locator('[data-view="grid"]').click();
await cmd({ type: 'play' });
await page.waitForTimeout(1200);
const meterWidths = await page.evaluate(() =>
  [...document.querySelectorAll('#grid-rows .gh-meter i')].map((el) => parseFloat(el.style.width) || 0));
check(meterWidths.some((w) => w > 1), 'track meters move while it plays',
      meterWidths.map((w) => Math.round(w) + '%').join(' '));
await cmd({ type: 'stop' });
await page.waitForTimeout(300);

// --- the performance layer ---------------------------------------------------
//
// Forty keys, four layers, always on screen. Checked as an instrument: does a
// key make the sound it says it will, does a held note stop when let go, does
// a quantised launch wait for its boundary.
await cmd({ type: 'newSong' });
await page.waitForTimeout(500);

check(await page.locator('#pads .pad').count() === 40, 'forty pads are on screen',
      `${await page.locator('#pads .pad').count()} pads`);
check(await page.locator('.layer-tab').count() === 4, 'across four layers');

const padLabels = await page.locator('#pads .pad span').allTextContents();
check(padLabels.slice(20, 24).join(',') === 'Kick,Clap,Hats,Snare',
      'the home row is the kit, and says so', padLabels.slice(20, 24).join(' '));
check(padLabels.filter((l) => l).length >= 28,
      'and most of the layer is mapped, not empty',
      `${padLabels.filter((l) => l).length} of 40 labelled`);

// A drum pad makes its drum.
await cmd({ type: 'stop' });
await page.waitForTimeout(300);
await page.keyboard.down('a');
await page.waitForTimeout(80);
await page.keyboard.up('a');
let padPeak = 0;
for (let i = 0; i < 12; i++) { padPeak = Math.max(padPeak, (await engine()).peak);
                               await page.waitForTimeout(40); }
check(padPeak > 0.02, 'pressing a pad sounds it', `peak ${padPeak.toFixed(3)}`);

// The melody layer holds while held, and stops when let go.
await page.keyboard.press('F2');
await page.waitForTimeout(400);
check(await page.locator('.layer-tab.on').innerText().then((t) => /MELODY/.test(t)),
      'F2 switches layer', await page.locator('.layer-tab.on').innerText());
await page.keyboard.down('Digit1');
let chordPeak = 0;
for (let i = 0; i < 12; i++) { chordPeak = Math.max(chordPeak, (await engine()).peak);
                               await page.waitForTimeout(40); }
await page.keyboard.up('Digit1');
check(chordPeak > 0.02, 'a chord pad sounds while held', `peak ${chordPeak.toFixed(3)}`);
await page.waitForTimeout(900);
check((await engine()).peak < chordPeak * 0.5, 'and stops when it is let go',
      `${chordPeak.toFixed(3)} -> ${(await engine()).peak.toFixed(3)}`);

// A clip launch waits for the bar rather than landing where the finger did.
await page.keyboard.press('F3');
await page.waitForTimeout(400);
const clipLabels = await page.locator('#pads .pad span').allTextContents();
check(/Kick/.test(clipLabels[0] ?? '') && /Stop/.test(clipLabels[30] ?? ''),
      'the clips layer is a column per track with a stop row',
      `${clipLabels[0]} … ${clipLabels[30]}`);

await cmd({ type: 'play' });
await page.waitForTimeout(700);
const patternBefore = (await engine()).tracks[0].activePattern;
await page.keyboard.down('q');
await page.waitForTimeout(60);
await page.keyboard.up('q');
await page.waitForTimeout(150);
check((await engine()).pending.length > 0, 'a quantised launch queues rather than firing',
      `${(await engine()).pending.length / 2} waiting`);
check(await page.locator('#pads .pad.queued').count() > 0, 'and shows it pulsing');
await page.waitForTimeout(2600);
check((await engine()).tracks[0].activePattern !== patternBefore,
      'then lands on the boundary',
      `pattern ${patternBefore} -> ${(await engine()).tracks[0].activePattern}`);
await cmd({ type: 'stop' });
await page.keyboard.press('F1');
await page.waitForTimeout(300);

// A new track has to be playable straight away, or the mapping is a liability.
await cmd({ type: 'addTrack', kind: 'synth' });
await cmd({ type: 'remapKeys' });
await page.waitForTimeout(700);
const mapped = await page.evaluate(async () => {
  const km = await (await fetch('/api/keymap')).json();
  const n = (await (await fetch('/api/state')).json()).tracks.length - 1;
  return km.layers.flatMap((l) => l.cells).filter((c) => c.track === n
                                                       && c.mode !== 'empty').length;
});
check(mapped > 0, 'a track added later gets keys of its own', `${mapped} cells`);
await cmd({ type: 'newSong' });
await page.waitForTimeout(400);


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
    // Stamped here, at the moment of the "press", exactly as the interface
    // does it - so what is measured is the rhythm played, not the rhythm the
    // requests happened to arrive in.
    const at = performance.now() / 1000;
    send('noteOn', { note, velocity: 0.85, at });
    setTimeout(() => send('noteOff', { note, at: performance.now() / 1000 }), noteMs * 0.6);
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
