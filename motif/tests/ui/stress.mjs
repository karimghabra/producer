// Motif — stress and fuzz.
//
// Three passes against the running application:
//
//   1. Sweep    every visible control in every view is clicked once, and the
//               invariants are checked after each one.
//   2. Commands the bridge is fed rubbish - missing fields, indices past the
//               end, NaN, enormous numbers, hostile strings - to check it
//               refuses rather than corrupts.
//   3. Walkers  random sequences of real interactions: navigating, clicking,
//               dragging knobs, drawing curves, typing. The invariants are
//               checked continuously.
//
// Everything is driven from a seeded generator, so a failure can be replayed
// exactly rather than merely described:
//
//   node stress.mjs                  a random seed, printed on the way out
//   node stress.mjs --seed 12345     that run again
//   node stress.mjs --steps 400      longer walk
//
// The session is saved before it starts and put back afterwards.
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};

const SEED = flag('seed', Math.floor(Math.random() * 1e9));
const STEPS = flag('steps', 220);
const BACKUP = 'Stress Backup';

/** mulberry32: small, fast, and the same sequence for the same seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// ---------------------------------------------------------------------------

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts().flatMap((c) => c.pages())
  .find((p) => p.url().startsWith('http://127.0.0.1:'));
if (!page) {
  console.error('Motif is not running, or its interface page was not found.');
  process.exit(1);
}

const problems = [];
const fail = (what, detail = '') => problems.push({ what, detail, step: history.length });
const history = [];
const note = (action) => history.push(action);

// Anything the page throws is a failure, whether or not it broke a check.
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') {
    const text = m.text();
    // 404s for a favicon are not the application misbehaving.
    if (!/favicon|Failed to load resource/.test(text)) pageErrors.push(text);
  }
});

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.track', { timeout: 15000 });

const engine = () => page.evaluate(async () => (await fetch('/api/state')).json());
const cmd = (body) => page.evaluate((b) => fetch('/api/command', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
}).then((r) => r.status), body);
const raw = (text) => page.evaluate((t) => fetch('/api/command', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: t,
}).then((r) => r.status).catch(() => 0), text);

// ---------------------------------------------------------------------------
// Invariants
//
// What has to be true no matter what was clicked. Each is a thing that, if it
// ever went false, would mean the app was broken rather than merely surprising.
// ---------------------------------------------------------------------------

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

async function checkInvariants(context) {
  let s;
  try {
    s = await engine();
  } catch (e) {
    fail('the engine stopped answering', `${context}: ${e.message}`);
    return null;
  }

  if (!s || !Array.isArray(s.tracks)) { fail('state is not a song', context); return null; }
  if (s.tracks.length < 1) fail('the song was left with no tracks', context);
  if (!finite(s.bpm) || s.bpm < 20 || s.bpm > 400) fail('tempo left its range', `${context}: ${s.bpm}`);
  if (!finite(s.peak) || s.peak > 1.0001) fail('the output clipped', `${context}: peak ${s.peak}`);
  if (!finite(s.swing) || s.swing < 0 || s.swing > 1) fail('swing left its range', `${context}: ${s.swing}`);

  s.tracks.forEach((t, i) => {
    if (!t.patterns?.length) fail('a track was left with no patterns', `${context}: track ${i}`);
    if (t.activePattern < 0 || t.activePattern >= (t.patterns?.length ?? 0))
      fail('activePattern points past the end', `${context}: track ${i} -> ${t.activePattern}`);
    if (!finite(t.mixer?.gain) || !finite(t.mixer?.pan) || !finite(t.mixer?.filterCutoff))
      fail('a mixer value is not a number', `${context}: track ${i}`);
    if (t.mixer.filterCutoff < 20 || t.mixer.filterCutoff > 20000)
      fail('filter cutoff left the audible range', `${context}: ${t.mixer.filterCutoff}`);
    t.patterns.forEach((p, pi) => {
      if (p.length < 1) fail('a pattern has no steps', `${context}: track ${i} pattern ${pi}`);
      if (p.steps.length < p.length)
        fail('a pattern is shorter than it claims', `${context}: ${p.steps.length} < ${p.length}`);
      if (p.resolution < 1 || p.resolution > 16)
        fail('pattern resolution left its range', `${context}: ${p.resolution}`);
      p.steps.forEach((st) => {
        if (!finite(st.vel) || st.vel < 0 || st.vel > 1)
          fail('step velocity left its range', `${context}: ${st.vel}`);
        if (!finite(st.nudge) || Math.abs(st.nudge) > 0.5)
          fail('step nudge left its range', `${context}: ${st.nudge}`);
      });
    });
  });

  // A scene's pattern list is indexed by track. If a track is added or removed
  // and the scenes are not brought along, every scene silently starts playing
  // the wrong patterns on the wrong tracks.
  (s.scenes ?? []).forEach((sc, i) => {
    if (sc.patterns.length !== s.tracks.length)
      fail('a scene no longer lines up with the tracks',
           `${context}: scene ${i} has ${sc.patterns.length} entries for ${s.tracks.length} tracks`);
    sc.patterns.forEach((p, ti) => {
      if (p >= (s.tracks[ti]?.patterns.length ?? 0))
        fail('a scene points at a pattern that is not there',
             `${context}: scene ${i} track ${ti} -> ${p}`);
    });
  });

  // The arrangement has to stay self-consistent, or playback silently breaks.
  (s.arrangement ?? []).forEach((sec, i) => {
    if (sec.scene < 0 || sec.scene >= (s.scenes?.length ?? 0))
      fail('a section points at a scene that is not there', `${context}: section ${i} -> ${sec.scene}`);
    if (sec.bars < 1) fail('a section is shorter than a bar', `${context}: section ${i}`);
    sec.lanes.forEach((lane) => {
      lane.tracks?.forEach((t) => {
        if (t < 0 || t >= s.tracks.length)
          fail('an automation lane points at a track that is gone',
               `${context}: section ${i} -> track ${t} of ${s.tracks.length}`);
      });
      lane.points.forEach((p, pi) => {
        if (!finite(p.v) || p.v < 0 || p.v > 1)
          fail('an automation value left 0..1', `${context}: ${p.v}`);
        if (!finite(p.bar) || p.bar < 0)
          fail('an automation point sits before the section', `${context}: ${p.bar}`);
        if (pi && p.bar < lane.points[pi - 1].bar)
          fail('automation points are out of order', context);
      });
    });
  });

  // The interface must not have been pushed off its own window.
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    stray: [...document.querySelectorAll('.menu')].filter((m) => {
      const r = m.getBoundingClientRect();
      return r.right > innerWidth + 2 || r.bottom > innerHeight + 2 || r.top < -2 || r.left < -2;
    }).length,
  }));
  if (overflow.x > 1) fail('the layout overflowed sideways', `${context}: ${overflow.x}px`);
  if (overflow.stray) fail('a menu opened outside the window', `${context}: ${overflow.stray}`);

  if (pageErrors.length) {
    fail('the page threw', `${context}: ${pageErrors[0]}`);
    pageErrors.length = 0;
  }
  return s;
}

// ---------------------------------------------------------------------------

const VIEWS = ['grid', 'steps', 'mix', 'sound', 'song'];
const gotoView = async (v) => {
  await page.locator(`[data-view="${v}"]`).click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(140);
};

const dismiss = async () => {
  await page.keyboard.press('Escape').catch(() => {});
  await page.mouse.click(6, 6).catch(() => {});
  await page.waitForTimeout(60);
};

console.log(`\nMotif stress  ·  seed ${SEED}  ·  ${STEPS} steps\n${'='.repeat(52)}\n`);

// Put the session somewhere safe, then work on a scratch song.
await cmd({ type: 'save', name: BACKUP });
await cmd({ type: 'newSong' });
await page.waitForTimeout(300);

// Give the fuzzer something with structure to break: scenes, sections, lanes.
await cmd({ type: 'addScene' });
await cmd({ type: 'seqEnabled', track: 5, value: 0 });
await cmd({ type: 'addScene' });
await cmd({ type: 'addSection', scene: 0, bars: 4 });
await cmd({ type: 'addSection', scene: 1, bars: 2 });
await cmd({ type: 'filter', track: 0, what: 'type', value: 1 });
await cmd({ type: 'addLane', section: 0, laneTrack: 0, param: 'cutoff' });
await page.waitForTimeout(400);
await checkInvariants('after setup');

// ---------------------------------------------------------------------------
// Pass 1 — click everything
// ---------------------------------------------------------------------------

let clicked = 0;
for (const view of VIEWS) {
  await gotoView(view);
  // Re-counted each time: clicking a control can add or remove others.
  const count = await page.locator('#stage .view.on button, #stage .view.on select, header button, .menu button').count();
  for (let i = 0; i < count + 6; i++) {
    const all = page.locator('#stage .view.on button, #stage .view.on select, header button, .menu button');
    const n = await all.count();
    if (i >= n) break;
    const el = all.nth(i);

    // Skipped deliberately: it is the one control that destroys something the
    // test cannot put back, and it is covered by name in verify.mjs.
    const cls = await el.getAttribute('class').catch(() => '') ?? '';
    if (cls.includes('menu-del')) continue;

    const label = (await el.innerText().catch(() => '') ?? '').trim().slice(0, 22)
      || (await el.getAttribute('title').catch(() => '') ?? '').slice(0, 22)
      || `#${i}`;
    note(`click ${view}/${label}`);

    if (await el.evaluate((e) => e.tagName === 'SELECT').catch(() => false)) {
      const opts = await el.locator('option').count();
      if (opts) await el.selectOption({ index: int(0, opts - 1) }).catch(() => {});
    } else {
      await el.click({ timeout: 1200 }).catch(() => {});
    }
    clicked++;
    await page.waitForTimeout(70);
    await checkInvariants(`clicking ${view}/${label}`);
    await dismiss();
  }
}
console.log(`Pass 1  swept ${clicked} controls across ${VIEWS.length} views`);

// ---------------------------------------------------------------------------
// Pass 2 — feed the bridge rubbish
// ---------------------------------------------------------------------------

const HOSTILE = [
  '{}',
  '{"type":""}',
  '{"type":"nonsense"}',
  'not json at all',
  '',
  '{"type":"gain","track":99999,"value":5}',
  '{"type":"gain","track":-5,"value":-99}',
  '{"type":"bpm","value":1e308}',
  '{"type":"bpm","value":-1e308}',
  '{"type":"bpm","value":"abc"}',
  '{"type":"swing","value":9999}',
  '{"type":"stepEdit","track":0,"step":-1,"what":"vel","value":0.5}',
  '{"type":"stepEdit","track":0,"step":99999,"what":"vel","value":0.5}',
  '{"type":"stepEdit","track":0,"step":0,"what":"nope","value":1}',
  '{"type":"patternLength","track":0,"value":0}',
  '{"type":"patternLength","track":0,"value":100000}',
  '{"type":"patternResolution","track":0,"value":-3}',
  '{"type":"removeTrack","track":99}',
  '{"type":"moveTrack","track":0,"to":999}',
  '{"type":"param","track":0,"id":"../../etc","value":0.5}',
  '{"type":"param","track":0,"id":"cutoff","value":1e9}',
  '{"type":"preset","name":"does not exist"}',
  '{"type":"renameTrack","track":0,"name":""}',
  '{"type":"key","root":999,"scale":999}',
  '{"type":"key","root":-999,"scale":-1}',
  '{"type":"sectionBars","section":0,"value":-4}',
  '{"type":"sectionScene","section":0,"value":9999}',
  '{"type":"addSection","scene":9999,"bars":-1}',
  '{"type":"removeSection","section":9999}',
  '{"type":"addLane","section":0,"laneTrack":0,"param":"nope"}',
  '{"type":"laneCurve","section":0,"lane":0,"points":""}',
  '{"type":"laneCurve","section":0,"lane":0,"points":"garbage"}',
  '{"type":"laneCurve","section":0,"lane":0,"points":"-5:-5,999:999"}',
  '{"type":"laneCurve","section":0,"lane":0,"points":"1:0.5,0:0.9"}',   // out of order
  '{"type":"laneCurve","section":9999,"lane":9999,"points":"0:0"}',
  '{"type":"laneTrack","section":0,"lane":0,"laneTrack":9999,"value":1}',
  '{"type":"filter","track":0,"what":"cutoff","value":-1}',
  '{"type":"filter","track":0,"what":"cutoff","value":1e12}',
  '{"type":"master","what":"nope","value":1}',
  '{"type":"master","what":"revMix","value":1e9}',
  '{"type":"noteOn","note":-500,"velocity":99}',
  '{"type":"noteOn","note":99999,"velocity":-99}',
  '{"type":"noteOnDegree","degree":100000,"octave":100000}',
  '{"type":"save","name":"../../../evil"}',
  '{"type":"load","name":"does not exist"}',
  '{"type":"deleteProject","name":"does not exist"}',
  '{"type":"renameScene","scene":9999,"name":"x"}',
  '{"type":"removeScene","scene":9999}',
];

let refused = 0;
for (const body of HOSTILE) {
  note(`command ${body.slice(0, 46)}`);
  const status = await raw(body);
  if (status === 0) fail('a command killed the connection', body);
  if (status >= 500) fail('a command produced a server error', `${status}: ${body}`);
  if (status === 400) refused++;
  const s = await checkInvariants(`after ${body.slice(0, 40)}`);
  if (s && s.tracks.length < 1) break;
}
// A traversal name must not have escaped the projects folder.
const projects = await page.evaluate(async () => (await fetch('/api/projects')).json());
if (projects.names.some((n) => n.includes('..') || n.includes('/') || n.includes('\\')))
  fail('a project name escaped sanitising', projects.names.join(','));
await cmd({ type: 'deleteProject', name: 'evil' });
console.log(`Pass 2  sent ${HOSTILE.length} hostile commands, ${refused} refused cleanly`);

// ---------------------------------------------------------------------------
// Pass 3 — random walkers
// ---------------------------------------------------------------------------

/** Drag a random knob somewhere random. */
async function dragSomething() {
  const knobs = page.locator('#stage .knob canvas');
  const n = await knobs.count();
  if (!n) return 'no knobs here';
  const k = knobs.nth(int(0, n - 1));
  const box = await k.boundingBox().catch(() => null);
  if (!box) return 'knob had no box';
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + int(-30, 30), cy + int(-90, 90), { steps: int(3, 10) });
  await page.mouse.up();
  return 'dragged a knob';
}

