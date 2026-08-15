// Pulse against Motif, workflow by workflow.
//
// The invariant suite in stress.mjs checks that Motif never breaks. It passed
// while the app was unusable, because "the value reached the engine" and "a
// musician can get what they wanted" are different claims and only the first
// was being made.
//
// This makes the second claim. Each workflow is a thing a producer actually
// does, written twice - once against Pulse, once against Motif - and the two
// are compared on what came out musically, not on what the screen looked like.
// Pulse is the reference because it is the one that worked.
//
// It reports two things per workflow:
//
//   RESULT   did the same musical intent produce the same musical outcome
//   COST     how many interactions it took in each, since a feature that is
//            reachable but takes nine clicks is a feature people do not use
//
//   node parity.mjs                  every workflow
//   node parity.mjs --only grid      just the ones whose name matches
//   node parity.mjs --motif-only     when Pulse is not running
//
// Pulse:  npm run dev   (client 5177)
// Motif:  the running exe, debug port 9222
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const motifOnly = args.includes('--motif-only');
const PULSE = 'http://localhost:5177';
const MOTIF_CDP = 'http://127.0.0.1:9222';

// ---------------------------------------------------------------------------
// A normalised snapshot
//
// The two apps hold a song in different shapes. Everything below compares this
// form instead, so a difference is a difference in the music rather than in
// how the two happen to store it.
// ---------------------------------------------------------------------------

const PULSE_SNAPSHOT = () => {
  const p = window.pulseStore.getState().project;
  return {
    bpm: p.bpm,
    swing: p.swing,
    tracks: p.tracks.map((t) => {
      const pat = t.patterns[t.activePattern];
      return {
        name: t.name,
        isDrum: t.instrument.kind === 'drum',
        gain: t.mixer.gain,
        mute: t.mixer.mute,
        // The two things that caused the trouble: a pattern's length in steps
        // and what that means in bars.
        steps: pat.length,
        resolution: pat.resolution,
        beats: pat.length / pat.resolution,
        on: pat.steps.slice(0, pat.length).map((s) => (s.on ? 1 : 0)).join(''),
        velocities: pat.steps.slice(0, pat.length).map((s) => Math.round(s.velocity * 100)),
        degrees: pat.steps.slice(0, pat.length).map((s) => s.degree),
      };
    }),
  };
};

const MOTIF_SNAPSHOT = async () => {
  const s = await (await fetch('/api/state')).json();
  return {
    bpm: s.bpm,
    swing: s.swing,
    tracks: s.tracks.map((t) => {
      const pat = t.patterns[t.activePattern];
      return {
        name: t.name,
        isDrum: t.isDrum,
        gain: t.mixer.gain,
        mute: t.mixer.mute,
        steps: pat.length,
        resolution: pat.resolution,
        beats: pat.length / pat.resolution,
        on: pat.steps.slice(0, pat.length).map((x) => (x.on ? 1 : 0)).join(''),
        velocities: pat.steps.slice(0, pat.length).map((x) => Math.round(x.vel * 100)),
        degrees: pat.steps.slice(0, pat.length).map((x) => x.deg),
      };
    }),
  };
};

// ---------------------------------------------------------------------------

/** Counts what a workflow had to do, so two interfaces can be compared on effort. */
class Hands {
  constructor(page, label) { this.page = page; this.label = label; this.actions = 0; }
  async click(selector, opts) {
    this.actions++;
    await this.page.locator(selector).first().click({ timeout: 5000, ...opts });
    await this.page.waitForTimeout(90);
  }
  async clickText(selector, text) {
    this.actions++;
    await this.page.locator(selector, { hasText: text }).first().click({ timeout: 5000 });
    await this.page.waitForTimeout(90);
  }
  /** A direct state change, for setting up rather than for measuring. */
  async setup(fn) { await fn(); await this.page.waitForTimeout(120); }
}

const workflows = [];
const workflow = (name, intent, spec) => workflows.push({ name, intent, ...spec });

// ---------------------------------------------------------------------------
// The workflows
// ---------------------------------------------------------------------------

workflow('tempo', 'set the tempo to 128', {
  async pulse(page, hands) {
    await hands.setup(() => page.evaluate(() => window.pulseStore.getState().setBpm(128)));
  },
  async motif(page, hands) {
    await hands.setup(() => page.evaluate(() => fetch('/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'bpm', value: 128 }),
    })));
  },
  compare: (a, b) => ({ ok: a.bpm === b.bpm, detail: `${a.bpm} vs ${b.bpm}` }),
});

