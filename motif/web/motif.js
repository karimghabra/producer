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
let view = 'grid';
let selected = 0;
let selectedStep = 0;
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

// Track names are user-typed and go into innerHTML, so they get escaped. The
// only place in this interface where text from outside reaches the DOM.
const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Say what just happened, briefly.
 *
 * Copy, cut and paste change nothing you can see at the moment you do them,
 * and a shortcut that appears to do nothing is one you stop trusting.
 */
let flashTimer = null;
function flash(text) {
  const el = $('#flash');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('on'), 1400);
}

/** Matches the palette the engine hands to new tracks. */
const TRACK_COLOURS = ['#ff5c7a', '#ffb86b', '#5ee6c5', '#ffd479',
                       '#c77dff', '#6ba8ff', '#8fe36b', '#ff8fd4'];

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
      `<div><div class="nm" data-name="${i}" title="Double-click to rename">${esc(t.name)}</div>
       <div class="sub">${esc(t.engine)}${pat ? ' - ' + esc(pat.name) : ''}</div>
       <div class="lights">${lights}</div></div>
       <div class="badges">
         <button class="badge ${t.seqEnabled ? '' : 'off'}" data-seq="${i}"
                 title="${t.seqEnabled ? 'Sequencer on' : 'Sequencer off'}">&#9654;</button>
         <button class="badge ${t.mixer.solo ? 'on-s' : ''}" data-solo="${i}" title="Solo">S</button>
         <button class="badge ${t.mixer.mute ? 'on-m' : ''}" data-mute="${i}" title="Mute">M</button>
         <button class="badge more" data-more="${i}" title="Track options">&#8943;</button>
       </div>`;

    el.addEventListener('click', (e) => {
      const d = e.target.dataset;
      if (d.solo !== undefined)      api.send('solo', { track: i, value: t.mixer.solo ? 0 : 1 });
      else if (d.mute !== undefined) api.send('mute', { track: i, value: t.mixer.mute ? 0 : 1 });
      else if (d.seq !== undefined)  api.send('seqEnabled', { track: i, value: t.seqEnabled ? 0 : 1 });
      else if (d.more !== undefined) openTrackMenu(i, e.target);
      else { selected = i; api.send('selectTrack', { track: i }); }
    });

    // Rename in place. A dialog for one short string would be heavier than the
    // thing it edits.
    el.querySelector('[data-name]').addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const cell = e.target;
      cell.contentEditable = 'true';
      cell.classList.add('editing');
      interacting = true;
      cell.focus();
      getSelection().selectAllChildren(cell);

      const commit = (keep) => {
        cell.contentEditable = 'false';
        cell.classList.remove('editing');
        interacting = false;
        const name = cell.textContent.trim().slice(0, 24);
        if (keep && name && name !== t.name) api.send('renameTrack', { track: i, name });
        else cell.textContent = t.name;
      };
      cell.onblur = () => commit(true);
      cell.onkeydown = (ev) => {
        ev.stopPropagation();                       // or A-K would play notes
        if (ev.key === 'Enter') { ev.preventDefault(); cell.blur(); }
        if (ev.key === 'Escape') { commit(false); cell.blur(); }
      };
    });
    host.append(el);
  });
}

// --------------------------------------------------------------------------
// Projects
// --------------------------------------------------------------------------

/**
 * Save, open, delete, start new.
 *
 * Deliberately not a native file dialog: projects live in one folder, and
 * picking from a list of names you recognise beats navigating a filesystem to
 * find something the app put there in the first place.
 */
async function openProjectMenu(anchor) {
  closeMenu();
  const { current, names } = await (await fetch('/api/projects')).json();

  const menu = document.createElement('div');
  menu.className = 'menu wide';
  menu.id = 'track-menu';          // one menu at a time; shares the dismiss path
  menu.innerHTML =
    `<div class="menu-head">PROJECT</div>
     <div class="menu-row">
       <input id="proj-name" type="text" maxlength="64" placeholder="Name this project"
              spellcheck="false">
       <button class="menu-go" id="proj-save">SAVE</button>
     </div>`;

  const nameField = menu.querySelector('#proj-name');
  nameField.value = current || '';
  const save = () => {
    const name = nameField.value.trim();
    if (name) { api.send('save', { name }); closeMenu(); }
  };
  menu.querySelector('#proj-save').onclick = save;
  nameField.onkeydown = (e) => {
    e.stopPropagation();                     // A-K would otherwise play notes
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') closeMenu();
  };

  if (names.length) {
    const head = document.createElement('div');
    head.className = 'menu-head';
    head.textContent = 'OPEN';
    menu.append(head);
    for (const n of names) {
      const row = document.createElement('div');
      row.className = 'menu-file';
      const open = document.createElement('button');
      open.className = 'menu-item';
      open.textContent = n;
      open.onclick = () => { api.send('load', { name: n }); closeMenu(); };
      const del = document.createElement('button');
      del.className = 'menu-del';
      del.textContent = '×';
      del.title = `Delete "${n}"`;
      // Two presses. A single-click delete next to a single-click open is a
      // way to lose a project by aiming badly.
      del.onclick = () => {
        if (del.dataset.armed) { api.send('deleteProject', { name: n }); closeMenu(); return; }
        del.dataset.armed = '1';
        del.textContent = 'SURE?';
        del.classList.add('armed');
      };
      row.append(open, del);
      menu.append(row);
    }
  }

  const sep = document.createElement('div');
  sep.className = 'menu-head';
  sep.textContent = 'START OVER';
  const fresh = document.createElement('button');
  fresh.className = 'menu-item';
  fresh.textContent = 'New project';
  fresh.onclick = () => { api.send('newSong'); closeMenu(); };
  menu.append(sep, fresh);

  document.body.append(menu);
  const box = anchor.getBoundingClientRect();
  menu.style.left = Math.min(box.left, innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = box.bottom + 6 + 'px';
  nameField.focus();
  nameField.select();
  setTimeout(() => addEventListener('pointerdown', dismissMenu), 0);
}

/** Track options, anchored to the button that opened them. */
function openTrackMenu(index, anchor) {
  closeMenu();
  const t = state.tracks[index];
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.id = 'track-menu';

  const items = [
    ['Duplicate', () => api.send('duplicateTrack', { track: index })],
    ['Move up', () => api.send('moveTrack', { track: index, to: index - 1 }), index > 0],
    ['Move down', () => api.send('moveTrack', { track: index, to: index + 1 }),
     index < state.tracks.length - 1],
    ['Clear pattern', () => api.send('clearPattern', { track: index })],
    [state.sidechainSource === index ? 'Not the sidechain' : 'Sidechain source',
     () => api.send('sidechainSource', { track: state.sidechainSource === index ? -1 : index })],
    ['Delete', () => api.send('removeTrack', { track: index }), state.tracks.length > 1, 'danger'],
  ];

  for (const [label, action, enabled = true, cls = ''] of items) {
    const b = document.createElement('button');
    b.className = 'menu-item ' + cls;
    b.textContent = label;
    b.disabled = !enabled;
    b.onclick = () => { action(); closeMenu(); };
    menu.append(b);
  }

  const swatches = document.createElement('div');
  swatches.className = 'menu-colours';
  for (const c of TRACK_COLOURS) {
    const b = document.createElement('button');
    b.className = 'swatch' + (hex(t.colour) === c ? ' on' : '');
    b.style.background = c;
    b.onclick = () => { api.send('trackColour', { track: index, colour: parseInt(c.slice(1), 16) }); closeMenu(); };
    swatches.append(b);
  }
  menu.append(swatches);

  document.body.append(menu);
  const box = anchor.getBoundingClientRect();
  // Flip upward when there is not room below, so the last track's menu is not
  // half off the bottom of the window.
  const below = innerHeight - box.bottom;
  menu.style.left = Math.min(box.left, innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = (below > menu.offsetHeight + 8 ? box.bottom + 4
                                                  : box.top - menu.offsetHeight - 4) + 'px';
  setTimeout(() => addEventListener('pointerdown', dismissMenu), 0);
}

/**
 * Close on a press outside the menu.
 *
 * The check matters: a bare pointerdown listener tore the menu out from under
 * the press that was choosing an item, so the click never landed and none of
 * the options did anything.
 */
function dismissMenu(e) {
  if (!e.target.closest('#track-menu')) closeMenu();
}

function closeMenu() {
  removeEventListener('pointerdown', dismissMenu);
  document.getElementById('track-menu')?.remove();
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
    // Right-click removes it. A delete button on every chip would crowd out
    // the names, which are the thing you are actually reading.
    b.oncontextmenu = (e) => {
      e.preventDefault();
      if (track.patterns.length > 1) api.send('removePattern', { track: selected, index: i });
    };
    b.title = 'Right-click to delete';
    bar.append(b);
  });
  const add = document.createElement('button');
  add.className = 'chip ghost';
  add.textContent = '+';
  add.title = 'New empty pattern';
  add.onclick = () => api.send('addPattern', { track: selected });
  const dup = document.createElement('button');
  dup.className = 'chip ghost';
  dup.textContent = '⧉';
  dup.title = 'Duplicate this pattern';
  dup.onclick = () => api.send('duplicatePattern', { track: selected });
  bar.append(add, dup);

  renderPatternShape(track, pat);

  const host = $('#steps');
  host.style.gridTemplateColumns = `repeat(${Math.min(pat.length, 16)},1fr)`;
  host.innerHTML = '';
  pat.steps.forEach((s, i) => {
    const el = document.createElement('button');
    el.className = 'step'
      + (s.on ? ' on' : '')
      + (i % pat.resolution === 0 ? ' beat' : '')
      + (i === selectedStep ? ' sel' : '')
      + (state.playing && i === track.step ? ' here' : '');
    el.style.setProperty('--c', tint);

    // Marks for the things that are set but would otherwise be invisible.
    const marks = [
      s.ratchet > 1 ? `<span class="mk r">${s.ratchet}</span>` : '',
      Math.abs(s.nudge) > 0.001 ? `<span class="mk n${s.nudge < 0 ? ' early' : ''}">${
        s.nudge < 0 ? '&lsaquo;' : '&rsaquo;'}</span>` : '',
      s.cond ? `<span class="mk c">${condMark(s)}</span>` : '',
    ].join('');

    el.innerHTML = `<span class="n">${i + 1}</span>`
      + (s.on ? `<span class="vel" style="height:${pct(s.vel)}%"></span>` : '')
      + (s.on ? marks : '');
    // Click toggles and selects. Making the first click only select would mean
    // two clicks to turn a step on, which is not what a step grid does
    // anywhere else. The detail panel shows the step either way - an off step
    // still has properties worth setting before you switch it on.
    el.onclick = () => {
      api.send('toggleStep', { track: selected, step: i });
      selectedStep = i;
      lastShape = null;                        // the selection is part of it
      render();
    };
    host.append(el);
  });

  renderStepDetail(track, pat);
}

const COND_NAMES = ['Always', 'Chance', 'Every', 'Fill', 'Not fill', 'First', 'Not first'];
const condMark = (s) => (s.cond === 1 ? pct(s.chance ?? 1) + '%'
                       : s.cond === 2 ? `${s.hit ?? 1}:${s.of ?? 4}`
                       : COND_NAMES[s.cond]?.slice(0, 3) ?? '');