/** Scribble on an automation lane. */
async function drawSomething() {
  const lanes = page.locator('.lane-canvas');
  const n = await lanes.count();
  if (!n) return 'no lanes here';
  const box = await lanes.nth(int(0, n - 1)).boundingBox().catch(() => null);
  if (!box) return 'lane had no box';
  await page.mouse.move(box.x + rand() * box.width, box.y + rand() * box.height);
  await page.mouse.down();
  for (let i = 0; i < int(2, 6); i++) {
    await page.mouse.move(box.x + rand() * box.width, box.y + rand() * box.height, { steps: 4 });
  }
  await page.mouse.up();
  return 'drew a curve';
}

/** Click a random visible control. */
async function clickSomething() {
  // Only what is on screen. The other views are still in the document, and
  // clicking into them would spend three seconds waiting for a control that is
  // never going to become visible.
  const all = page.locator(
    '#stage .view.on button, #stage .view.on .gcell, #stage .view.on .step, '
    + 'header button, .menu button, .lane-tracks button');
  const n = await all.count();
  if (!n) return 'nothing to click';
  const el = all.nth(int(0, n - 1));
  const cls = await el.getAttribute('class').catch(() => '') ?? '';
  if (cls.includes('menu-del')) return 'skipped a delete';
  const label = (await el.innerText().catch(() => '') ?? '').trim().slice(0, 18);
  await el.click({ timeout: 1200 }).catch(() => {});
  return `clicked ${label || 'a control'}`;
}

