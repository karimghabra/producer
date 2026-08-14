// Motif — interface.
//
// Holds no musical state of its own. The engine owns the song; this reads a
// snapshot and posts commands. That keeps one source of truth on the side that
// also owns the audio thread, so the UI can never disagree with what you hear.

const $ = (s) => document.querySelector(s);
const api = {
  async state() { return (await fetch('/api/state')).json(); },
  async presets() { return (await fetch('/api/presets')).json(); },
  async take() { return (await fetch('/api/take')).json(); },
  send(type, extra = {}) {
    return fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, ...extra }),
    });
  },
};

let state = null;
let presets = { drums: [], synths: [] };
let view = 'steps';
let selected = 0;
const heldKeys = new Set();

// True while a control is being dragged.
//
// The poll rebuilds the view twenty times a second, which tears out the very
// element the pointer is captured on. A drag then lasts one frame: a 60px
// gesture registered as 4px before this existed. Structure holds still while
// you are touching it; the readouts keep updating regardless.
let interacting = false;

const hex = (n) => '#' + (n & 0xffffff).toString(16).padStart(6, '0');
const pct = (v) => Math.round(v * 100);

// --------------------------------------------------------------------------
// Knob — drawn on a canvas, because a styled range input always looks like a
// styled range input. 270 degrees of travel, the way a hardware pot reads.
// --------------------------------------------------------------------------

function knob(label, value, display, tint, onChange, bipolar = false) {
  const wrap = document.createElement('div');
  wrap.className = 'knob';
  const c = document.createElement('canvas');
  const size = 42, dpr = window.devicePixelRatio || 1;
  c.width = size * dpr; c.height = size * dpr;
  c.style.width = c.style.height = size + 'px';
  const g = c.getContext('2d');
  g.scale(dpr, dpr);

  const draw = (v) => {
    g.clearRect(0, 0, size, size);
    const cx = size / 2, cy = size / 2, r = size / 2 - 4;
    const start = Math.PI * 0.75, sweep = Math.PI * 1.5;
    g.lineCap = 'round';
    g.lineWidth = 3.2;
    g.strokeStyle = '#232c3f';
    g.beginPath(); g.arc(cx, cy, r, start, start + sweep); g.stroke();

    const from = bipolar ? 0.5 : 0;
    if (Math.abs(v - from) > 0.004) {
      g.strokeStyle = tint;
      g.beginPath();
      g.arc(cx, cy, r, start + sweep * Math.min(from, v), start + sweep * Math.max(from, v));
      g.stroke();
    }
    const a = start + sweep * v;
    g.strokeStyle = tint; g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * r * 0.32, cy + Math.sin(a) * r * 0.32);
    g.lineTo(cx + Math.cos(a) * r * 0.78, cy + Math.sin(a) * r * 0.78);
    g.stroke();
  };
  draw(value);

  const out = document.createElement('output');
  out.textContent = display;
  const lab = document.createElement('label');
  lab.textContent = label;
  wrap.append(c, lab, out);

  let dragging = false, startY = 0, startV = value;
  c.addEventListener('pointerdown', (e) => {
    dragging = true; interacting = true;
    startY = e.clientY; startV = value;
    c.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  c.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // Shift for fine. A knob needs both a coarse sweep and precision.
    const scale = e.shiftKey ? 600 : 170;
    value = Math.max(0, Math.min(1, startV + (startY - e.clientY) / scale));
    draw(value);
    out.textContent = display;
    onChange(value);
  });
  const end = () => { dragging = false; interacting = false; };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  // Double-click resets, the way a hardware default would.
  c.addEventListener('dblclick', () => {
    value = bipolar ? 0.5 : 0;
    draw(value);
    onChange(value);
  });
  return wrap;
}

// --------------------------------------------------------------------------
// Render
// --------------------------------------------------------------------------