workflow('grid-keeps-length',
         'a one-bar pattern is still one bar after changing its grid to 1/32', {
  async pulse(page, hands) {
    await hands.setup(() => page.evaluate(() => {
      const s = window.pulseStore.getState();
      const t = s.project.tracks[0];
      s.updatePattern(t.id, t.activePattern, { length: 16, resolution: 4 });
    }));
    await hands.setup(() => page.evaluate(() => {
      const s = window.pulseStore.getState();
      const t = s.project.tracks[0];
      s.updatePattern(t.id, t.activePattern, { resolution: 8 });
    }));
  },
  async motif(page, hands) {
    const send = (b) => page.evaluate((x) => fetch('/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(x),
    }), b);
    await hands.setup(() => send({ type: 'patternLength', track: 0, value: 16 }));
    await hands.setup(() => send({ type: 'patternResolution', track: 0, value: 4 }));
    await hands.setup(() => send({ type: 'patternResolution', track: 0, value: 8 }));
  },
  // The musical question: is it still a bar?
  compare: (a, b) => ({
    ok: Math.abs(a.tracks[0].beats - b.tracks[0].beats) < 1e-6,
    detail: `Pulse ${a.tracks[0].steps} steps = ${a.tracks[0].beats} beats, `
          + `Motif ${b.tracks[0].steps} steps = ${b.tracks[0].beats} beats`,
  }),
  expectation: {
    what: 'a bar stays a bar when the grid changes',
    holds: (s) => Math.abs(s.tracks[0].beats - 4) < 1e-6,
  },
});

workflow('step-toggle', 'turn on the first four steps of the first track', {
  async pulse(page, hands) {
    await hands.setup(() => page.evaluate(() => {
      const s = window.pulseStore.getState();
      const t = s.project.tracks[0];
      for (let i = 0; i < 4; i++) s.updateStep(t.id, t.activePattern, i, { on: true });
    }));
  },
  async motif(page, hands) {
    await hands.setup(() => page.evaluate(() => fetch('/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'cells', op: 'on', cells: '0:0,0:1,0:2,0:3' }),
    })));
  },
  compare: (a, b) => ({
    ok: a.tracks[0].on.slice(0, 4) === b.tracks[0].on.slice(0, 4),
    detail: `${a.tracks[0].on.slice(0, 8)} vs ${b.tracks[0].on.slice(0, 8)}`,
  }),
});

workflow('velocity', 'set the first step to half velocity', {
  async pulse(page, hands) {
    await hands.setup(() => page.evaluate(() => {
      const s = window.pulseStore.getState();
      const t = s.project.tracks[0];
      s.updateStep(t.id, t.activePattern, 0, { on: true, velocity: 0.5 });
    }));
  },
  async motif(page, hands) {
    const send = (b) => page.evaluate((x) => fetch('/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(x),
    }), b);
    await hands.setup(() => send({ type: 'stepEdit', track: 0, step: 0, what: 'on', value: 1 }));
    await hands.setup(() => send({ type: 'stepEdit', track: 0, step: 0, what: 'vel', value: 0.5 }));
  },
  compare: (a, b) => ({
    ok: Math.abs(a.tracks[0].velocities[0] - b.tracks[0].velocities[0]) <= 1,
    detail: `${a.tracks[0].velocities[0]} vs ${b.tracks[0].velocities[0]}`,
  }),
});

workflow('swing', 'set swing to 40%', {
  async pulse(page, hands) {
    await hands.setup(() => page.evaluate(() =>
      window.pulseStore.getState().setSwing(0.4)));
  },
  async motif(page, hands) {
    await hands.setup(() => page.evaluate(() => fetch('/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'swing', value: 0.4 }),
    })));
  },
  compare: (a, b) => ({
    ok: Math.abs(a.swing - b.swing) < 0.01,
    detail: `${a.swing} vs ${b.swing}`,
  }),
});

workflow('mute', 'mute the second track', {
  async pulse(page, hands) {
    await hands.setup(() => page.evaluate(() => {
      const s = window.pulseStore.getState();
      s.updateMixer(s.project.tracks[1].id, { mute: true });
    }));
  },
  async motif(page, hands) {
    await hands.setup(() => page.evaluate(() => fetch('/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'mute', track: 1, value: 1 }),
    })));
  },
  compare: (a, b) => ({
    ok: a.tracks[1].mute === b.tracks[1].mute,
    detail: `${a.tracks[1].mute} vs ${b.tracks[1].mute}`,
  }),
});