/** Pattern length, resolution and the euclidean generator. */
function renderPatternShape(track, pat) {
  const host = $('#pattern-shape');
  host.innerHTML = '';

  const num = (label, value, min, max, onChange, title) => {
    const w = document.createElement('div');
    w.className = 'stepper';
    w.title = title || '';
    w.innerHTML = `<label>${label}</label>`;
    const dec = document.createElement('button'); dec.textContent = '-';
    const out = document.createElement('span'); out.textContent = value;
    const inc = document.createElement('button'); inc.textContent = '+';
    dec.onclick = () => onChange(Math.max(min, value - 1));
    inc.onclick = () => onChange(Math.min(max, value + 1));
    w.append(dec, out, inc);
    return w;
  };

  host.append(
    num('STEPS', pat.length, 1, 64,
        (v) => api.send('patternLength', { track: selected, value: v }),
        'Pattern length. Give two tracks different lengths and they drift '
        + 'against each other, repeating only when the counts line up again.'),
    num('PER BEAT', pat.resolution, 1, 8,
        (v) => api.send('patternResolution', { track: selected, value: v }),
        'Steps per beat. 4 is sixteenths, 3 is triplets.'),
  );

  const euclid = document.createElement('button');
  euclid.className = 'chip small' + (pat.euclid ? ' on' : '');
  euclid.textContent = 'EUCLID';
  euclid.title = 'Spread a number of pulses as evenly as possible over the '
    + 'pattern. Where a great many traditional rhythms come from - and one '
    + 'number instead of sixteen decisions.';
  euclid.onclick = () => api.send('euclid', { track: selected, what: 'on', value: pat.euclid ? 0 : 1 });
  host.append(euclid);

  if (pat.euclid) {
    host.append(
      num('PULSES', pat.pulses, 0, pat.length,
          (v) => api.send('euclid', { track: selected, what: 'pulses', value: v }),
          'How many hits to spread across the pattern.'),
      num('ROTATE', pat.rotation, -32, 32,
          (v) => api.send('euclid', { track: selected, what: 'rotation', value: v }),
          'Turn the pattern around its circle. Same rhythm, different downbeat.'),
    );
    const bake = document.createElement('button');
    bake.className = 'chip small ghost';
    bake.textContent = 'BAKE';
    bake.title = 'Freeze this into ordinary steps so it can be edited by hand.';
    bake.onclick = () => api.send('euclid', { track: selected, what: 'bake', value: 1 });
    host.append(bake);
  }

  const clear = document.createElement('button');
  clear.className = 'chip small ghost';
  clear.textContent = 'CLEAR';
  clear.onclick = () => api.send('clearPattern', { track: selected });
  host.append(clear);
}

/** Everything a single step is, for the one that is selected. */
function renderStepDetail(track, pat) {
  const host = $('#step-detail');
  const i = Math.min(selectedStep, pat.length - 1);
  const s = pat.steps[i];
  if (!s) { host.innerHTML = ''; return; }

  host.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'sd-head';
  head.innerHTML = `<span class="sd-title">STEP ${i + 1}</span>`;
  const onoff = document.createElement('button');
  onoff.className = 'chip small' + (s.on ? ' on' : '');
  onoff.textContent = s.on ? 'ON' : 'OFF';
  onoff.onclick = () => api.send('toggleStep', { track: selected, step: i });
  head.append(onoff);
  if (pat.euclid) {
    const note = document.createElement('span');
    note.className = 'sd-note';
    note.textContent = 'Euclid is generating this pattern - BAKE it to edit steps by hand.';
    head.append(note);
  }
  host.append(head);

  const row = document.createElement('div');
  row.className = 'sd-row';
  const tint = hex(track.colour);
  const edit = (what, value) => api.send('stepEdit', { track: selected, step: i, what, value });

  const k = (label, norm, display, onChange, help, bipolar = false) => {
    const w = knob(label, norm, display, tint, onChange, bipolar);
    w.classList.add('param');
    w.title = `${label}\n\n${help}`;
    return w;
  };

  row.append(
    k('VELOCITY', s.vel, pct(s.vel) + '%', (v) => edit('vel', v),
      'How hard this step is struck. On pitched tracks it also opens the filter '
      + 'further, the way playing harder does.'),
    k('NUDGE', (s.nudge + 0.5), (s.nudge > 0 ? '+' : '') + Math.round(s.nudge * 100) + '%',
      (v) => edit('nudge', v - 0.5),
      'Move this step off the grid, up to half a step either way. A few percent '
      + 'late is what makes a part sit back in the groove rather than on top of it.',
      true),
    k('LENGTH', (s.len - 1) / 31, s.len + (s.len === 1 ? ' step' : ' steps'),
      (v) => edit('len', Math.round(1 + v * 31)),
      'How long the note is held, in steps. Only matters on pitched tracks.'),
  );

  // Pitch, on tracks that have one. Degrees rather than semitones: the step
  // stores where it sits in the key, so a part transposes with the song
  // instead of going out of key when the key changes.
  if (!track.isDrum) {
    const pitch = document.createElement('div');
    pitch.className = 'sd-group';
    pitch.title = 'NOTE\n\nWhich degree of the scale this step plays. 1 is the '
      + 'tonic. Because it is stored as a degree rather than a fixed note, the '
      + 'part follows the song when you change key.';
    const degrees = state.key.degrees;
    pitch.innerHTML = `<label>NOTE &mdash; ${noteName(stepNote(s))}</label>`;
    const pr = document.createElement('div');
    pr.className = 'choice-row';
    for (let d = 0; d < degrees; d++) {
      const b = document.createElement('button');
      b.className = 'chip tiny' + (((s.deg % degrees) + degrees) % degrees === d ? ' on' : '');
      b.textContent = noteName(stepNote({ ...s, deg: d, oct: 0 })).replace(/-?\d+$/, '');
      b.onclick = () => edit('deg', d + Math.floor(s.deg / degrees) * degrees);
      pr.append(b);
    }
    pitch.append(pr);

    const octRow = document.createElement('div');
    octRow.className = 'choice-row';
    const octLabel = document.createElement('span');
    octLabel.className = 'sd-inline';
    octLabel.textContent = 'OCTAVE';
    octRow.append(octLabel);
    for (let o = -2; o <= 2; o++) {
      const b = document.createElement('button');
      b.className = 'chip tiny' + (s.oct === o ? ' on' : '');
      b.textContent = o > 0 ? '+' + o : String(o);
      b.onclick = () => edit('oct', o);
      octRow.append(b);
    }
    pitch.append(octRow);
    host.append(pitch);
  }

  // Ratchet and degree are small integers, so buttons rather than knobs: you
  // pick 3 rather than hunt for it.
  const ratchet = document.createElement('div');
  ratchet.className = 'sd-group';
  ratchet.title = 'RATCHET\n\nRetrigger this step several times inside its own '
    + 'slot. Two is a flam, four is a roll, and it is how a fill gets made '
    + 'without adding steps.';
  ratchet.innerHTML = '<label>RATCHET</label>';
  const rr = document.createElement('div');
  rr.className = 'choice-row';
  for (let n = 1; n <= 8; n++) {
    const b = document.createElement('button');
    b.className = 'chip tiny' + (s.ratchet === n ? ' on' : '');
    b.textContent = n;
    b.onclick = () => edit('ratchet', n);
    rr.append(b);
  }
  ratchet.append(rr);

  const cond = document.createElement('div');
  cond.className = 'sd-group';
  cond.title = 'CONDITION\n\nWhen this step is allowed to fire. "Every 1:4" plays '
    + 'on one pass in four, which is how a single pattern turns into an '
    + 'arrangement without a timeline.';
  cond.innerHTML = '<label>PLAYS</label>';
  const cr = document.createElement('div');
  cr.className = 'choice-row';
  COND_NAMES.forEach((name, n) => {
    const b = document.createElement('button');
    b.className = 'chip tiny' + (s.cond === n ? ' on' : '');
    b.textContent = name;
    b.onclick = () => edit('condType', n);
    cr.append(b);
  });
  cond.append(cr);

  if (s.cond === 1) {
    const chance = document.createElement('div');
    chance.className = 'choice-row';
    [0.1, 0.25, 0.5, 0.75, 0.9].forEach((c) => {
      const b = document.createElement('button');
      b.className = 'chip tiny' + (Math.abs((s.chance ?? 1) - c) < 0.01 ? ' on' : '');
      b.textContent = pct(c) + '%';
      b.onclick = () => edit('chance', c);
      chance.append(b);
    });
    cond.append(chance);
  }
  if (s.cond === 2) {
    const ratio = document.createElement('div');
    ratio.className = 'choice-row';
    [[1, 2], [2, 2], [1, 3], [1, 4], [2, 4], [3, 4], [1, 8]].forEach(([hit, of]) => {
      const b = document.createElement('button');
      b.className = 'chip tiny' + ((s.hit ?? 1) === hit && (s.of ?? 4) === of ? ' on' : '');
      b.textContent = `${hit}:${of}`;
      b.onclick = async () => { await edit('hit', hit); await edit('of', of); };
      ratio.append(b);
    });
    cond.append(ratio);
  }

  host.append(row, ratchet, cond);
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

// --------------------------------------------------------------------------
// Grid — every track at once
//
// The view you build a beat in. Each track keeps its own pattern length, and
// all of them are drawn against a common step width, so a sixteen and a twelve
// visibly pull apart instead of both being stretched to look the same. The
// faded cells past a pattern's end are that pattern repeating: where the drift
// actually shows.
// --------------------------------------------------------------------------

// Steps per beat, as the note value it actually is. Triplet rates divide the
// beat into three, which is why they are odd numbers here.
const RATE_LABEL = { 1: '1/4', 2: '1/8', 3: '1/8T', 4: '1/16', 6: '1/16T', 8: '1/32' };
const RATES = [1, 2, 3, 4, 6, 8];

function openRateMenu(trackIndex, anchor) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.id = 'track-menu';
  menu.innerHTML = '<div class="menu-head">STEP RATE</div>';
  const row = document.createElement('div');
  row.className = 'choice-row pad';
  const pat = state.tracks[trackIndex].patterns[state.tracks[trackIndex].activePattern];
  for (const r of RATES) {
    const b = document.createElement('button');
    b.className = 'chip small' + (pat.resolution === r ? ' on' : '');
    b.textContent = RATE_LABEL[r];
    b.onclick = () => { api.send('patternResolution', { track: trackIndex, value: r }); closeMenu(); };
    row.append(b);
  }
  menu.append(row);
  const note = document.createElement('div');
  note.className = 'menu-foot';
  note.textContent = 'Each track keeps its own rate. Mixing them is how a part '
    + 'sits in half time or doubles up under everything else.';
  menu.append(note);

  document.body.append(menu);
  const box = anchor.getBoundingClientRect();
  menu.style.left = Math.min(box.left, innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = (innerHeight - box.bottom > menu.offsetHeight + 8
    ? box.bottom + 4 : box.top - menu.offsetHeight - 4) + 'px';
  setTimeout(() => addEventListener('pointerdown', dismissMenu), 0);
}

// --------------------------------------------------------------------------
// Selection
//
// A set of cells, held as "track:step". Editing one step at a time is fine for
// fixing a hi-hat and hopeless for moving a whole phrase, so everything that
// operates on a selection sends one command for the lot: sixty round trips to
// transpose a bar would be slow, would land out of order, and would leave the
// pattern half-changed if any of them went missing.
// --------------------------------------------------------------------------

let selection = new Set();
let selectAnchor = null;        // where a shift-range measures from
let clipboard = [];             // copied steps, as offsets from their top-left

const cellKey = (track, step) => `${track}:${step}`;
const cellList = () => [...selection].join(',');
const isSelected = (track, step) => selection.has(cellKey(track, step));

function clearSelection() {
  if (!selection.size) return;
  selection.clear();
  lastShape = null;
  render();
}

/**
 * Every cell in the rectangle between two corners.
 *
 * Measured in beats rather than in step numbers. Tracks run at different
 * rates, so step 4 is a different moment on each of them - selecting by index
 * would take half a beat of a 1/32 track and a whole beat of a 1/16 one from
 * the same drag.
 */
function selectBox(a, b) {
  const t0 = Math.min(a.track, b.track), t1 = Math.max(a.track, b.track);
  const beatA = cellBeat(state.tracks[a.track], a.step);
  const beatB = cellBeat(state.tracks[b.track], b.step);
  const from = Math.min(beatA, beatB);
  // The far corner's cell is included whole, not clipped at its leading edge.
  const width = 1 / Math.max(1, patternOf(state.tracks[b.track])?.resolution ?? 4);
  const to = Math.max(beatA, beatB) + width;

  const next = new Set();
  for (let t = t0; t <= t1; t++) {
    const track = state.tracks[t];
    const pat = patternOf(track);
    if (!pat) continue;
    const step = 1 / Math.max(1, pat.resolution);
    for (let s = 0; s < pat.length; s++) {
      const start = s * step;
      // Overlap, not containment: a long step that straddles the edge of the
      // box is part of what was dragged over.
      if (start + step > from + 1e-9 && start < to - 1e-9) next.add(cellKey(t, s));
    }
  }
  return next;
}

/** The selection's top-left, which is what a paste is measured against. */
function selectionOrigin() {
  let track = Infinity, step = Infinity;
  for (const key of selection) {
    const [t, s] = key.split(':').map(Number);
    track = Math.min(track, t);
    step = Math.min(step, s);
  }
  return Number.isFinite(track) ? { track, step } : null;
}

function copySelection() {
  const origin = selectionOrigin();
  if (!origin) return 0;
  clipboard = [];
  for (const key of selection) {
    const [t, s] = key.split(':').map(Number);
    const pat = state.tracks[t]?.patterns[state.tracks[t].activePattern];
    const step = pat?.steps[s];
    // Only what is on: copying silence would paste holes over whatever is
    // already there, which is not what copying a phrase means.
    if (!step?.on) continue;
    clipboard.push({
      dt: t - origin.track, ds: s - origin.step,
      vel: Math.round(step.vel * 100), deg: step.deg, oct: step.oct,
      len: step.len, ratchet: step.ratchet,
    });
  }
  return clipboard.length;
}

function pasteAt(track, step) {
  if (!clipboard.length) return;
  const data = clipboard
    .map((c) => [c.dt, c.ds, c.vel, c.deg, c.oct, c.len, c.ratchet].join(':'))
    .join(';');
  api.send('pasteCells', { track, step, data });
}

/** Everything a selection can be told to do. */
const selectionOps = {
  clear: () => api.send('cells', { op: 'off', cells: cellList() }),
  fill: () => api.send('cells', { op: 'on', cells: cellList() }),
  toggle: () => api.send('cells', { op: 'toggle', cells: cellList() }),
  accent: () => api.send('cells', { op: 'accent', cells: cellList() }),
  nudge: (what, value) => api.send('cells', { op: what, value, cells: cellList() }),
};

// --------------------------------------------------------------------------
// The grid is laid out in time, not in step count
//
// A track at 1/32 has steps half the length of a track at 1/16. Giving every
// track the same number of equally wide cells lines them up by index, which
// puts a 1/32 track's fourth step underneath a 1/16 track's fourth step - two
// places that are half a beat apart. The rate control then appeared to do
// nothing but add cells.
//
// So: every row spans the same number of beats, and a row's cells are as wide
// as the steps they represent. A 1/32 track shows twice as many, half as wide,
// and every column line is a real moment in time across all of them.
// --------------------------------------------------------------------------

const patternOf = (t) => t.patterns[t.activePattern];
/** A pattern's length in beats, which is what has to be shared. */
const beatsOf = (t) => {
  const p = patternOf(t);
  return p ? p.length / Math.max(1, p.resolution) : 4;
};

/** The window every row is drawn across, in beats. */
function gridSpanBeats() {
  const longest = Math.max(...state.tracks.map(beatsOf), 1);
  // Rounded up to a whole beat so the ruler lands on beats, and capped so a
  // very long pattern does not squeeze everything else into nothing.
  return Math.min(Math.ceil(longest - 1e-9), 32);
}

/** How many cells a track needs to cover the window at its own rate. */
const cellsFor = (t, spanBeats) =>
  Math.max(1, Math.round(spanBeats * Math.max(1, patternOf(t)?.resolution ?? 4)));

/** Where a cell sits in time, in beats. */
const cellBeat = (t, step) => step / Math.max(1, patternOf(t)?.resolution ?? 4);

/**
 * A step's pitch, as a MIDI note. Mirrors degreeToMidi in Theory.h.
 *
 * Steps store a scale degree rather than a semitone, so a part follows the key
 * when the key changes. That is also why this is a function of the song and
 * not of the step alone.
 */
function stepNote(s) {
  const steps = SCALE_STEPS[state.key.scaleIndex] ?? SCALE_STEPS[0];
  const n = steps.length;
  const wrapped = ((s.deg % n) + n) % n;
  const shift = Math.floor(s.deg / n);
  return 12 * (5 + s.oct + shift) + state.key.root + steps[wrapped];
}

const noteName = (midi) => NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);