function renderTracks() {
  const host = $('#tracks');
  host.innerHTML = '';
  $('#track-count').textContent = state.tracks.length;

  state.tracks.forEach((t, i) => {
    const el = document.createElement('div');
    el.className = 'track' + (i === selected ? ' sel' : '') + (t.mixer.mute ? ' muted' : '');
    el.style.setProperty('--c', hex(t.colour));

    const pat = t.patterns[t.activePattern];
    const lights = pat
      ? pat.steps.map((s, si) =>
          `<i class="${s.on ? 'on' : ''}${state.playing && si === t.step ? ' here' : ''}"></i>`).join('')
      : '';

    el.innerHTML =
      `<div><div class="nm">${t.name}</div>
       <div class="sub">${t.engine}${pat ? ' - ' + pat.name : ''}</div>
       <div class="lights">${lights}</div></div>
       <div class="badges">
         <button class="badge ${t.mixer.solo ? 'on-s' : ''}" data-solo="${i}">S</button>
         <button class="badge ${t.mixer.mute ? 'on-m' : ''}" data-mute="${i}">M</button>
       </div>`;

    el.addEventListener('click', (e) => {
      if (e.target.dataset.solo !== undefined) {
        api.send('solo', { track: i, value: t.mixer.solo ? 0 : 1 });
      } else if (e.target.dataset.mute !== undefined) {
        api.send('mute', { track: i, value: t.mixer.mute ? 0 : 1 });
      } else {
        selected = i;
        api.send('selectTrack', { track: i });
      }
    });
    host.append(el);
  });
}

function renderSteps() {
  const track = state.tracks[selected];
  if (!track) return;
  const pat = track.patterns[track.activePattern];
  const tint = hex(track.colour);

  const bar = $('#pattern-bar');
  bar.innerHTML = '';
  track.patterns.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'chip' + (i === track.activePattern ? ' on' : '');
    b.textContent = p.name;
    b.onclick = () => api.send('selectPattern', { track: selected, index: i });
    bar.append(b);
  });

  const host = $('#steps');
  host.style.gridTemplateColumns = `repeat(${Math.min(pat.length, 16)},1fr)`;
  host.innerHTML = '';
  pat.steps.forEach((s, i) => {
    const el = document.createElement('button');
    el.className = 'step'
      + (s.on ? ' on' : '')
      + (i % pat.resolution === 0 ? ' beat' : '')
      + (state.playing && i === track.step ? ' here' : '');
    el.style.setProperty('--c', tint);
    el.innerHTML = `<span class="n">${i + 1}</span>`
      + (s.on ? `<span class="vel" style="height:${pct(s.vel)}%"></span>` : '');
    el.onclick = () => api.send('toggleStep', { track: selected, step: i });
    host.append(el);
  });
}

// --------------------------------------------------------------------------
// Take panel
//
// The one place the app explains itself. It shows the grid it inferred, and
// draws every note twice: amber where your hands put it, mint where the fit
// put it, joined by the distance between them. If the fitting is wrong you can
// see that it is wrong, which is the difference between a tool you can trust
// and one that just moves your notes when you are not looking.
// --------------------------------------------------------------------------

let takeDetail = null;      // note-level data, fetched only when the fit changes
let takeRev = -1;

const SUBDIVISION_NAMES = {
  1: 'quarters', 2: 'eighths', 3: 'eighth triplets',
  4: 'sixteenths', 6: 'sixteenth triplets', 8: 'thirty-seconds',
};

async function syncTake() {
  const t = state && state.take;
  if (!t || !t.notes) { takeDetail = null; takeRev = -1; return; }
  if (t.rev === takeRev) return;
  takeRev = t.rev;
  takeDetail = await api.take();
  drawTake();
}

