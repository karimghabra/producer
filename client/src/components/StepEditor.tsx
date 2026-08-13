import { useMemo } from 'react';
import type { TrigCondition, Pattern, Track } from '@shared/types';
import { euclidPattern, degreeToMidi, chordSymbol, clamp } from '@shared/theory';
import { NOTE_NAMES } from '@shared/types';
import { useStore } from '../state/store';
import { usePlayhead, stepAt } from '../lib/usePlayhead';
import { Knob, Seg, Slider } from './controls';

// ---------------------------------------------------------------------------
// Trig conditions
// ---------------------------------------------------------------------------

const CONDITIONS: Array<{ label: string; value: string; cond: TrigCondition; hint: string }> = [
  { label: '—', value: 'always', cond: { type: 'always' }, hint: 'Always plays' },
  { label: '90%', value: 'p90', cond: { type: 'prob', chance: 0.9 }, hint: 'Plays 90% of the time' },
  { label: '75%', value: 'p75', cond: { type: 'prob', chance: 0.75 }, hint: 'Plays 75% of the time' },
  { label: '50%', value: 'p50', cond: { type: 'prob', chance: 0.5 }, hint: 'Coin flip' },
  { label: '25%', value: 'p25', cond: { type: 'prob', chance: 0.25 }, hint: 'Rare' },
  { label: '1:2', value: 'r1:2', cond: { type: 'ratio', hit: 1, of: 2 }, hint: 'Every other loop' },
  { label: '2:2', value: 'r2:2', cond: { type: 'ratio', hit: 2, of: 2 }, hint: 'The other loop' },
  { label: '1:3', value: 'r1:3', cond: { type: 'ratio', hit: 1, of: 3 }, hint: 'First of every 3 loops' },
  { label: '1:4', value: 'r1:4', cond: { type: 'ratio', hit: 1, of: 4 }, hint: 'First of every 4 loops' },
  { label: '4:4', value: 'r4:4', cond: { type: 'ratio', hit: 4, of: 4 }, hint: 'Last of every 4 loops' },
  { label: '1:8', value: 'r1:8', cond: { type: 'ratio', hit: 1, of: 8 }, hint: 'First of every 8 loops' },
  { label: '8:8', value: 'r8:8', cond: { type: 'ratio', hit: 8, of: 8 }, hint: 'Last of every 8 loops' },
  { label: 'FILL', value: 'fill', cond: { type: 'fill' }, hint: 'Only while Fill is held' },
  { label: '!FILL', value: 'nofill', cond: { type: 'notFill' }, hint: 'Except while Fill is held' },
  { label: '1ST', value: 'first', cond: { type: 'first' }, hint: 'First loop only' },
  { label: '!1ST', value: 'notfirst', cond: { type: 'notFirst' }, hint: 'Every loop but the first' },
];

function condKey(c: TrigCondition): string {
  switch (c.type) {
    case 'prob': return `p${Math.round(c.chance * 100)}`;
    case 'ratio': return `r${c.hit}:${c.of}`;
    case 'notFill': return 'nofill';
    case 'notFirst': return 'notfirst';
    default: return c.type;
  }
}

function condBadge(c: TrigCondition): string | null {
  switch (c.type) {
    case 'always': return null;
    case 'prob': return `${Math.round(c.chance * 100)}`;
    case 'ratio': return `${c.hit}:${c.of}`;
    case 'fill': return 'F';
    case 'notFill': return '!F';
    case 'first': return '1';
    case 'notFirst': return '!1';
    default: return null;
  }
}

// ---------------------------------------------------------------------------

