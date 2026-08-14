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

function playKey(k) {
  const info = keyMap().get(k);
  if (!info || heldKeys.has(k)) return;
  heldKeys.add(k);
  if (scaleLock) api.send('noteOnDegree', { degree: info.degree, octave, velocity: 0.85 });
  else           api.send('noteOn', { note: 48 + 12 * octave + info.semi, velocity: 0.85 });
  renderKeys();
}

function releaseKey(k) {
  const info = keyMap().get(k);
  if (!info || !heldKeys.has(k)) return;
  heldKeys.delete(k);
  if (scaleLock) api.send('noteOffDegree', { degree: info.degree, octave });
  else           api.send('noteOff', { note: 48 + 12 * octave + info.semi });
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
      `${t.name}|${t.engine}|${t.colour}|${t.seqEnabled}|${t.activePattern}|${t.patterns.length}`).join(','),
    state.tracks[selected]?.patterns[state.tracks[selected].activePattern]?.length,
    state.tracks.map((t) => (t.mixer.mute ? 'm' : '') + (t.mixer.solo ? 's' : '')).join(''),
    selectedStep,
    // The whole pattern, not just which steps are on: editing a velocity or a
    // ratchet has to redraw, and those are what the detail panel exists for.
    JSON.stringify(state.tracks[selected]?.patterns[state.tracks[selected].activePattern]),
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

  $('#project-name').textContent = state.name || 'Untitled';
  $('#key-name').textContent = `${NOTE_NAMES[state.key.root]} ${state.key.scale}`;
  $('#scale-lock').classList.toggle('on', scaleLock);
  const midi = state.midi || [];
  $('#midi').textContent = midi.length
    ? (midi.length === 1 ? midi[0] : `${midi.length} MIDI inputs`)
    : '';
  $('#midi').classList.toggle('on', midi.length > 0);
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
  if (view === 'sound') syncParams();

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
$('#project').onclick = (e) => openProjectMenu(e.currentTarget);
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