function renderTake() {
  const panel = $('#take');
  const t = (state && state.take) || { notes: 0 };
  panel.classList.toggle('has-take', t.notes > 0);
  if (!t.notes) { $('#take-stats').innerHTML = ''; return; }

  // Confidence is the resultant length of the onset phases: how tightly the
  // playing actually clustered on the grid. Below about a third it is barely a
  // grid at all, and saying so is more useful than hiding it.
  const conf = t.confidence || 0;
  const confClass = conf > 0.6 ? 'mint' : conf > 0.33 ? '' : 'warn';
  const stat = (label, value, cls = '') =>
    `<div><label>${label}</label><b class="${cls}">${value}</b></div>`;

  $('#take-stats').innerHTML =
      stat('HEARD', t.bpm.toFixed(1) + ' BPM', t.fellBack ? 'warn' : 'mint')
    + stat('GRID', SUBDIVISION_NAMES[t.subdivision] || t.subdivision + '/beat')
    + stat('LENGTH', t.bars + (t.bars === 1 ? ' bar' : ' bars'))
    + stat('SHUFFLE', t.swing < 0.04 ? 'straight' : pct(t.swing) + '%')
    + stat('CONFIDENCE', pct(conf) + '%', confClass)
    + stat('MOVED', t.movedMs.toFixed(0) + ' ms')
    + stat('NOTES', t.notes);

  const controls = $('#take-controls');
  if (controls.dataset.built !== '1') {
    controls.dataset.built = '1';
    controls.innerHTML =
      `<div class="slider"><label>FIT STRENGTH</label>
         <input type="range" id="fit-strength" min="0" max="100" step="1">
         <output id="fit-strength-out"></output></div>
       <button class="toggle" id="keep-swing"><i></i><label>KEEP SHUFFLE</label></button>`;

    const slider = $('#fit-strength');
    // Hold the structure still for the whole gesture, and refit continuously so
    // you hear the take slide between where you played it and where the grid
    // says it goes.
    slider.addEventListener('pointerdown', () => { interacting = true; });
    const release = () => { interacting = false; };
    slider.addEventListener('pointerup', release);
    slider.addEventListener('pointercancel', release);
    slider.addEventListener('blur', release);
    slider.addEventListener('input', () => {
      $('#fit-strength-out').textContent = slider.value + '%';
      api.send('fitStrength', { value: slider.value / 100 });
    });
    $('#keep-swing').onclick = () =>
      api.send('fitSwing', { value: state.take.keepSwing ? 0 : 1 });
  }

  if (!interacting) {
    $('#fit-strength').value = Math.round((t.strength ?? 1) * 100);
    $('#fit-strength-out').textContent = pct(t.strength ?? 1) + '%';
  }
  $('#keep-swing').classList.toggle('on', !!t.keepSwing);
}

function drawTake() {
  const c = $('#take-canvas');
  if (!takeDetail || !takeDetail.notes.length) return;
  const box = c.getBoundingClientRect();
  if (box.width < 10 || box.height < 10) return;

  const dpr = window.devicePixelRatio || 1;
  c.width = box.width * dpr; c.height = box.height * dpr;
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = box.width, H = box.height;
  g.clearRect(0, 0, W, H);

  const notes = takeDetail.notes;
  const loop = Math.max(takeDetail.loopBeats, 0.001);
  const pad = 16;
  const x = (beats) => pad + (beats / loop) * (W - pad * 2);

  // Grid lines at the inferred subdivision, so the fitted notes can be seen
  // sitting on something rather than floating.
  const t = state.take;
  const steps = Math.max(1, Math.round(loop * (t.subdivision || 4)));
  for (let i = 0; i <= steps; i++) {
    const onBeat = i % (t.subdivision || 4) === 0;
    const onBar = i % ((t.subdivision || 4) * (state.beatsPerBar || 4)) === 0;
    g.strokeStyle = onBar ? '#33405a' : onBeat ? '#222b3d' : '#171e2c';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(Math.round(x(i / (t.subdivision || 4))) + 0.5, 8);
    g.lineTo(Math.round(x(i / (t.subdivision || 4))) + 0.5, H - 8);
    g.stroke();
  }

  const lo = Math.min(...notes.map((n) => n.pitch));
  const hi = Math.max(...notes.map((n) => n.pitch));
  const span = Math.max(hi - lo, 6);
  const top = 18, bottom = H - 18;
  const y = (pitch) => bottom - ((pitch - lo) / span) * (bottom - top);

  for (const n of notes) {
    const px = x(((n.played % loop) + loop) % loop);
    const fx = x(n.fitted);
    const py = y(n.pitch);

    // The correction itself: how far this note travelled.
    if (Math.abs(fx - px) > 0.7) {
      g.strokeStyle = 'rgba(255,184,107,.32)';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(px, py); g.lineTo(fx, py); g.stroke();
    }

    g.fillStyle = 'rgba(255,184,107,.55)';       // played
    g.beginPath(); g.arc(px, py, 2.6, 0, Math.PI * 2); g.fill();

    g.fillStyle = '#5ee6c5';                      // fitted
    g.beginPath(); g.arc(fx, py, 3.4, 0, Math.PI * 2); g.fill();
  }

  g.font = '600 8.5px ui-monospace,Consolas,monospace';
  g.fillStyle = 'rgba(255,184,107,.7)';
  g.fillText('PLAYED', pad, 12);
  g.fillStyle = '#5ee6c5';
  g.fillText('FITTED', pad + 48, 12);
}