/**
 * Where a step sits within the pattern's own pitch range, 0 at the bottom.
 *
 * Scaled to what the part actually uses rather than to all 128 notes: a
 * bassline moving over a fifth should look like it moves, not like a flat line
 * near the bottom of the piano.
 */
function pitchSpan(pat) {
  const notes = pat.steps.slice(0, pat.length).filter((s) => s.on).map(stepNote);
  if (!notes.length) return null;
  const lo = Math.min(...notes), hi = Math.max(...notes);
  return { lo, hi, range: Math.max(hi - lo, 4) };
}

function renderGrid() {
  const spanBeats = gridSpanBeats();
  const beatsPerBar = state.beatsPerBar || 4;

  // The ruler is in beats, and belongs to no track in particular. Reading it
  // off the armed track's resolution made it wrong for every other track.
  const ruler = $('#grid-ruler');
  ruler.innerHTML = '<div class="gr-head"></div>';
  const marks = document.createElement('div');
  marks.className = 'gr-marks';
  marks.style.gridTemplateColumns = `repeat(${spanBeats},1fr)`;
  for (let b = 0; b < spanBeats; b++) {
    const m = document.createElement('span');
    const bar = Math.floor(b / beatsPerBar) + 1;
    const beat = (b % beatsPerBar) + 1;
    m.className = beat === 1 ? 'bar' : 'beat';
    m.textContent = beat === 1 ? String(bar) : String(beat);
    marks.append(m);
  }
  ruler.append(marks);

  const host = $('#grid-rows');
  host.innerHTML = '';
  attachBoxSelect(host);

  state.tracks.forEach((t, ti) => {
    const pat = t.patterns[t.activePattern];
    if (!pat) return;
    const tint = hex(t.colour);

    const row = document.createElement('div');
    row.className = 'grow' + (ti === selected ? ' sel' : '') + (t.mixer.mute ? ' muted' : '');
    row.style.setProperty('--c', tint);

    const head = document.createElement('div');
    head.className = 'grow-head';
    head.innerHTML =
      `<div class="gh-name">${esc(t.name)}</div>
       <div class="gh-sub">${esc(pat.name)} &middot; ${pat.length}</div>`;

    // Rate, as a note value rather than a step count. "1/16" is the thing you
    // mean; "4 steps per beat" is how it happens to be stored.
    const rate = document.createElement('button');
    rate.className = 'gh-rate';
    rate.textContent = RATE_LABEL[pat.resolution] || `${pat.resolution}/beat`;
    rate.title = 'How fast this track\'s steps run. Each track has its own, so '
      + 'a hat can run at 1/32 under a bass at 1/8.';
    rate.onclick = (e) => { e.stopPropagation(); openRateMenu(ti, e.currentTarget); };
    head.append(rate);

    // Level, so balancing is by eye as well as by ear.
    const meter = document.createElement('div');
    meter.className = 'gh-meter';
    meter.innerHTML = '<i></i>';
    head.append(meter);

    const badges = document.createElement('div');
    badges.className = 'gh-badges';
    for (const [key, cls, on] of [['solo', 'on-s', t.mixer.solo], ['mute', 'on-m', t.mixer.mute]]) {
      const b = document.createElement('button');
      b.className = 'badge ' + (on ? cls : '');
      b.textContent = key[0].toUpperCase();
      b.onclick = (e) => { e.stopPropagation(); api.send(key, { track: ti, value: on ? 0 : 1 }); };
      badges.append(b);
    }
    head.append(badges);
    // Clicking the name arms the track, so the keyboard and the detail view
    // follow what you are looking at.
    head.onclick = () => { selected = ti; api.send('selectTrack', { track: ti }); };
    row.append(head);

    // This row's own cell count: enough of its own steps to fill the shared
    // window. Equal total width, different numbers of cells, so a column line
    // is the same moment on every track.
    const cols = cellsFor(t, spanBeats);
    const res = Math.max(1, pat.resolution);

    const cells = document.createElement('div');
    cells.className = 'grow-cells';
    cells.style.gridTemplateColumns = `repeat(${cols},1fr)`;

    const pitched = !t.isDrum;
    const span = pitched ? pitchSpan(pat) : null;

    for (let i = 0; i < cols; i++) {
      const step = i % pat.length;
      const repeat = i >= pat.length;
      const s = pat.steps[step];
      const el = document.createElement('button');
      el.className = 'gcell'
        + (s?.on ? ' on' : '')
        + (repeat ? ' ghost' : '')
        // Marked against the beat, which is the same everywhere, rather than
        // against a step count that means something different per track.
        + (i % res === 0 ? ' beat' : '')
        + (i % (res * beatsPerBar) === 0 ? ' bar' : '')
        + (step === 0 && repeat ? ' wrap' : '')
        + (pitched ? ' pitched' : '')
        + (state.playing && step === t.step ? ' here' : '');
      if (s?.on) el.style.setProperty('--v', 0.35 + 0.65 * s.vel);

      if (s?.on && pitched) {
        // The note, and where it sits in the line. The bar is the melodic
        // contour: you read the shape of a part across the row without having
        // to decode note names one at a time.
        const midi = stepNote(s);
        const h = span ? (midi - span.lo) / span.range : 0.5;
        // Travel starts above the label rather than at the floor of the cell,
        // or the lowest note in a part draws its bar straight through its own
        // name.
        el.innerHTML = `<span class="pitchbar" style="bottom:${26 + h * 58}%"></span>`
                     + `<span class="note">${noteName(midi)}</span>`;
      }

      el.dataset.t = String(ti);
      el.dataset.s = String(step);
      if (isSelected(ti, step)) el.classList.add('picked');

      el.title = pitched && s?.on
        ? `${t.name} - step ${step + 1}, ${noteName(stepNote(s))}`
          + '\nDrag up or down to change the note'
          + '\nShift-drag across the grid to select'
        : `${t.name} - step ${step + 1}\nShift-drag across the grid to select`;

      if (pitched) attachPitchDrag(el, ti, step, s);
      el.onclick = (e) => {
        if (el.dataset.dragged) { delete el.dataset.dragged; return; }

        // Ctrl adds or removes one cell; shift takes everything between here
        // and where the selection started. Neither of them edits the step -
        // choosing what to work on and changing it are separate acts.
        if (e.ctrlKey || e.metaKey) {
          const key = cellKey(ti, step);
          if (selection.has(key)) selection.delete(key);
          else { selection.add(key); selectAnchor = { track: ti, step }; }
          lastShape = null; render();
          return;
        }
        if (e.shiftKey) {
          selection = selectBox(selectAnchor ?? { track: ti, step }, { track: ti, step });
          lastShape = null; render();
          return;
        }

        selection.clear();
        selectAnchor = { track: ti, step };
        api.send('toggleStep', { track: ti, step });
        // Editing a track is a statement about which one you are working on.
        if (ti !== selected) { selected = ti; api.send('selectTrack', { track: ti }); }
        selectedStep = step;
        lastShape = null;
        render();
      };
      cells.append(el);
    }
    row.append(cells);
    host.append(row);
  });

  renderSelectionBar();
}

/**
 * What you can do to a selection, spelled out.
 *
 * The shortcuts are the fast way, but a feature reachable only by a key
 * combination you have to already know is a feature most people never find.
 */