async function playKeys() {
  const keys = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'q', 'w', 'e', 'r', 't'];
  const k = pick(keys);
  await page.keyboard.down(k);
  await page.waitForTimeout(int(20, 90));
  await page.keyboard.up(k);
  return `played ${k}`;
}

async function typeSomewhere() {
  const fields = page.locator('input[type=text], .nm[contenteditable="true"]');
  if (!await fields.count()) return 'no fields open';
  await fields.first().fill(pick(['', ' ', '<script>x</script>', '../../etc', 'ok name', 'Ω≈ç√'])).catch(() => {});
  await page.keyboard.press('Enter').catch(() => {});
  return 'typed into a field';
}

/**
 * Add and remove the things the song is made of.
 *
 * The invariants that matter most are structural - never no tracks, never a
 * pattern index past the end, never a section pointing at a scene that has
 * been deleted - and clicking cells will not reach any of them. This churns
 * structure directly so those get exercised.
 */
async function churn() {
  const s = await engine();
  const t = int(0, Math.max(0, s.tracks.length - 1));
  const move = pick([
    ['addTrack', { kind: pick(['drum', 'synth']) }],
    ['removeTrack', { track: t }],
    ['duplicateTrack', { track: t }],
    ['moveTrack', { track: t, to: int(0, Math.max(0, s.tracks.length - 1)) }],
    ['addPattern', { track: t }],
    ['duplicatePattern', { track: t }],
    ['removePattern', { track: t, index: int(0, 4) }],
    ['selectPattern', { track: t, index: int(0, 4) }],
    ['patternLength', { track: t, value: int(1, 33) }],
    ['patternResolution', { track: t, value: pick([1, 2, 3, 4, 6, 8]) }],
    ['addScene', {}],
    ['removeScene', { scene: int(0, Math.max(0, (s.scenes?.length ?? 1) - 1)) }],
    ['recallScene', { scene: int(0, Math.max(0, (s.scenes?.length ?? 1) - 1)) }],
    ['updateScene', { scene: int(0, Math.max(0, (s.scenes?.length ?? 1) - 1)) }],
    ['addSection', { scene: int(0, 3), bars: int(1, 9) }],
    ['removeSection', { section: int(0, Math.max(0, (s.arrangement?.length ?? 1) - 1)) }],
    ['sectionBars', { section: int(0, 3), value: int(1, 17) }],
    ['sectionScene', { section: int(0, 3), value: int(0, 3) }],
    ['moveSection', { section: int(0, 3), to: int(0, 3) }],
    ['addLane', { section: int(0, 3), laneTrack: t, param: pick(['cutoff', 'gain', 'verb', 'mRevMix', 'mDlyFb']) }],
    ['removeLane', { section: int(0, 3), lane: int(0, 3) }],
    ['laneTrack', { section: int(0, 3), lane: int(0, 3), laneTrack: t, value: int(0, 1) }],
    ['filter', { track: t, what: pick(['type', 'cutoff', 'reso']), value: rand() * 4000 }],
    ['euclid', { track: t, what: pick(['on', 'pulses', 'rotation', 'bake']), value: int(0, 9) }],
    ['newSong', {}],
  ]);
  await cmd({ type: move[0], ...move[1] });
  return `churn ${move[0]}`;
}