function renderMix() {
  const host = $('#mixer');
  host.innerHTML = '';
  state.tracks.forEach((t, i) => {
    const strip = document.createElement('div');
    strip.className = 'strip';
    strip.style.setProperty('--c', hex(t.colour));
    strip.innerHTML = `<h3>${t.name}</h3>`;
    const knobs = document.createElement('div');
    knobs.className = 'knobs';
    const c = hex(t.colour);
    knobs.append(
      knob('LEVEL', t.mixer.gain / 1.5, pct(t.mixer.gain / 1.5), c,
           (v) => api.send('gain', { track: i, value: v * 1.5 })),
      knob('PAN', (t.mixer.pan + 1) / 2,
           Math.abs(t.mixer.pan) < .02 ? 'C' : (t.mixer.pan < 0 ? 'L' : 'R') + pct(Math.abs(t.mixer.pan)),
           c, (v) => api.send('pan', { track: i, value: v * 2 - 1 }), true),
      knob('VERB', t.mixer.reverb, pct(t.mixer.reverb), '#ffb86b',
           (v) => api.send('send', { track: i, which: 'reverb', value: v })),
      knob('DELAY', t.mixer.delay, pct(t.mixer.delay), '#c77dff',
           (v) => api.send('send', { track: i, which: 'delay', value: v })),
      knob('DUCK', t.mixer.duck, pct(t.mixer.duck), '#ffd479',
           (v) => api.send('send', { track: i, which: 'duck', value: v })),
    );
    strip.append(knobs);
    host.append(strip);
  });
}

function renderSound() {
  const track = state.tracks[selected];
  if (!track) return;
  const list = track.isDrum ? presets.drums : presets.synths;
  const bar = $('#preset-bar');
  bar.innerHTML = '';
  list.forEach((p) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = p.name;
    b.title = p.blurb;
    b.onclick = () => api.send('preset', { track: selected, name: p.name });
    bar.append(b);
  });
}

const KEYS = [
  ['a', 0, 0], ['w', 1, 1], ['s', 2, 0], ['e', 3, 1], ['d', 4, 0], ['f', 5, 0],
  ['t', 6, 1], ['g', 7, 0], ['y', 8, 1], ['h', 9, 0], ['u', 10, 1], ['j', 11, 0],
  ['k', 12, 0], ['o', 13, 1], ['l', 14, 0],
];

function renderKeys() {
  const host = $('#keys');
  if (host.childElementCount) {
    [...host.children].forEach((el) => el.classList.toggle('down', heldKeys.has(el.dataset.k)));
    return;
  }
  KEYS.forEach(([k, semi, black]) => {
    const el = document.createElement('div');
    el.className = 'key' + (black ? ' black' : '');
    el.dataset.k = k;
    el.dataset.semi = semi;
    el.textContent = k.toUpperCase();
    host.append(el);
  });
}

/**
 * What the DOM would have to be rebuilt for.
 *
 * Anything not in here is a value, and values are written into existing
 * elements. Rebuilding wholesale twenty times a second replaced every node
 * mid-gesture, which broke drags, hover and focus, and made the interface
 * impossible to drive reliably from a script.
 */
function shapeKey() {
  return [
    view, selected, state.tracks.length, state.take?.rev ?? -1,
    state.tracks.map((t) => `${t.name}|${t.engine}|${t.activePattern}|${t.patterns.length}`).join(','),
    state.tracks[selected]?.patterns[state.tracks[selected].activePattern]?.length,
    state.tracks.map((t) => (t.mixer.mute ? 'm' : '') + (t.mixer.solo ? 's' : '')).join(''),
    state.tracks[selected]?.patterns[state.tracks[selected].activePattern]
      ?.steps.map((s) => (s.on ? 1 : 0)).join(''),
  ].join('#');
}