function renderSelectionBar() {
  const host = $('#grid-tools');
  const n = selection.size;
  host.classList.toggle('on', n > 0);
  if (!n) {
    host.innerHTML = '<span class="tools-hint">Shift-drag to select &nbsp;·&nbsp; '
      + 'Ctrl-click to add one &nbsp;·&nbsp; Ctrl-A for everything</span>';
    return;
  }

  const lit = [...selection].filter((key) => {
    const [t, s] = key.split(':').map(Number);
    const pat = state.tracks[t]?.patterns[state.tracks[t].activePattern];
    return pat?.steps[s]?.on;
  }).length;

  host.innerHTML = `<span class="tools-count">${n} selected<b>${lit} playing</b></span>`;
  const button = (label, title, fn, cls = '') => {
    const b = document.createElement('button');
    b.className = 'chip tiny ' + cls;
    b.textContent = label;
    b.title = title;
    b.onclick = fn;
    host.append(b);
  };

  button('Fill', 'Turn every selected step on', selectionOps.fill);
  button('Clear', 'Turn every selected step off  ·  Delete', selectionOps.clear);
  button('Copy', 'Copy the playing steps  ·  Ctrl+C',
         () => flash(`${copySelection()} steps copied`));
  button('Paste', 'Paste at the top left of the selection  ·  Ctrl+V', () => {
    const at = selectionOrigin();
    if (at) { pasteAt(at.track, at.step); flash(`pasted ${clipboard.length} steps`); }
  });
  button('Double', 'Copy this and place it immediately after  ·  Ctrl+D', () => {
    const origin = selectionOrigin();
    if (!origin) return;
    const width = Math.max(...[...selection].map((c) => Number(c.split(':')[1]))) - origin.step + 1;
    copySelection();
    pasteAt(origin.track, origin.step + width);
    flash(`duplicated ${clipboard.length} steps`);
  });
  button('♯', 'Up a scale degree  ·  Up arrow', () => selectionOps.nudge('deg', 1));
  button('♭', 'Down a scale degree  ·  Down arrow', () => selectionOps.nudge('deg', -1));
  button('Vel +', 'Louder  ·  Ctrl+Up', () => selectionOps.nudge('vel', 1));
  button('Vel −', 'Quieter  ·  Ctrl+Down', () => selectionOps.nudge('vel', -1));
  button('Done', 'Drop the selection  ·  Escape', clearSelection, 'ghost');
}

/**
 * Shift-drag a box across the grid to select what is inside it.
 *
 * Shift rather than a plain drag, because a plain vertical drag on a pitched
 * step already means "retune this note" - and a gesture that means two things
 * depending on where it started is a gesture you have to think about.
 *
 * Cells are found by hit testing rather than by arithmetic, so the selection
 * follows whatever the grid actually looks like: different pattern lengths,
 * repeats, tracks of different rates.
 */