const ACTIONS = [
  [18, async () => { const v = pick(VIEWS); await gotoView(v); return `view ${v}`; }],
  [24, clickSomething],
  [20, churn],
  [10, dragSomething],
  [7, drawSomething],
  [8, playKeys],
  [3, typeSomewhere],
  [4, async () => { await cmd({ type: pick(['play', 'stop']) }); return 'transport'; }],
  [3, async () => { await cmd({ type: 'songMode', value: int(0, 1) }); return 'song mode'; }],
  [3, async () => { await page.keyboard.press(pick(['z', 'x', ' ', 'Escape'])); return 'key shortcut'; }],
  [3, dismiss],
];
const TOTAL_WEIGHT = ACTIONS.reduce((a, [w]) => a + w, 0);
const chooseAction = () => {
  let r = rand() * TOTAL_WEIGHT;
  for (const [w, fn] of ACTIONS) { if ((r -= w) <= 0) return fn; }
  return ACTIONS[0][1];
};

let walked = 0;
for (let step = 0; step < STEPS; step++) {
  const before = problems.length;
  const what = await chooseAction()().catch((e) => `threw: ${e.message}`);
  note(what);
  walked++;
  if (String(what).startsWith('threw:')) fail('an interaction threw', String(what));
  await page.waitForTimeout(40);
  await checkInvariants(what);

  if (problems.length > before) {
    console.log(`\n  first failure at step ${step + 1}: ${what}`);
    console.log('  leading up to it:');
    for (const h of history.slice(-8)) console.log(`    ${h}`);
    break;
  }
}
console.log(`Pass 3  walked ${walked} random steps`);