let lastShape = null;

/** Values only: playhead, meters, light states. No nodes created or removed. */
function refreshLive() {
  const rows = document.querySelectorAll('#tracks .track');
  state.tracks.forEach((t, i) => {
    const lights = rows[i]?.querySelectorAll('.lights i');
    if (!lights) return;
    lights.forEach((el, si) => el.classList.toggle('here', state.playing && si === t.step));
  });
  if (view === 'steps') {
    const track = state.tracks[selected];
    document.querySelectorAll('#steps .step').forEach((el, i) =>
      el.classList.toggle('here', state.playing && i === track.step));
  }
}

function render() {
  if (!state) return;
  const track = state.tracks[selected];
  if (track) document.documentElement.style.setProperty('--c', hex(track.colour));
  $('#keys').style.setProperty('--c', track ? hex(track.colour) : '#5ee6c5');

  $('#r-bpm').textContent = state.bpm.toFixed(1);
  $('#r-cycle').textContent = state.cycle + ' st';
  $('#r-peak').textContent = pct(state.peak) + '%';
  $('#play').classList.toggle('on', state.playing);
  $('#rec').classList.toggle('on', state.recording);
  $('#rec').textContent = state.recording ? 'FIT IT' : 'RECORD';

  // The stats are values, not structure, so they keep updating during a drag -
  // which is the whole point of the strength slider: you watch the correction
  // shrink as you pull it back.
  if (view === 'steps') renderTake();
  syncTake();

  // Never restructure under a finger that is mid-gesture.
  if (interacting) return;

  const shape = shapeKey();
  if (shape === lastShape) { refreshLive(); return; }
  lastShape = shape;

  renderTracks();
  if (view === 'steps') renderSteps();
  else if (view === 'mix') renderMix();
  else renderSound();
  renderKeys();
  refreshLive();
}

// --------------------------------------------------------------------------
// Input
// --------------------------------------------------------------------------

$('#play').onclick = () => api.send(state && state.playing ? 'stop' : 'play');
$('#rec').onclick = () => api.send('record');

document.querySelectorAll('#views .tab').forEach((tab) => {
  tab.onclick = () => {
    view = tab.dataset.view;
    document.querySelectorAll('#views .tab').forEach((t) => t.classList.toggle('on', t === tab));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + view));
    render();
    // The canvas had no size while its view was hidden, so anything drawn then
    // was drawn into nothing.
    if (view === 'steps') drawTake();
  };
});

addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); api.send(state && state.playing ? 'stop' : 'play'); return; }
  if (k === 'r') { api.send('record'); return; }
  const entry = KEYS.find((x) => x[0] === k);
  if (entry && !heldKeys.has(k)) {
    heldKeys.add(k);
    api.send('noteOn', { note: 48 + entry[1], velocity: 0.85 });
    renderKeys();
  }
});
addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  const entry = KEYS.find((x) => x[0] === k);
  if (entry && heldKeys.has(k)) {
    heldKeys.delete(k);
    api.send('noteOff', { note: 48 + entry[1] });
    renderKeys();
  }
});
// The take plot is drawn at device pixels for a specific size, so it has to be
// redrawn whenever that size changes - including when the window is resized.
addEventListener('resize', () => { if (view === 'steps') drawTake(); });

// A held note must end when focus goes, or it sustains forever.
addEventListener('blur', () => {
  heldKeys.forEach((k) => {
    const entry = KEYS.find((x) => x[0] === k);
    if (entry) api.send('noteOff', { note: 48 + entry[1] });
  });
  heldKeys.clear();
  renderKeys();
});

// --------------------------------------------------------------------------

async function poll() {
  try {
    state = await api.state();
    const armed = state.tracks.findIndex((t) => t.armed);
    if (armed >= 0) selected = armed;
    render();
    $('#link').textContent = 'engine connected';
  } catch (err) {
    $('#link').textContent = 'engine not reachable';
  }
}

(async () => {
  try { presets = await api.presets(); } catch (e) { /* engine still starting */ }
  await poll();
  // 20 Hz is enough for a playhead to look continuous and keeps the payload
  // cost invisible on loopback.
  setInterval(poll, 50);
})();