export function StepEditor() {
  const project = useStore((s) => s.project);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const selectedStep = useStore((s) => s.selectedStep);
  const selectStep = useStore((s) => s.selectStep);
  const selectTrack = useStore((s) => s.selectTrack);
  const toggleStep = useStore((s) => s.toggleStep);
  const updateStep = useStore((s) => s.updateStep);
  const updatePattern = useStore((s) => s.updatePattern);
  const setActivePattern = useStore((s) => s.setActivePattern);
  const clearPattern = useStore((s) => s.clearPattern);
  const randomizePattern = useStore((s) => s.randomizePattern);
  const addPattern = useStore((s) => s.addPattern);

  const head = usePlayhead();
  const track = project.tracks.find((t) => t.id === selectedTrackId);
  const patternIndex = track?.activePattern ?? 0;
  const pattern = track?.patterns[patternIndex];

  const euclidMask = useMemo(
    () => (pattern?.mode === 'euclid' ? euclidPattern(pattern.euclid, pattern.length) : null),
    [pattern?.mode, pattern?.euclid.pulses, pattern?.euclid.rotation, pattern?.euclid.invert, pattern?.length],
  );

  if (!track || !pattern) {
    return <div className="panel"><div className="panel-body hint">No track selected.</div></div>;
  }

  const isPitched = track.instrument.kind === 'synth';
  const playingStep = head.playing ? stepAt(head.tick, pattern.length, pattern.resolution) : -1;
  const step = selectedStep !== null ? pattern.steps[selectedStep] : null;

  const noteName = (degree: number, octave: number) => {
    const midi = degreeToMidi(project.key, degree, octave, 4);
    return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
  };

  return (
    <>
      {/* ---- all-track overview ------------------------------------------ */}
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Overview</span>
          <span className="hint">All tracks at once — click a row to select it</span>
        </div>
        <div className="panel-body" style={{ paddingTop: 8, paddingBottom: 8 }}>
          <div className="col" style={{ gap: 3 }}>
            {project.tracks.map((t) => (
              <OverviewRow
                key={t.id}
                track={t}
                selected={t.id === selectedTrackId}
                tick={head.tick}
                playing={head.playing}
                onSelect={() => selectTrack(t.id)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ---- pattern slots ----------------------------------------------- */}
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title" style={{ color: track.color }}>{track.name}</span>
          <div className="slots grow">
            {track.patterns.map((p, i) => (
              <button
                key={p.id}
                className={`slot ${i === patternIndex ? 'on' : ''}`}
                onClick={() => setActivePattern(track.id, i)}
                title={`${p.name} · ${p.length} steps`}
              >
                {p.name}
              </button>
            ))}
            <button className="slot" onClick={() => addPattern(track.id)} title="Add a pattern slot">+</button>
          </div>
          <button className="chip-btn" onClick={() => clearPattern(track.id, patternIndex)}>Clear</button>
          <button className="chip-btn" onClick={() => randomizePattern(track.id, patternIndex, 0.42)}
            title="Fill using the logistic map — clustered, musical densities rather than uniform noise">
            Dice
          </button>
        </div>

        {/* ---- the grid --------------------------------------------------- */}
        <div className="panel-body">
          <div className="steps-wrap">
            <div className="ruler">
              {pattern.steps.map((_, i) => (
                <div
                  key={i}
                  className={`ruler-cell ${i % pattern.resolution === 0 ? 'beat' : ''} ${i === playingStep ? 'head' : ''}`}
                >
                  {i % pattern.resolution === 0 ? i / pattern.resolution + 1 : '·'}
                </div>
              ))}
            </div>
            <div className="step-row">
              {pattern.steps.map((st, i) => {
                const on = euclidMask ? euclidMask[i] : st.on;
                const badge = condBadge(st.cond);
                return (
                  <button
                    key={i}
                    className={[
                      'step',
                      i % pattern.resolution === 0 ? 'beat' : '',
                      on ? 'on' : '',
                      selectedStep === i ? 'sel' : '',
                      on && i === playingStep ? 'playing' : '',
                    ].filter(Boolean).join(' ')}
                    style={on ? { background: track.color } : undefined}
                    onClick={(e) => {
                      if (e.shiftKey || euclidMask) { selectStep(i); return; }
                      toggleStep(track.id, patternIndex, i);
                      selectStep(i);
                    }}
                    onContextMenu={(e) => { e.preventDefault(); selectStep(i); }}
                    title={
                      euclidMask
                        ? 'Generated by the Euclidean rule — switch to Manual to edit hits'
                        : 'Click to toggle · shift-click to inspect'
                    }
                  >
                    <span className="step-index">{i + 1}</span>
                    {on && (
                      <span
                        className="step-fill"
                        style={{
                          height: `${clamp(st.velocity, 0, 1) * 100}%`,
                          background: 'rgba(255,255,255,0.22)',
                        }}
                      />
                    )}
                    {on && isPitched && (
                      <span className="step-label">{noteName(st.degree, st.octave)}</span>
                    )}
                    <span className="step-badges">
                      {st.ratchet > 1 && <span className="badge ratchet">×{st.ratchet}</span>}
                      {badge && <span className="badge cond">{badge}</span>}
                      {st.nudge !== 0 && <span className="badge">{st.nudge > 0 ? '▸' : '◂'}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="grid-2">
        {/* ---- pattern settings ----------------------------------------- */}
        <div className="panel">
          <div className="panel-head"><span className="panel-title">Pattern</span></div>
          <div className="panel-body col">
            <div className="row">
              <span className="dim" style={{ fontSize: 10, width: 66 }}>MODE</span>
              <Seg
                value={pattern.mode}
                options={[
                  { value: 'manual' as const, label: 'Manual' },
                  { value: 'euclid' as const, label: 'Euclidean' },
                ]}
                onChange={(v) => updatePattern(track.id, patternIndex, { mode: v })}
              />
            </div>

            <Slider
              label="Length" min={1} max={64} step={1} value={pattern.length}
              onChange={(v) => updatePattern(track.id, patternIndex, { length: v })}
              format={(v) => `${v} st`}
            />
            <div className="row">
              <span className="dim" style={{ fontSize: 10, width: 66 }}>GRID</span>
              <Seg
                value={pattern.resolution}
                options={[
                  { value: 2, label: '1/8' },
                  { value: 3, label: '1/8T' },
                  { value: 4, label: '1/16' },
                  { value: 6, label: '1/16T' },
                  { value: 8, label: '1/32' },
                ]}
                onChange={(v) => updatePattern(track.id, patternIndex, { resolution: v })}
              />
            </div>

            {pattern.mode === 'euclid' && (
              <>
                <div className="hint" style={{ marginTop: 4 }}>
                  Spreads <strong>{pattern.euclid.pulses}</strong> hits across{' '}
                  <strong>{pattern.length}</strong> steps as evenly as arithmetic allows.
                  E(3,8) is the tresillo; E(5,8) the cinquillo; E(7,16) a samba.
                </div>
                <Slider
                  label="Pulses" min={0} max={pattern.length} step={1} value={pattern.euclid.pulses}
                  onChange={(v) => updatePattern(track.id, patternIndex, {
                    euclid: { ...pattern.euclid, pulses: v },
                  })}
                  format={(v) => `${v}`}
                />
                <Slider
                  label="Rotate" min={0} max={Math.max(1, pattern.length - 1)} step={1}
                  value={pattern.euclid.rotation}
                  onChange={(v) => updatePattern(track.id, patternIndex, {
                    euclid: { ...pattern.euclid, rotation: v },
                  })}
                  format={(v) => `${v}`}
                />
                <div className="row">
                  <button
                    className={`chip-btn ${pattern.euclid.invert ? 'on' : ''}`}
                    onClick={() => updatePattern(track.id, patternIndex, {
                      euclid: { ...pattern.euclid, invert: !pattern.euclid.invert },
                    })}
                    title="Play the rests instead of the onsets"
                  >
                    Invert
                  </button>
                  <span className="hint">
                    E({pattern.euclid.pulses},{pattern.length})
                    {pattern.euclid.rotation ? ` rot ${pattern.euclid.rotation}` : ''}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ---- step inspector -------------------------------------------- */}
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">
              Step {selectedStep !== null ? selectedStep + 1 : '—'}
            </span>
            {step && (
              <button className="chip-btn" onClick={() => selectStep(null)}>Close</button>
            )}
          </div>
          <div className="panel-body">
            {!step ? (
              <div className="hint">
                Click a step to edit it. Shift-click inspects without toggling.
              </div>
            ) : (
              <div className="col">
                <div className="controls">
                  <Knob
                    label="Velocity" value={step.velocity} min={0} max={1}
                    color={track.color}
                    onChange={(v) => updateStep(track.id, patternIndex, selectedStep!, { velocity: v })}
                    format={(v) => `${Math.round(v * 100)}`}
                  />
                  {isPitched && (
                    <>
                      <Knob
                        label="Degree" value={step.degree} min={-7} max={14} step={1} bipolar
                        color={track.color}
                        onChange={(v) => updateStep(track.id, patternIndex, selectedStep!, { degree: v })}
                        format={(v) => noteName(v, step.octave)}
                      />
                      <Knob
                        label="Octave" value={step.octave} min={-3} max={3} step={1} bipolar
                        color={track.color}
                        onChange={(v) => updateStep(track.id, patternIndex, selectedStep!, { octave: v })}
                        format={(v) => (v > 0 ? `+${v}` : `${v}`)}
                      />
                      <Knob
                        label="Length" value={step.length} min={1} max={16} step={1}
                        color={track.color}
                        onChange={(v) => updateStep(track.id, patternIndex, selectedStep!, { length: v })}
                        format={(v) => `${v}`}
                      />
                    </>
                  )}
                  <Knob
                    label="Ratchet" value={step.ratchet} min={1} max={8} step={1}
                    color="var(--good)"
                    onChange={(v) => updateStep(track.id, patternIndex, selectedStep!, { ratchet: v })}
                    format={(v) => `×${v}`}
                  />
                  <Knob
                    label="Nudge" value={step.nudge} min={-0.5} max={0.5} bipolar
                    color="var(--warm)"
                    onChange={(v) => updateStep(track.id, patternIndex, selectedStep!, { nudge: v })}
                    format={(v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`}
                  />
                </div>

                <div className="row">
                  <span className="dim" style={{ fontSize: 10, width: 66 }}>CONDITION</span>
                  <select
                    className="select grow"
                    value={condKey(step.cond)}
                    onChange={(e) => {
                      const found = CONDITIONS.find((c) => c.value === e.target.value);
                      if (found) {
                        updateStep(track.id, patternIndex, selectedStep!, { cond: found.cond });
                      }
                    }}
                  >
                    {CONDITIONS.map((c) => (
                      <option key={c.value} value={c.value}>{c.label} — {c.hint}</option>
                    ))}
                  </select>
                </div>

                <div className="row">
                  <button
                    className={`chip-btn ${step.accent ? 'on' : ''}`}
                    onClick={() => updateStep(track.id, patternIndex, selectedStep!, { accent: !step.accent })}
                  >
                    Accent
                  </button>
                  {isPitched && (
                    <button
                      className={`chip-btn ${step.slide ? 'on' : ''}`}
                      onClick={() => updateStep(track.id, patternIndex, selectedStep!, { slide: !step.slide })}
                      title="Glide into this note (needs Glide above zero on the instrument)"
                    >
                      Slide
                    </button>
                  )}
                  {isPitched && (
                    <span className="hint">
                      {chordSymbol(project.key, step.degree, 3)} in key
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function OverviewRow({
  track, selected, tick, playing, onSelect,
}: {
  track: Track; selected: boolean; tick: number; playing: boolean; onSelect: () => void;
}) {
  const pattern = track.patterns[track.activePattern];
  if (!pattern) return null;
  const mask = pattern.mode === 'euclid' ? euclidPattern(pattern.euclid, pattern.length) : null;
  const cur = playing ? stepAt(tick, pattern.length, pattern.resolution) : -1;

  return (
    <div
      className="row"
      style={{ gap: 6, cursor: 'pointer', opacity: track.seqEnabled ? 1 : 0.4 }}
      onClick={onSelect}
    >
      <div
        style={{
          width: 62, fontSize: 9.5, fontWeight: 600,
          color: selected ? track.color : 'var(--text-dimmer)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {track.name}
      </div>
      <div style={{ display: 'flex', gap: 2, flex: 1, minWidth: 0 }}>
        {pattern.steps.map((st, i) => {
          const on = mask ? mask[i] : st.on;
          return (
            <div
              key={i}
              style={{
                flex: 1, minWidth: 2, height: 11, borderRadius: 2,
                background: on ? track.color : 'var(--panel-2)',
                opacity: on ? 0.35 + st.velocity * 0.65 : 1,
                outline: i === cur ? `1px solid ${on ? '#fff' : 'var(--border-2)'}` : 'none',
                transition: 'outline 0.04s',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