// ---------------------------------------------------------------------------

// Leave nothing armed or held. Recording and song mode are toggles, and a
// sweep that clicks every button lands on them an unpredictable number of
// times - which is how the next suite to run ends up testing this one's mess.
await cmd({ type: 'stop' });
if ((await engine()).recording) await cmd({ type: 'record' });
await cmd({ type: 'clearTake' });
await cmd({ type: 'songMode', value: 0 });
await cmd({ type: 'allNotesOff' });
await page.waitForTimeout(200);
await cmd({ type: 'load', name: BACKUP });
await page.waitForTimeout(400);
await cmd({ type: 'deleteProject', name: BACKUP });

const restored = await engine();
if (!restored?.tracks?.length) fail('the session was not restored', 'backup failed to load');

console.log(`\n${'='.repeat(52)}`);
if (!problems.length) {
  console.log(`PASS  no problems in ${history.length} interactions  ·  seed ${SEED}`);
} else {
  console.log(`FAIL  ${problems.length} problem(s)  ·  replay with --seed ${SEED}\n`);
  const seen = new Set();
  for (const p of problems) {
    const key = p.what + p.detail;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  ${p.what}`);
    if (p.detail) console.log(`      ${p.detail}`);
  }
}
console.log('');
process.exit(problems.length ? 1 : 0);