function attachBoxSelect(host) {
  if (host.dataset.boxed === '1') return;
  host.dataset.boxed = '1';

  const cellAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const cell = el?.closest?.('.gcell');
    if (!cell || cell.dataset.t === undefined) return null;
    return { track: Number(cell.dataset.t), step: Number(cell.dataset.s) };
  };

  host.addEventListener('pointerdown', (e) => {
    if (!e.shiftKey || e.button !== 0) return;
    const from = cellAt(e.clientX, e.clientY);
    if (!from) return;
    e.preventDefault();
    interacting = true;
    selectAnchor = from;

    const box = document.createElement('div');
    box.className = 'select-box';
    document.body.append(box);
    const x0 = e.clientX, y0 = e.clientY;

    const move = (ev) => {
      box.style.left = Math.min(x0, ev.clientX) + 'px';
      box.style.top = Math.min(y0, ev.clientY) + 'px';
      box.style.width = Math.abs(ev.clientX - x0) + 'px';
      box.style.height = Math.abs(ev.clientY - y0) + 'px';
      const to = cellAt(ev.clientX, ev.clientY);
      if (!to) return;
      selection = selectBox(from, to);
      // Painted directly rather than through a rebuild: the grid must not be
      // torn down while a pointer is captured over it.
      document.querySelectorAll('#grid-rows .gcell').forEach((c) =>
        c.classList.toggle('picked', isSelected(Number(c.dataset.t), Number(c.dataset.s))));
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      box.remove();
      interacting = false;
      lastShape = null;
      render();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
}

/**
 * Drag a step up or down to change its note, without leaving the grid.
 *
 * Degrees rather than semitones, so dragging moves through the key: every
 * position you can drag to is in the scale. One row of travel per degree,
 * which is close enough to a piano roll that the gesture reads the same way
 * while the other tracks stay on screen.
 */
function attachPitchDrag(el, trackIndex, step, s) {
  el.addEventListener('pointerdown', (e) => {
    if (!s?.on || e.button !== 0) return;
    const startY = e.clientY;
    const startDeg = s.deg;
    let moved = false;
    el.setPointerCapture(e.pointerId);
    interacting = true;

    const move = (ev) => {
      const delta = Math.round((startY - ev.clientY) / 14);
      if (!moved && Math.abs(startY - ev.clientY) < 5) return;
      moved = true;
      const want = startDeg + delta;
      if (want === s.deg) return;
      s.deg = want;                        // optimistic, so the label tracks
      const midi = stepNote(s);
      el.querySelector('.note').textContent = noteName(midi);
      api.send('stepEdit', { track: trackIndex, step, what: 'deg', value: want });
    };
    const up = () => {
      el.releasePointerCapture(e.pointerId);
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      interacting = false;
      // Tell the click handler this was a drag, or letting go would also
      // toggle the step you just finished tuning.
      if (moved) { el.dataset.dragged = '1'; lastShape = null; }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
}

// --------------------------------------------------------------------------
// Song — scenes, sections, and what moves across them
//
// A scene is a loop you liked: which pattern each track was playing when you
// kept it. A section is that scene held for a number of bars. Lanes are drawn
// per section, because "the filter opens over these two bars" is a statement
// about a place in the song rather than a property of the instrument.
// --------------------------------------------------------------------------

let autoTargets = [];
let selectedSection = 0;

async function loadAutoTargets() {
  if (autoTargets.length) return;
  autoTargets = await (await fetch('/api/automation')).json();
}

const targetById = (id) => autoTargets.find((t) => t.id === id);

function laneLabel(lane) {
  const t = targetById(lane.param);
  if (!t) return lane.param;
  if (t.master) return t.label;
  const names = lane.tracks.map((i) => state.tracks[i]?.name).filter(Boolean);
  if (!names.length) return `${t.label} — no tracks`;
  if (names.length > 2) return `${t.label} — ${names.length} tracks`;
  return `${t.label} — ${names.join(' + ')}`;
}

function laneTint(lane) {
  const t = targetById(lane.param);
  if (t?.master) return '#ffd479';
  // The first track's colour when it drives one; a neutral tint when several,
  // because borrowing one track's colour for a curve driving four is a lie.
  if (lane.tracks.length === 1) return hex(state.tracks[lane.tracks[0]]?.colour ?? 0x5ee6c5);
  return '#5ee6c5';
}

function renderSong() {
  loadAutoTargets();
  renderSceneBar();
  renderArrangement();
  renderSectionDetail();
}

/** The loops you have kept, and the button that keeps another. */
function renderSceneBar() {
  const host = $('#scene-bar');
  host.innerHTML = '';

  const label = document.createElement('span');
  label.className = 'bar-label';
  label.textContent = 'SCENES';
  host.append(label);

  state.scenes.forEach((sc, i) => {
    const b = document.createElement('button');
    b.className = 'chip';
    const playing = sc.patterns.filter((p) => p >= 0).length;
    b.innerHTML = `${esc(sc.name)} <span class="chip-sub">${playing}</span>`;
    b.title = 'Load this scene onto the tracks so you can edit it.\n'
      + 'Double-click to rename, right-click for more.\n\n'
      + state.tracks.map((t, ti) => `${t.name}: ${sc.patterns[ti] >= 0
          ? (t.patterns[sc.patterns[ti]]?.name ?? '?') : 'silent'}`).join('\n');
    b.onclick = () => api.send('recallScene', { scene: i });
    b.ondblclick = (e) => { e.preventDefault(); renameScene(i, b); };
    b.oncontextmenu = (e) => { e.preventDefault(); openSceneMenu(i, b); };
    host.append(b);
  });

  const keep = document.createElement('button');
  keep.className = 'chip ghost';
  keep.textContent = state.scenes.length ? '+ KEEP THIS LOOP' : '+ KEEP THIS LOOP AS A SCENE';
  keep.title = 'Save what is playing right now as a scene: which pattern each '
    + 'track is on, and which tracks are silent. Get the loop right first, then keep it.';
  keep.onclick = () => api.send('addScene');
  host.append(keep);

  if (state.scenes.length) {
    const mode = document.createElement('button');
    mode.className = 'chip' + (state.songMode ? ' on' : '');
    mode.textContent = state.songMode ? 'SONG MODE' : 'LOOP MODE';
    mode.title = state.songMode
      ? 'Playing the arrangement. Click to go back to looping one scene.'
      : 'Looping whatever is armed. Click to play the arrangement instead.';
    mode.onclick = () => api.send('songMode', { value: state.songMode ? 0 : 1 });
    host.append(mode);
  }
}

/** Rename a scene where it sits, the same as a track. */
function renameScene(index, chip) {
  const current = state.scenes[index].name;
  const editor = document.createElement('input');
  editor.type = 'text';
  editor.className = 'scene-rename';
  editor.value = current;
  editor.maxLength = 24;
  chip.replaceWith(editor);
  interacting = true;
  editor.focus();
  editor.select();

  const done = (keep) => {
    interacting = false;
    const name = editor.value.trim();
    if (keep && name && name !== current) api.send('renameScene', { scene: index, name });
    lastShape = null;
    render();
  };
  editor.onblur = () => done(true);
  editor.onkeydown = (e) => {
    e.stopPropagation();                        // or A-K would play notes
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  };
}

/** Update, rename, delete. */
function openSceneMenu(index, anchor) {
  closeMenu();
  const usedBy = state.arrangement.filter((s) => s.scene === index).length;
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.id = 'track-menu';

  const item = (label, title, fn, cls = '') => {
    const b = document.createElement('button');
    b.className = 'menu-item ' + cls;
    b.textContent = label;
    b.title = title;
    b.onclick = () => { fn(); closeMenu(); };
    menu.append(b);
  };

  item('Update from what is playing',
       'Replace this scene with the patterns currently selected on each track',
       () => api.send('updateScene', { scene: index }));
  item('Rename', 'Also on double-click', () => renameScene(index, anchor));
  item(usedBy ? `Delete — used by ${usedBy} section${usedBy === 1 ? '' : 's'}` : 'Delete',
       usedBy ? 'Those sections are removed with it' : 'Nothing in the arrangement uses this',
       () => api.send('removeScene', { scene: index }), 'danger');

  document.body.append(menu);
  const box = anchor.getBoundingClientRect();
  menu.style.left = Math.min(box.left, innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = box.bottom + 4 + 'px';
  setTimeout(() => addEventListener('pointerdown', dismissMenu), 0);
}

/** Sections laid end to end, to scale, with the playhead running through. */
function renderArrangement() {
  const host = $('#song-lane');
  host.innerHTML = '';

  if (!state.scenes.length) {
    host.innerHTML = '<div class="song-empty">Get a loop sounding the way you want it, '
      + 'then <b>keep it as a scene</b>. Place scenes one after another here to build '
      + 'the track, and draw what moves across each one.</div>';
    return;
  }

  const total = Math.max(state.songBars, 1);
  const strip = document.createElement('div');
  strip.className = 'sections';

  let barCursor = 0;
  state.arrangement.forEach((sec, i) => {
    const start = barCursor;
    barCursor += sec.bars;
    const scene = state.scenes[sec.scene];

    const el = document.createElement('div');
    el.className = 'section' + (i === selectedSection ? ' sel' : '')
                 + (state.section === i && state.playing && state.songMode ? ' live' : '');
    // Width in proportion to length, so eight bars looks like twice four.
    el.style.flexGrow = String(sec.bars);
    el.innerHTML =
      `<div class="sec-name">${esc(scene?.name ?? '?')}</div>
       <div class="sec-bars">${sec.bars} ${sec.bars === 1 ? 'bar' : 'bars'}</div>
       <div class="sec-at">${start + 1}</div>`;

    if (sec.lanes.length) {
      const marks = document.createElement('div');
      marks.className = 'sec-lanes';
      for (const lane of sec.lanes) {
        const m = document.createElement('i');
        m.style.background = laneTint(lane);
        m.title = laneLabel(lane);
        marks.append(m);
      }
      el.append(marks);
    }
    el.onclick = () => { selectedSection = i; lastShape = null; render(); };
    strip.append(el);
  });

  const add = document.createElement('button');
  add.className = 'section-add';
  add.textContent = '+';
  add.title = 'Place another section at the end';
  add.onclick = () => api.send('addSection', {
    scene: state.arrangement.at(-1)?.scene ?? 0, bars: 4,
  });
  strip.append(add);
  host.append(strip);

  // Playhead across the whole arrangement.
  if (state.songMode && state.playing && total > 0) {
    const head = document.createElement('div');
    head.className = 'song-head';
    head.style.left = ((state.songBar % total) / total * 100) + '%';
    host.append(head);
  }

  const ruler = document.createElement('div');
  ruler.className = 'song-ruler';
  ruler.textContent = `${total} bars`
    + (state.bpm ? `  ·  ${fmtTime(total * state.beatsPerBar * 60 / state.bpm)}` : '');
  host.append(ruler);
}

const fmtTime = (sec) =>
  `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

function renderSectionDetail() {
  const host = $('#section-detail');
  host.innerHTML = '';
  const sec = state.arrangement[selectedSection];
  if (!sec) return;

  const head = document.createElement('div');
  head.className = 'sd-head';
  head.innerHTML = `<span class="sd-title">SECTION ${selectedSection + 1}</span>`;

  const scenePick = document.createElement('select');
  scenePick.className = 'sec-select';
  scenePick.title = 'Which loop plays here';
  state.scenes.forEach((sc, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = sc.name;
    o.selected = i === sec.scene;
    scenePick.append(o);
  });
  scenePick.onchange = () =>
    api.send('sectionScene', { section: selectedSection, value: Number(scenePick.value) });
  head.append(scenePick);

  const bars = document.createElement('div');
  bars.className = 'stepper';
  bars.innerHTML = '<label>BARS</label>';
  const dec = document.createElement('button'); dec.textContent = '-';
  const out = document.createElement('span'); out.textContent = String(sec.bars);
  const inc = document.createElement('button'); inc.textContent = '+';
  dec.onclick = () => api.send('sectionBars', { section: selectedSection, value: sec.bars - 1 });
  inc.onclick = () => api.send('sectionBars', { section: selectedSection, value: sec.bars + 1 });
  bars.append(dec, out, inc);
  head.append(bars);

  for (const [label, fn, on] of [
    ['Move left', () => api.send('moveSection', { section: selectedSection, to: selectedSection - 1 }), selectedSection > 0],
    ['Move right', () => api.send('moveSection', { section: selectedSection, to: selectedSection + 1 }), selectedSection < state.arrangement.length - 1],
    ['Duplicate', () => api.send('addSection', { scene: sec.scene, bars: sec.bars, at: selectedSection + 1 }), true],
    ['Remove', () => { api.send('removeSection', { section: selectedSection }); selectedSection = Math.max(0, selectedSection - 1); }, true],
  ]) {
    const b = document.createElement('button');
    b.className = 'chip tiny' + (label === 'Remove' ? ' danger' : '');
    b.textContent = label;
    b.disabled = !on;
    b.onclick = fn;
    head.append(b);
  }
  host.append(head);

  // --- lanes ---------------------------------------------------------------
  sec.lanes.forEach((lane, li) => host.append(laneEditor(sec, lane, li)));

  const addLane = document.createElement('button');
  addLane.className = 'chip ghost';
  addLane.textContent = '+ AUTOMATE SOMETHING';
  addLane.onclick = (e) => openLaneMenu(e.currentTarget);
  host.append(addLane);
}

/**
 * One lane, drawn and drawable.
 *
 * Dragging across it writes the curve under the pointer, which is what "draw a
 * ramp" should mean - not placing points one at a time and hoping the line
 * between them is what you wanted.
 */
function laneEditor(sec, lane, laneIndex) {
  const wrap = document.createElement('div');
  wrap.className = 'lane';
  const target = targetById(lane.param);
  const tint = laneTint(lane);

  const head = document.createElement('div');
  head.className = 'lane-head';
  head.innerHTML = `<span class="lane-name" style="color:${tint}">${esc(laneLabel(lane))}</span>`;
  if (target?.help) head.title = target.help;

  const readout = document.createElement('span');
  readout.className = 'lane-read';
  head.append(readout);

  // Shapes over a span, not over the section. The span is whatever the lane
  // already covers, so pressing "Ramp up" on a curve you drew over half a bar
  // gives you a ramp over that half bar rather than stretching it to fill.
  const from = lane.points.length ? lane.points[0].bar : 0;
  const to = lane.points.length ? lane.points.at(-1).bar : sec.bars;
  const span = Math.max(to - from, sec.bars / 32);
  const shape = (pts) => sendCurve(laneIndex,
    pts.map(([x, y]) => `${Math.max(0, Math.min(sec.bars, x)).toFixed(3)}:${y}`).join(','));

  for (const [label, points] of [
    ['Ramp up', [[from, 0], [from + span, 1]]],
    ['Ramp down', [[from, 1], [from + span, 0]]],
    ['Up then down', [[from, 0], [from + span / 2, 1], [from + span, 0]]],
    ['Flat', [[from, 0.5], [from + span, 0.5]]],
    ['Fill section', [[0, 0], [sec.bars, 1]]],
  ]) {
    const b = document.createElement('button');
    b.className = 'chip tiny';
    b.textContent = label;
    const trim = (n) => n.toFixed(2).replace(/\.?0+$/, '');
    b.title = label === 'Fill section'
      ? 'Stretch a ramp across the whole section'
      : `Shape it over bars ${trim(from + 1)}–${trim(from + span + 1)}, `
        + 'then drag on it to adjust. Drag anywhere to draw a new span.';
    b.onclick = () => shape(points);
    head.append(b);
  }
  const del = document.createElement('button');
  del.className = 'chip tiny danger';
  del.textContent = '×';
  del.title = 'Remove this lane';
  del.onclick = () => api.send('removeLane', { section: selectedSection, lane: laneIndex });
  head.append(del);
  wrap.append(head);

  // Which tracks this curve drives. One gesture, as many tracks as you want it
  // to move - "open the filter on the drums" is one shape over three tracks,
  // not three shapes to keep in agreement afterwards.
  if (!target?.master) {
    const picks = document.createElement('div');
    picks.className = 'lane-tracks';
    picks.innerHTML = '<span class="lane-tracks-label">ON</span>';
    state.tracks.forEach((t, ti) => {
      const on = lane.tracks.includes(ti);
      const b = document.createElement('button');
      b.className = 'track-pick' + (on ? ' on' : '');
      b.style.setProperty('--c', hex(t.colour));
      b.textContent = t.name;
      b.title = on ? `${t.name} follows this curve` : `Add ${t.name} to this curve`;
      b.onclick = () => api.send('laneTrack', {
        section: selectedSection, lane: laneIndex, laneTrack: ti, value: on ? 0 : 1,
      });
      picks.append(b);
    });
    if (!lane.tracks.length) {
      const warn = document.createElement('span');
      warn.className = 'lane-warn';
      warn.textContent = 'no tracks selected - this curve does nothing yet';
      picks.append(warn);
    }
    wrap.append(picks);
  }

  const canvas = document.createElement('canvas');
  canvas.className = 'lane-canvas';
  wrap.append(canvas);

  // Drawn after layout, so the canvas has a size to be drawn into.
  requestAnimationFrame(() => drawLane(canvas, sec, lane, tint));

  const sendCurve = (li, points) =>
    api.send('laneCurve', { section: selectedSection, lane: li, points });

  // --- drawing -------------------------------------------------------------
  let drawing = null;
  const valueAt = (ev) => {
    const box = canvas.getBoundingClientRect();
    const bar = Math.max(0, Math.min(sec.bars, (ev.clientX - box.left) / box.width * sec.bars));
    const v = Math.max(0, Math.min(1, 1 - (ev.clientY - box.top) / box.height));
    return { bar, v };
  };
  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    interacting = true;
    drawing = [valueAt(ev)];
    drawPreview(canvas, sec, lane, tint, drawing);
  });
  canvas.addEventListener('pointermove', (ev) => {
    const p = valueAt(ev);
    // Say what the value under the pointer actually is, in the units of the
    // thing being automated. A normalised height is not a cutoff.
    if (target) {
      const real = target.log && target.min > 0
        ? target.min * Math.pow(target.max / target.min, p.v)
        : target.min + p.v * (target.max - target.min);
      readout.textContent = `bar ${(p.bar + 1).toFixed(1)}  ·  ${formatTarget(target, real)}`;
    }
    if (!drawing) return;
    // One point per horizontal step, so a slow drag does not write hundreds.
    // The step is a fraction of the section rather than a bar, so a ramp can
    // be a quarter of a bar long if that is what you drew.
    const last = drawing[drawing.length - 1];
    if (Math.abs(p.bar - last.bar) < sec.bars / 96) { last.v = p.v; }
    else drawing.push(p);
    drawPreview(canvas, sec, lane, tint, drawing);
  });
  const finish = (ev) => {
    if (!drawing) return;
    canvas.releasePointerCapture(ev.pointerId);
    interacting = false;
    const pts = [...drawing].sort((a, b) => a.bar - b.bar);
    // Stored exactly as drawn. The curve is not stretched to the section: a
    // ramp over bars 2 to 4 occupies bars 2 to 4, holds its first value before
    // and its last after, and the rest of the section is left alone.
    sendCurve(laneIndex, pts.map((p) => `${p.bar.toFixed(3)}:${p.v.toFixed(4)}`).join(','));
    drawing = null;
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  return wrap;
}

function laneGeometry(canvas) {
  const box = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (box.width < 4 || box.height < 4) return null;
  canvas.width = box.width * dpr;
  canvas.height = box.height * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, W: box.width, H: box.height };
}

function drawLaneBase(geo, sec) {
  const { g, W, H } = geo;
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(0,0,0,.25)';
  g.fillRect(0, 0, W, H);
  // A line per bar, so a shape can be aimed at a bar rather than at a pixel.
  for (let b = 0; b <= sec.bars; b++) {
    g.strokeStyle = b % 4 === 0 ? '#33405a' : '#1d2434';
    g.beginPath();
    g.moveTo(Math.round(b / sec.bars * W) + 0.5, 0);
    g.lineTo(Math.round(b / sec.bars * W) + 0.5, H);
    g.stroke();
  }
  g.strokeStyle = '#171e2c';
  for (const f of [0.25, 0.5, 0.75]) {
    g.beginPath();
    g.moveTo(0, Math.round(H * f) + 0.5);
    g.lineTo(W, Math.round(H * f) + 0.5);
    g.stroke();
  }
}

function strokeCurve(geo, sec, points, tint) {
  const { g, W, H } = geo;
  if (!points.length) return;
  const x = (bar) => bar / Math.max(sec.bars, 0.001) * W;
  const y = (v) => H - v * H;

  g.beginPath();
  g.moveTo(x(points[0].bar), y(points[0].value ?? points[0].v));
  for (const p of points) g.lineTo(x(p.bar), y(p.value ?? p.v));
  g.lineTo(W, y(points.at(-1).value ?? points.at(-1).v));
  g.strokeStyle = tint;
  g.lineWidth = 2;
  g.lineJoin = 'round';
  g.stroke();

  g.lineTo(W, H);
  g.lineTo(0, H);
  g.closePath();
  g.fillStyle = tint + '22';
  g.fill();

  g.fillStyle = tint;
  for (const p of points) {
    g.beginPath();
    g.arc(x(p.bar), y(p.value ?? p.v), 2.6, 0, Math.PI * 2);
    g.fill();
  }
}

function drawLane(canvas, sec, lane, tint) {
  const geo = laneGeometry(canvas);
  if (!geo) return;
  drawLaneBase(geo, sec);
  strokeCurve(geo, sec, lane.points, tint);

  // Where the transport is inside this section, if it is in it.
  if (state.songMode && state.playing && state.section === selectedSection) {
    let start = 0;
    for (let i = 0; i < selectedSection; i++) start += state.arrangement[i].bars;
    const local = (state.songBar % Math.max(state.songBars, 1)) - start;
    if (local >= 0 && local <= sec.bars) {
      const px = local / sec.bars * geo.W;
      geo.g.strokeStyle = '#ffd479';
      geo.g.lineWidth = 1.5;
      geo.g.beginPath();
      geo.g.moveTo(px, 0);
      geo.g.lineTo(px, geo.H);
      geo.g.stroke();
    }
  }
}

function drawPreview(canvas, sec, lane, tint, points) {
  const geo = laneGeometry(canvas);
  if (!geo) return;
  drawLaneBase(geo, sec);
  strokeCurve(geo, sec, points, tint);
}

/**
 * What can be automated.
 *
 * Parameters only. Which tracks a curve drives is chosen on the lane itself,
 * so this does not multiply out to every parameter on every track - which it
 * used to, and which made the menu taller than the window.
 */
function openLaneMenu(anchor) {
  closeMenu();
  const sec = state.arrangement[selectedSection];
  const taken = new Set((sec?.lanes ?? []).map((l) => l.param));

  const menu = document.createElement('div');
  menu.className = 'menu wide';
  menu.id = 'track-menu';

  const group = (title, targets, laneTrack) => {
    if (!targets.length) return;
    const head = document.createElement('div');
    head.className = 'menu-head';
    head.textContent = title;
    menu.append(head);
    const row = document.createElement('div');
    row.className = 'choice-row pad';
    for (const t of targets) {
      const b = document.createElement('button');
      b.className = 'chip tiny';
      b.textContent = t.label.replace(/^(Filter|Master) /, '');
      b.title = t.help + (taken.has(t.id) ? '\n\nAlready on this section.' : '');
      b.disabled = taken.has(t.id);
      b.onclick = () => {
        api.send('addLane', { section: selectedSection, laneTrack, param: t.id });
        closeMenu();
      };
      row.append(b);
    }
    menu.append(row);
  };

  // Seeded with the armed track, so a lane arrives already doing something.
  group('PER TRACK', autoTargets.filter((t) => !t.master), selected);
  group('MASTER', autoTargets.filter((t) => t.master), -1);

  const foot = document.createElement('div');
  foot.className = 'menu-foot';
  foot.textContent = 'A per-track curve starts on the armed track. Add more tracks '
    + 'to it from the lane, and they all follow the same shape.';
  menu.append(foot);

  document.body.append(menu);
  const box = anchor.getBoundingClientRect();
  menu.style.left = Math.min(box.left, innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = Math.max(8, Math.min(innerHeight - menu.offsetHeight - 8,
    innerHeight - box.bottom > menu.offsetHeight + 8 ? box.bottom + 4
                                                     : box.top - menu.offsetHeight - 4)) + 'px';
  setTimeout(() => addEventListener('pointerdown', dismissMenu), 0);
}

const formatTarget = (t, v) =>
  Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' + t.unit : v.toFixed(2) + t.unit;

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

    // The channel filter. Off by default and visibly so, because a filter you
    // forgot was engaged is a mix problem you cannot hear the cause of.
    const filt = document.createElement('div');
    filt.className = 'filt' + (t.mixer.filterType ? ' on' : '');
    filt.innerHTML = '<label>FILTER</label>';
    const types = document.createElement('div');
    types.className = 'filt-types';
    ['Off', 'Low', 'High', 'Band'].forEach((name, n) => {
      const b = document.createElement('button');
      b.className = 'chip tiny' + (t.mixer.filterType === n ? ' on' : '');
      b.textContent = name;
      b.title = ['No filter on this channel.',
                 'Lowpass: takes the top off. Sweeping one open is the classic build.',
                 'Highpass: takes the bottom out. Thins a track so the kick has room.',
                 'Bandpass: keeps a slice around the cutoff, like a radio.'][n];
      b.onclick = () => api.send('filter', { track: i, what: 'type', value: n });
      types.append(b);
    });
    filt.append(types);

    if (t.mixer.filterType) {
      const fk = document.createElement('div');
      fk.className = 'knobs';
      const LO = 20, HI = 20000;
      const toNorm = (hz) => Math.log(hz / LO) / Math.log(HI / LO);
      const toHz = (v) => LO * Math.pow(HI / LO, v);
      fk.append(
        knob('CUTOFF', toNorm(t.mixer.filterCutoff),
             t.mixer.filterCutoff >= 1000 ? (t.mixer.filterCutoff / 1000).toFixed(1) + 'k'
                                          : Math.round(t.mixer.filterCutoff) + '',
             c, (v) => api.send('filter', { track: i, what: 'cutoff', value: toHz(v) })),
        knob('RESO', (t.mixer.filterReso - 0.5) / 19.5, t.mixer.filterReso.toFixed(1), c,
             (v) => api.send('filter', { track: i, what: 'reso', value: 0.5 + v * 19.5 })),
      );
      filt.append(fk);
    }
    strip.append(filt);

    // Level, post-fader.
    const meter = document.createElement('div');
    meter.className = 'strip-meter';
    meter.innerHTML = '<i></i>';
    strip.append(meter);

    host.append(strip);
  });

  renderMaster();
}

/**
 * The master bus.
 *
 * Every track has had VERB and DELAY sends since the beginning, feeding
 * effects with no controls anywhere in the interface. This is what they were
 * being sent to.
 */
function renderMaster() {
  const host = $('#master');
  const m = state.master;
  host.innerHTML = '';

  const group = (title, controls) => {
    const g = document.createElement('div');
    g.className = 'mgroup';
    g.innerHTML = `<h4>${title}</h4>`;
    const k = document.createElement('div');
    k.className = 'knobs';
    k.append(...controls);
    g.append(k);
    return g;
  };
  const mk = (label, norm, display, tint, what, toValue, help) => {
    const w = knob(label, norm, display, tint, (v) => api.send('master', { what, value: toValue(v) }));
    w.classList.add('param');
    w.title = `${label}\n\n${help}`;
    return w;
  };

  host.append(group('OUTPUT', [
    mk('LEVEL', m.gain / 1.5, pct(m.gain / 1.5) + '%', '#e9eefb', 'gain', (v) => v * 1.5,
       'Level of the whole mix, before the limiter.'),
    mk('DRIVE', m.drive, pct(m.drive) + '%', '#ffb86b', 'drive', (v) => v,
       'Saturation across the master. A little glues a mix together; a lot is '
       + 'the sound of everything being pushed into the same place.'),
  ]));

  const lim = document.createElement('button');
  lim.className = 'chip small' + (m.limiter ? ' on' : '');
  lim.textContent = 'LIMITER';
  lim.title = 'Catches peaks before the output clips. A lookahead limiter, so it '
    + 'sees a transient coming rather than reacting after it has passed.';
  lim.onclick = () => api.send('master', { what: 'limiter', value: m.limiter ? 0 : 1 });
  host.querySelector('.mgroup').append(lim);

  host.append(group('REVERB', [
    mk('SIZE', m.reverb.size, pct(m.reverb.size) + '%', '#ffb86b', 'revSize', (v) => v,
       'How long the space rings for. Small is a room, large is a hall that '
       + 'never quite stops.'),
    mk('DAMP', m.reverb.damp, pct(m.reverb.damp) + '%', '#ffb86b', 'revDamp', (v) => v,
       'How fast the treble dies inside the tail. High damping is a soft room '
       + 'with curtains; low is tiled and bright.'),
    mk('WIDTH', m.reverb.width, pct(m.reverb.width) + '%', '#ffb86b', 'revWidth', (v) => v,
       'How far the tail spreads across the stereo field.'),
    mk('RETURN', m.reverb.mix / 1.5, pct(m.reverb.mix / 1.5) + '%', '#ffb86b', 'revMix', (v) => v * 1.5,
       'How much of the reverb comes back into the mix. The per-track VERB '
       + 'knobs decide how much each track sends here.'),
  ]));

  const beats = [[0.25, '1/16'], [0.375, '1/16.'], [0.5, '1/8'], [0.75, '1/8.'],
                 [1, '1/4'], [1.5, '1/4.'], [2, '1/2']];
  const nearest = beats.reduce((a, b) =>
    Math.abs(b[0] - m.delay.beats) < Math.abs(a[0] - m.delay.beats) ? b : a);
  const delayGroup = group('DELAY', [
    mk('FEEDBACK', m.delay.feedback / 0.95, pct(m.delay.feedback / 0.95) + '%', '#c77dff',
       'dlyFb', (v) => v * 0.95,
       'How much of each repeat is fed back in. High and it runs away from you, '
       + 'which is sometimes the point.'),
    mk('TONE', Math.log(m.delay.tone / 200) / Math.log(90),
       m.delay.tone >= 1000 ? (m.delay.tone / 1000).toFixed(1) + 'k' : Math.round(m.delay.tone) + '',
       '#c77dff', 'dlyTone', (v) => 200 * Math.pow(90, v),
       'A lowpass in the feedback path, so each repeat is darker than the last '
       + 'the way a real echo is.'),
    mk('PING PONG', m.delay.pingpong, pct(m.delay.pingpong) + '%', '#c77dff', 'dlyPing', (v) => v,
       'How far the repeats alternate left and right.'),
    mk('RETURN', m.delay.mix / 1.5, pct(m.delay.mix / 1.5) + '%', '#c77dff', 'dlyMix', (v) => v * 1.5,
       'How much delay comes back into the mix.'),
  ]);
  const timeRow = document.createElement('div');
  timeRow.className = 'choice-row';
  timeRow.title = 'Delay time, in beats. A dotted eighth against four-four is '
    + 'three against four - the repeats cross the beat instead of doubling it.';
  for (const [v, label] of beats) {
    const b = document.createElement('button');
    b.className = 'chip tiny' + (nearest[0] === v ? ' on' : '');
    b.textContent = label;
    b.onclick = () => api.send('master', { what: 'dlyBeats', value: v });
    timeRow.append(b);
  }
  delayGroup.append(timeRow);
  host.append(delayGroup);

  host.append(group('SIDECHAIN', [
    mk('RELEASE', Math.min(1, m.sidechainRelease / 1.5), Math.round(m.sidechainRelease * 1000) + 'ms',
       '#ffd479', 'scRelease', (v) => Math.max(0.02, v * 1.5),
       'How long a ducked track takes to come back up. This is the length of '
       + 'the pump. The per-track DUCK knobs decide how far each one drops.'),
    mk('CURVE', (m.sidechainCurve - 0.3) / 5.7, m.sidechainCurve.toFixed(1), '#ffd479',
       'scCurve', (v) => 0.3 + v * 5.7,
       'The shape of the recovery. Above 1 the level hangs low and then snaps '
       + 'back, which is the part you feel.'),
  ]));
}

// The parameters of the armed track, fetched when the track or its instrument
// changes rather than on every frame - they are only touched by this view.
let params = [];
let paramsKey = null;

async function syncParams(force = false) {
  const track = state.tracks[selected];
  if (!track) return;
  const key = `${selected}|${track.engine}|${track.isDrum}`;
  if (!force && key === paramsKey) return;
  paramsKey = key;
  params = await (await fetch(`/api/params?track=${selected}`)).json();
  if (view === 'sound') renderParams();
}

function renderSound() {
  const track = state.tracks[selected];
  if (!track) return;
  const list = track.isDrum ? presets.drums : presets.synths;
  const bar = $('#preset-bar');
  bar.innerHTML = '';

  const label = document.createElement('span');
  label.className = 'bar-label';
  label.textContent = 'PRESETS';
  bar.append(label);

  list.forEach((p) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = p.name;
    b.title = p.blurb;
    b.onclick = async () => { api.send('preset', { track: selected, name: p.name });
                              setTimeout(() => syncParams(true), 200); };
    bar.append(b);
  });

  const reset = document.createElement('button');
  reset.className = 'chip ghost';
  reset.textContent = 'RESET';
  reset.title = 'Back to the default sound for this engine';
  reset.onclick = () => { api.send('resetSound', { track: selected });
                          setTimeout(() => syncParams(true), 200); };
  bar.append(reset);

  renderParams();
}

/**
 * The controls themselves, built from the engine's own parameter table.
 *
 * Nothing here knows what a cutoff is or what range it lives in. That means a
 * control cannot drift out of step with the thing it edits, and a parameter
 * added to the engine appears here without the interface being touched.
 */
function renderParams() {
  const host = $('#params');
  host.innerHTML = '';
  if (!params.length) return;

  for (const p of params) {
    if (p.choices) { host.append(choiceControl(p)); continue; }

    const send = (norm) => api.send('param', { track: selected, id: p.id, value: norm });
    // A real colour, not var(--c): the knob is drawn into a canvas, and canvas
    // has no idea what a CSS custom property is - it silently draws nothing.
    const tint = hex(state.tracks[selected].colour);
    const wrap = knob(p.label, p.norm, formatParam(p, p.value), tint, (v) => {
      p.norm = v;
      p.value = denorm(p, v);
      wrap.querySelector('output').textContent = formatParam(p, p.value);
      send(v);
    });
    wrap.classList.add('param');
    // The explanation is the point. Hover on the control that raised the
    // question, rather than in documentation nobody opens.
    wrap.title = `${p.label}\n\n${p.help}`;
    host.append(wrap);
  }
}

/**
 * Mirror of ParamSpec::fromNorm, so the readout tracks the drag.
 *
 * The engine still owns the mapping - this only decides what number to print
 * between one round trip and the next, and the next poll overwrites it.
 */
function denorm(p, norm) {
  const n = Math.min(1, Math.max(0, norm));
  return p.log && p.min > 0 ? p.min * Math.pow(p.max / p.min, n)
                            : p.min + n * (p.max - p.min);
}

function formatParam(p, value) {
  if (Math.abs(value) >= 1000) return (value / 1000).toFixed(1) + 'k' + p.unit;
  if (p.unit === 's') return value < 1 ? Math.round(value * 1000) + 'ms' : value.toFixed(2) + 's';
  if (Math.abs(value) >= 100) return Math.round(value) + p.unit;
  if (Math.abs(value) >= 10) return value.toFixed(1) + p.unit;
  return value.toFixed(2).replace(/0$/, '') + p.unit;
}

/** Discrete parameters get named buttons; a knob would hide the names. */
function choiceControl(p) {
  const wrap = document.createElement('div');
  wrap.className = 'choice';
  wrap.title = `${p.label}\n\n${p.help}`;
  wrap.innerHTML = `<label>${p.label}</label>`;
  const row = document.createElement('div');
  row.className = 'choice-row';
  p.choices.forEach((name, i) => {
    const b = document.createElement('button');
    b.className = 'chip small' + (Math.round(p.value) === i ? ' on' : '');
    b.textContent = name;
    b.onclick = () => {
      const norm = p.choices.length > 1 ? i / (p.choices.length - 1) : 0;
      api.send('param', { track: selected, id: p.id, value: norm });
      setTimeout(() => syncParams(true), 200);
    };
    row.append(b);
  });
  wrap.append(row);
  return wrap;
}

// --------------------------------------------------------------------------
// The playing surface
//
// Two ways to lay a computer keyboard out over an instrument.
//
// Chromatic is a piano: the home row is the white keys, the row above holds
// the black ones where they would be. It is the right thing when you know
// what you are reaching for.
//
// In-key throws that away and gives every key a degree of the current scale
// instead. There are then no wrong notes to hit, only ones you like more than
// others - which is the difference between playing an idea and hunting for it.
// Two rows give two and a half octaves in the scale, which is enough for a
// bassline and the hook over it.
// --------------------------------------------------------------------------

const PIANO_KEYS = [
  ['a', 0, 0], ['w', 1, 1], ['s', 2, 0], ['e', 3, 1], ['d', 4, 0], ['f', 5, 0],
  ['t', 6, 1], ['g', 7, 0], ['y', 8, 1], ['h', 9, 0], ['u', 10, 1], ['j', 11, 0],
  ['k', 12, 0], ['o', 13, 1], ['l', 14, 0],
];
const SCALE_ROW_LOW  = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'];
const SCALE_ROW_HIGH = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o'];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

let scaleLock = true;
let octave = 0;

/** What each key plays right now. Keyed by the character you press. */
function keyMap() {
  const map = new Map();
  if (!scaleLock) {
    for (const [k, semi, black] of PIANO_KEYS)
      map.set(k, { semi, black, label: NOTE_NAMES[(48 + semi) % 12] });
    return map;
  }
  const degrees = state?.key?.degrees ?? 7;
  SCALE_ROW_LOW.forEach((k, i) => map.set(k, { degree: i, row: 0, tonic: i % degrees === 0 }));
  SCALE_ROW_HIGH.forEach((k, i) => map.set(k, { degree: i + degrees, row: 1,
                                                tonic: (i + degrees) % degrees === 0 }));
  return map;
}

/** MIDI note a mapped key sounds, for labelling. Mirrors Theory.h. */
function noteForKey(info) {
  if (!scaleLock) return 48 + 12 * octave + info.semi;
  const steps = SCALE_STEPS[state?.key?.scaleIndex ?? 0] ?? SCALE_STEPS[0];
  const n = steps.length;
  const d = info.degree;
  const wrapped = ((d % n) + n) % n;
  const shift = Math.floor(d / n);
  return 12 * (5 + octave + shift) + (state?.key?.root ?? 0) + steps[wrapped];
}

// Same tables as Theory.h. Only used for labelling the keys - every note that
// actually sounds is worked out by the engine from the same scale.
const SCALE_STEPS = [
  [0, 2, 3, 5, 7, 8, 10], [0, 2, 4, 5, 7, 9, 11], [0, 2, 3, 5, 7, 9, 10],
  [0, 1, 3, 5, 7, 8, 10], [0, 2, 4, 6, 7, 9, 11], [0, 2, 4, 5, 7, 9, 10],
  [0, 1, 3, 5, 6, 8, 10], [0, 2, 3, 5, 7, 8, 11], [0, 1, 4, 5, 7, 8, 10],
  [0, 3, 5, 7, 10], [0, 2, 4, 7, 9], [0, 3, 5, 6, 7, 10], [0, 2, 4, 6, 8, 10],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
];
const SCALE_NAMES = [
  'Minor', 'Major', 'Dorian', 'Phrygian', 'Lydian', 'Mixolydian', 'Locrian',
  'Harmonic Minor', 'Phrygian Dominant', 'Minor Pentatonic', 'Major Pentatonic',
  'Blues', 'Whole Tone', 'Chromatic',
];

/**
 * When this key event happened, in seconds.
 *
 * Read here, at the moment of the press, and sent with the note. A request can
 * queue behind others or be overtaken by a later one, and timestamping it on
 * arrival made the recorded rhythm the rhythm of the network - which shows up
 * as a take that fits badly precisely when the interface is busy.
 */
const now = () => performance.now() / 1000;

function playKey(k) {
  const info = keyMap().get(k);
  if (!info || heldKeys.has(k)) return;
  const at = now();
  heldKeys.add(k);
  if (scaleLock) api.send('noteOnDegree', { degree: info.degree, octave, velocity: 0.85, at });
  else           api.send('noteOn', { note: 48 + 12 * octave + info.semi, velocity: 0.85, at });
  renderKeys();
}

function releaseKey(k) {
  const info = keyMap().get(k);
  if (!info || !heldKeys.has(k)) return;
  const at = now();
  heldKeys.delete(k);
  if (scaleLock) api.send('noteOffDegree', { degree: info.degree, octave, at });
  else           api.send('noteOff', { note: 48 + 12 * octave + info.semi, at });
  renderKeys();
}

let keysShape = null;

function renderKeys() {
  const host = $('#keys');
  const map = keyMap();
  const shape = `${scaleLock}|${octave}|${state?.key?.root}|${state?.key?.scaleIndex}`;

  if (shape === keysShape) {
    host.querySelectorAll('.key').forEach(
      (el) => el.classList.toggle('down', heldKeys.has(el.dataset.k)));
    return;
  }
  keysShape = shape;
  host.innerHTML = '';
  host.classList.toggle('two-row', scaleLock);

  const build = (chars) => {
    const row = document.createElement('div');
    row.className = 'key-row';
    for (const k of chars) {
      const info = map.get(k);
      const el = document.createElement('div');
      el.className = 'key'
        + (info.black ? ' black' : '')
        + (info.tonic ? ' tonic' : '');
      el.dataset.k = k;
      const note = noteForKey(info);
      el.innerHTML = `<b>${k.toUpperCase()}</b>`
        + `<span>${NOTE_NAMES[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}</span>`;
      // Playable with the mouse too, for anyone who would rather point at it.
      el.addEventListener('pointerdown', () => playKey(k));
      el.addEventListener('pointerup', () => releaseKey(k));
      el.addEventListener('pointerleave', () => releaseKey(k));
      row.append(el);
    }
    return row;
  };

  if (scaleLock) host.append(build(SCALE_ROW_HIGH), build(SCALE_ROW_LOW));
  else           host.append(build(PIANO_KEYS.map(([k]) => k)));

  host.querySelectorAll('.key').forEach(
    (el) => el.classList.toggle('down', heldKeys.has(el.dataset.k)));
}

/**
 * Tempo, shuffle and humanise.
 *
 * The three that decide whether a bar feels right rather than what is in it,
 * which is why they sit together and away from everything else.
 */
function openGrooveMenu(anchor) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu wide';
  menu.id = 'track-menu';
  menu.innerHTML = '<div class="menu-head">GROOVE</div>';

  const knobs = document.createElement('div');
  knobs.className = 'knobs groove-knobs';
  const mk = (label, norm, display, tint, onChange, help) => {
    const w = knob(label, norm, display, tint, onChange);
    w.classList.add('param');
    w.title = `${label}\n\n${help}`;
    return w;
  };
  knobs.append(
    mk('TEMPO', (state.bpm - 60) / 140, state.bpm.toFixed(1), '#5ee6c5',
       (v) => api.send('bpm', { value: 60 + v * 140 }),
       'Beats per minute, 60 to 200.'),
    mk('SWING', state.swing, state.swing < 0.02 ? 'straight' : pct(state.swing) + '%', '#ffb86b',
       (v) => api.send('swing', { value: v }),
       'How far the off-steps are pushed late. At zero everything is dead on the '
       + 'grid; at full they land exactly on the triplet, which is a hard shuffle.'),
    mk('HUMANISE', state.humanize / 40, Math.round(state.humanize) + 'ms', '#c77dff',
       (v) => api.send('humanize', { value: v * 40 }),
       'Timing scatter, in milliseconds. Stable rather than random per pass - the '
       + 'same step is always off by the same amount, so it reads as a player '
       + 'with habits rather than as a machine glitching.'),
  );
  menu.append(knobs);

  const unitHead = document.createElement('div');
  unitHead.className = 'menu-head';
  unitHead.textContent = 'SWING APPLIES EVERY';
  menu.append(unitHead);
  const units = document.createElement('div');
  units.className = 'choice-row pad';
  units.title = 'Which steps get pushed. Every 2nd is the usual shuffle; larger '
    + 'groupings swing a slower pulse underneath the fast one.';
  for (const u of [2, 3, 4, 6, 8]) {
    const b = document.createElement('button');
    b.className = 'chip small' + (state.swingUnit === u ? ' on' : '');
    b.textContent = u + ' steps';
    b.onclick = () => api.send('swingUnit', { value: u });
    units.append(b);
  }
  menu.append(units);

  document.body.append(menu);
  const box = anchor.getBoundingClientRect();
  menu.style.left = Math.min(box.left, innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = box.bottom + 6 + 'px';
  setTimeout(() => addEventListener('pointerdown', dismissMenu), 0);
}

/** Key and scale, so a whole track can be moved into another mode at once. */
function openKeyMenu(anchor) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu wide';
  menu.id = 'track-menu';
  menu.innerHTML = '<div class="menu-head">ROOT</div>';

  const roots = document.createElement('div');
  roots.className = 'choice-row pad';
  NOTE_NAMES.forEach((name, i) => {
    const b = document.createElement('button');
    b.className = 'chip small' + (state.key.root === i ? ' on' : '');
    b.textContent = name;
    b.onclick = () => { api.send('key', { root: i }); closeMenu(); };
    roots.append(b);
  });
  menu.append(roots);

  const head = document.createElement('div');
  head.className = 'menu-head';
  head.textContent = 'SCALE';
  menu.append(head);
  const scales = document.createElement('div');
  scales.className = 'choice-row pad';
  SCALE_NAMES.forEach((name, i) => {
    const b = document.createElement('button');
    b.className = 'chip small' + (state.key.scaleIndex === i ? ' on' : '');
    b.textContent = name;
    b.onclick = () => { api.send('key', { scale: i }); closeMenu(); };
    scales.append(b);
  });
  menu.append(scales);

  document.body.append(menu);
  const box = anchor.getBoundingClientRect();
  menu.style.left = Math.min(box.left, innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = box.top - menu.offsetHeight - 6 + 'px';
  setTimeout(() => addEventListener('pointerdown', dismissMenu), 0);
}

function setOctave(v) {
  const next = Math.max(-3, Math.min(3, v));
  if (next === octave) return;
  // Anything held is sounding at the old octave and would never be told to
  // stop, because the release would be sent for a note that was never started.
  api.send('allNotesOff');
  heldKeys.clear();
  octave = next;
  $('#oct-value').textContent = (octave > 0 ? '+' : '') + octave;
  renderKeys();
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
    // The keyboard is laid out from the key, so a change of root or scale has
    // to count as a change of shape. Without this the engine moved key and the
    // keys on screen kept playing - and showing - the old one.
    state.key.root, state.key.scaleIndex,
    state.tracks.map((t) =>
      `${t.name}|${t.engine}|${t.colour}|${t.seqEnabled}|${t.activePattern}|${t.patterns.length}`
      + `|${t.mixer.filterType}`).join(','),
    // The master panel is drawn from these, and the delay time and limiter are
    // buttons whose selected state is structural.
    `${state.master.limiter}|${state.master.delay.beats}|${state.swingUnit}`,
    // The whole arrangement: a section's length changes the layout, and a lane's
    // curve changes what is drawn on it.
    selectedSection, state.songMode, state.section,
    JSON.stringify(state.scenes), JSON.stringify(state.arrangement),
    state.tracks[selected]?.patterns[state.tracks[selected].activePattern]?.length,
    state.tracks.map((t) => (t.mixer.mute ? 'm' : '') + (t.mixer.solo ? 's' : '')).join(''),
    selectedStep,
    // Every visible pattern, not just which steps are on: editing a velocity
    // or a ratchet has to redraw, and the grid shows all the tracks at once,
    // so a change to any of them is a change to what is on screen.
    state.tracks.map((t) => JSON.stringify(t.patterns[t.activePattern])).join(''),
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
  // Meters are values, not structure, so they move every frame without the
  // view being rebuilt around them.
  const meterWidth = (t) => Math.min(100, Math.round(Math.sqrt(t.peak ?? 0) * 118)) + '%';
  document.querySelectorAll('#grid-rows .gh-meter i').forEach((el, ti) => {
    if (state.tracks[ti]) el.style.width = meterWidth(state.tracks[ti]);
  });
  document.querySelectorAll('#mixer .strip-meter i').forEach((el, ti) => {
    if (state.tracks[ti]) el.style.width = meterWidth(state.tracks[ti]);
  });

  if (view === 'song') {
    // The playhead moves every frame; the arrangement around it does not.
    const total = Math.max(state.songBars, 1);
    const head = document.querySelector('.song-head');
    if (head) head.style.left = ((state.songBar % total) / total * 100) + '%';
    document.querySelectorAll('#song-lane .section').forEach((el, i) =>
      el.classList.toggle('live', state.songMode && state.playing && state.section === i));
    if (!interacting) {
      const sec = state.arrangement[selectedSection];
      document.querySelectorAll('.lane').forEach((wrap, li) => {
        const canvas = wrap.querySelector('.lane-canvas');
        const lane = sec?.lanes[li];
        if (canvas && lane) drawLane(canvas, sec, lane, laneTint(lane));
      });
    }
  }

  if (view === 'grid') {
    // Every track has its own playhead: with different pattern lengths they
    // are genuinely in different places, and showing one bar sweeping all of
    // them would be a lie about what the engine is doing.
    document.querySelectorAll('#grid-rows .grow').forEach((row, ti) => {
      const t = state.tracks[ti];
      const pat = t?.patterns[t.activePattern];
      if (!pat) return;
      row.querySelectorAll('.gcell').forEach((el, i) =>
        el.classList.toggle('here', state.playing && (i % pat.length) === t.step));
    });
  }
}

function render() {
  if (!state) return;
  const track = state.tracks[selected];
  if (track) document.documentElement.style.setProperty('--c', hex(track.colour));
  $('#keys').style.setProperty('--c', track ? hex(track.colour) : '#5ee6c5');

  $('#project-name').textContent = state.name || 'Untitled';
  $('#key-name').textContent = `${NOTE_NAMES[state.key.root]} ${state.key.scale}`;
  $('#scale-lock').classList.toggle('on', scaleLock);
  const midi = state.midi || [];
  $('#midi').textContent = midi.length
    ? (midi.length === 1 ? midi[0] : `${midi.length} MIDI inputs`)
    : '';
  $('#midi').classList.toggle('on', midi.length > 0);
  $('#r-bpm').textContent = state.bpm.toFixed(1);
  $('#r-swing').textContent = state.swing < 0.02 ? '--' : pct(state.swing) + '%';
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
  if (view === 'sound') syncParams();

  // Never restructure under a finger that is mid-gesture.
  if (interacting) return;

  const shape = shapeKey();
  if (shape === lastShape) { refreshLive(); return; }
  lastShape = shape;

  renderTracks();
  if (view === 'grid') renderGrid();
  else if (view === 'steps') renderSteps();
  else if (view === 'mix') renderMix();
  else if (view === 'song') renderSong();
  else renderSound();
  renderKeys();
  refreshLive();
}

// --------------------------------------------------------------------------
// Input
// --------------------------------------------------------------------------

$('#play').onclick = () => api.send(state && state.playing ? 'stop' : 'play');
$('#rec').onclick = () => api.send('record');
$('#project').onclick = (e) => openProjectMenu(e.currentTarget);

// Tempo: drag the number, or click for the rest of the groove controls. The
// drag is there because nudging a tempo two BPM is a thing you do constantly
// and should not need a panel for.
{
  const el = $('#groove');
  let dragged = false;
  el.addEventListener('pointerdown', (e) => {
    const startY = e.clientY, startBpm = state.bpm;
    dragged = false;
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      if (Math.abs(ev.clientY - startY) < 4) return;
      dragged = true;
      interacting = true;
      const next = Math.max(40, Math.min(240, startBpm + (startY - ev.clientY) * 0.25));
      $('#r-bpm').textContent = next.toFixed(1);
      api.send('bpm', { value: next });
    };
    const up = () => {
      el.releasePointerCapture(e.pointerId);
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      interacting = false;
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
  el.onclick = (e) => { if (!dragged) openGrooveMenu(e.currentTarget); };
}
$('#add-drum').onclick = () => api.send('addTrack', { kind: 'drum' });
$('#add-synth').onclick = () => api.send('addTrack', { kind: 'synth' });

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

$('#scale-lock').onclick = () => {
  api.send('allNotesOff');
  heldKeys.clear();
  scaleLock = !scaleLock;
  $('#scale-lock').classList.toggle('on', scaleLock);
  renderKeys();
};
$('#key-pick').onclick = (e) => openKeyMenu(e.currentTarget);
$('#oct-down').onclick = () => setOctave(octave - 1);
$('#oct-up').onclick = () => setOctave(octave + 1);

addEventListener('keydown', (e) => {
  if (e.repeat) return;
  // Typing into the interface is not playing. Without this, naming a project
  // plays a chord and leaves the notes hanging when the field takes the keyup.
  if (e.target.matches('input, textarea, [contenteditable="true"]')) return;

  const k = e.key.toLowerCase();

  // Selection shortcuts come first, and anything with a modifier never plays
  // a note - otherwise copying a phrase would also sound one.
  if (e.ctrlKey || e.metaKey) {
    if (k === 'c') { e.preventDefault(); flash(`${copySelection()} steps copied`); return; }
    if (k === 'x') {
      e.preventDefault();
      const n = copySelection();
      selectionOps.clear();
      flash(`${n} steps cut`);
      return;
    }
    if (k === 'v') {
      e.preventDefault();
      const at = selectionOrigin() ?? { track: selected, step: selectedStep };
      pasteAt(at.track, at.step);
      flash(`pasted ${clipboard.length} steps`);
      return;
    }
    if (k === 'a') {
      e.preventDefault();
      const last = state.tracks.length - 1;
      const lastPat = patternOf(state.tracks[last]);
      selection = selectBox({ track: 0, step: 0 },
                            { track: last, step: (lastPat?.length ?? 16) - 1 });
      lastShape = null; render();
      flash(`${selection.size} steps selected`);
      return;
    }
    if (k === 'd') {
      // Duplicate to the right of what is selected: the usual way a bar of
      // drums becomes two.
      e.preventDefault();
      const origin = selectionOrigin();
      if (!origin) return;
      const width = Math.max(...[...selection].map((c) => Number(c.split(':')[1]))) - origin.step + 1;
      copySelection();
      pasteAt(origin.track, origin.step + width);
      flash(`duplicated ${clipboard.length} steps`);
      return;
    }
    if (k === 'arrowup' || k === 'arrowdown') {
      e.preventDefault();
      selectionOps.nudge('vel', k === 'arrowup' ? 1 : -1);
      return;
    }
    return;
  }

  if (selection.size) {
    if (k === 'delete' || k === 'backspace') {
      e.preventDefault(); selectionOps.clear(); return;
    }
    if (k === 'arrowup' || k === 'arrowdown') {
      e.preventDefault();
      const by = k === 'arrowup' ? 1 : -1;
      selectionOps.nudge(e.shiftKey ? 'oct' : 'deg', by);
      return;
    }
    if (k === 'arrowleft' || k === 'arrowright') {
      e.preventDefault();
      selectionOps.nudge('nudge', k === 'arrowright' ? 1 : -1);
      return;
    }
    if (k === 'escape') { clearSelection(); return; }
  }

  if (k === ' ') { e.preventDefault(); api.send(state && state.playing ? 'stop' : 'play'); return; }
  if (k === 'r') { api.send('record'); return; }
  if (k === 'z') { setOctave(octave - 1); return; }
  if (k === 'x') { setOctave(octave + 1); return; }
  playKey(k);
});
addEventListener('keyup', (e) => releaseKey(e.key.toLowerCase()));
// The take plot is drawn at device pixels for a specific size, so it has to be
// redrawn whenever that size changes - including when the window is resized.
addEventListener('resize', () => { if (view === 'steps') drawTake(); });

// A held note must end when focus goes, or it sustains forever. Asking the
// engine to drop everything is safer than replaying the releases: the mapping
// may have changed under the held keys.
addEventListener('blur', () => {
  if (!heldKeys.size) return;
  api.send('allNotesOff');
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
