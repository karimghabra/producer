// Motif — interface.
//
// Holds no musical state of its own. The engine owns the song; this reads a
// snapshot and posts commands. That keeps one source of truth on the side that
// also owns the audio thread, so the UI can never disagree with what you hear.

const $ = (s) => document.querySelector(s);
const api = {
  async state() { return (await fetch('/api/state')).json(); },
  async presets() { return (await fetch('/api/presets')).json(); },
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
    view, selected, state.tracks.length,
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