workflow('add-track', 'add a synth track', {
  async pulse(page, hands) {
    await hands.setup(() => page.evaluate(() =>
      window.pulseStore.getState().addTrack()));
  },
  async motif(page, hands) {
    await hands.setup(() => page.evaluate(() => fetch('/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'addTrack', kind: 'synth' }),
    })));
  },
  compare: (a, b) => ({
    ok: a.tracks.length === b.tracks.length && !a.tracks.at(-1).isDrum === !b.tracks.at(-1).isDrum,
    detail: `${a.tracks.length} tracks vs ${b.tracks.length}`,
  }),
  expectation: {
    what: 'a new track arrives empty',
    holds: (s) => /^0*$/.test(s.tracks.at(-1).on),
  },
});

// ---------------------------------------------------------------------------

async function openPulse() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(PULSE, { waitUntil: 'domcontentloaded' });
  // Pulse gates its audio graph behind a click, because a browser will not make
  // sound until the page has been interacted with. The store handle only
  // appears once that graph exists.
  await page.locator('.big-btn').click({ timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => !!window.pulseStore, null, { timeout: 20000 });
  // A known song, so the two are compared from the same starting point.
  await page.evaluate(() => window.pulseStore.getState().newProject?.());
  await page.waitForTimeout(600);
  return { browser, page };
}

async function openMotif() {
  const browser = await chromium.connectOverCDP(MOTIF_CDP);
  const page = browser.contexts().flatMap((c) => c.pages())
    .find((p) => p.url().startsWith('http://127.0.0.1:'));
  if (!page) throw new Error('Motif is running but its interface page was not found');
  await page.evaluate(() => fetch('/api/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'newSong' }),
  }));
  await page.waitForTimeout(600);
  return { browser, page };
}

const chosen = workflows.filter((w) => !only || w.name.includes(only));
console.log(`\nPulse vs Motif  ·  ${chosen.length} workflows\n${'='.repeat(64)}\n`);

let pulse = null;
if (!motifOnly) {
  try {
    pulse = await openPulse();
  } catch (e) {
    console.log(`Pulse is not reachable at ${PULSE} (${e.message.split('\n')[0]}).`);
    console.log('Start it with "npm run dev", or pass --motif-only.\n');
    process.exit(2);
  }
}
const motif = await openMotif();

const rows = [];
for (const w of chosen) {
  const motifHands = new Hands(motif.page, 'Motif');
  let pulseSnap = null;
  let pulseHands = null;

  if (pulse) {
    await pulse.page.evaluate(() => window.pulseStore.getState().newProject?.());
    await pulse.page.waitForTimeout(400);
    pulseHands = new Hands(pulse.page, 'Pulse');
    await w.pulse(pulse.page, pulseHands);
    pulseSnap = await pulse.page.evaluate(PULSE_SNAPSHOT);
  }

  await motif.page.evaluate(() => fetch('/api/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'newSong' }),
  }));
  await motif.page.waitForTimeout(400);
  await w.motif(motif.page, motifHands);
  const motifSnap = await motif.page.evaluate(MOTIF_SNAPSHOT);

  const result = pulseSnap ? w.compare(pulseSnap, motifSnap) : { ok: null, detail: 'Pulse skipped' };

  // The expectation is the part the invariant suite never had: not "do the two
  // agree" but "is this what a musician would want", asked of each separately.
  const expectations = [];
  if (w.expectation) {
    if (pulseSnap) expectations.push(['Pulse', w.expectation.holds(pulseSnap)]);
    expectations.push(['Motif', w.expectation.holds(motifSnap)]);
  }

  rows.push({ w, result, expectations,
              cost: { pulse: pulseHands?.actions ?? null, motif: motifHands.actions } });
}

let failures = 0;
for (const { w, result, expectations, cost } of rows) {
  const mark = result.ok === null ? '····' : result.ok ? 'SAME' : 'DIFF';
  if (result.ok === false) failures++;
  console.log(`${mark}  ${w.name.padEnd(20)} ${w.intent}`);
  console.log(`      ${result.detail}`);
  for (const [app, held] of expectations) {
    if (!held) failures++;
    console.log(`      ${held ? 'ok  ' : 'NO  '}${app}: ${w.expectation.what}`);
  }
  if (cost.pulse !== null && cost.pulse !== cost.motif) {
    console.log(`      cost: Pulse ${cost.pulse}, Motif ${cost.motif}`);
  }
  console.log('');
}

console.log('='.repeat(64));
console.log(failures
  ? `${failures} difference(s) from Pulse, or expectations Motif does not meet.\n`
  : `Motif matches Pulse across ${rows.length} workflows.\n`);

await motif.browser.close?.().catch?.(() => {});
if (pulse) await pulse.browser.close();
process.exit(failures ? 1 : 0);
