import type { Cell, CellMode, MacroKind, Quantize, RepeatRate } from '@shared/types';
import { GRID_COLS, KEY_GRID, keyLabel } from '@shared/types';
import { useStore } from '../state/store';
import { Knob, Seg, Slider } from './controls';
import { MODE_COLOR, cellLabel } from './PadGrid';

const MODES: Array<{ value: CellMode; label: string; blurb: string }> = [
  { value: 'hit', label: 'Hit', blurb: 'Fire the instrument once. The workhorse — this is drumming.' },
  { value: 'note', label: 'Note', blurb: 'A pitched note held for as long as the key is down, snapped to the key.' },
  { value: 'chord', label: 'Chord', blurb: 'Stacks scale thirds on a degree; the key decides major or minor for you.' },
  { value: 'repeat', label: 'Roll', blurb: 'Retriggers at a rhythmic rate while held, with optional velocity and pitch ramps.' },
  { value: 'pattern', label: 'Clip', blurb: 'Swaps a track to another pattern at the next quantize boundary.' },
  { value: 'scene', label: 'Scene', blurb: 'Swaps every track at once — a whole section change on one key.' },
  { value: 'macro', label: 'FX', blurb: 'A master-bus performance effect for as long as it is held.' },
  { value: 'record', label: 'Rec', blurb: 'Arms a track so what you play is written into its pattern.' },
  { value: 'empty', label: 'Empty', blurb: 'Nothing assigned.' },
];

const MACROS: Array<{ value: MacroKind; label: string }> = [
  { value: 'filterDown', label: 'Filter ↓' },
  { value: 'filterUp', label: 'Filter ↑' },
  { value: 'stutter', label: 'Stutter' },
  { value: 'reverse', label: 'Reverse' },
  { value: 'tapeStop', label: 'Tape stop' },
  { value: 'gate', label: 'Gate' },
  { value: 'crush', label: 'Crush' },
  { value: 'riser', label: 'Riser' },
  { value: 'dropout', label: 'Drop out' },
  { value: 'wash', label: 'Wash' },
];

const RATES: RepeatRate[] = ['1/4', '1/8', '1/8t', '1/16', '1/16t', '1/32', '1/32t', '1/64'];
const QUANTS: Quantize[] = ['off', '1/16', '1/8', '1/4', '1/2', '1bar', '2bar', '4bar'];

export function MapEditor() {
  const project = useStore((s) => s.project);
  const layer = useStore((s) => s.activeLayer);
  const setLayer = useStore((s) => s.setLayer);
  const selectedCell = useStore((s) => s.selectedCell);
  const selectCell = useStore((s) => s.selectCell);
  const updateCell = useStore((s) => s.updateCell);
  const clearCell = useStore((s) => s.clearCell);

  const cells = project.keymap.layers[layer] ?? [];
  const cell = selectedCell !== null ? cells[selectedCell] : null;
  const patch = (p: Partial<Cell>) => selectedCell !== null && updateCell(layer, selectedCell, p);

  /** Lay a scale across a whole row in one move. */
  const fillRowWithScale = (row: number, trackId: string, startDegree: number, octave: number) => {
    for (let c = 0; c < GRID_COLS; c++) {
      updateCell(layer, row * GRID_COLS + c, {
        mode: 'note', trackId, degree: startDegree + c, octave,
        behavior: 'gate', quantize: 'off', label: '',
      });
    }
  };

  const fillRowWithKit = (row: number) => {
    const drums = project.tracks.filter((t) => t.instrument.kind === 'drum');
    for (let c = 0; c < GRID_COLS; c++) {
      const t = drums[c % Math.max(1, drums.length)];
      if (!t) continue;
      updateCell(layer, row * GRID_COLS + c, {
        mode: 'hit', trackId: t.id, velocity: 0.95,
        behavior: 'trigger', quantize: 'off', label: '',
      });
    }
  };

  const fillRowWithClips = (row: number, patternIndex: number) => {
    project.tracks.slice(0, GRID_COLS).forEach((t, c) => {
      updateCell(layer, row * GRID_COLS + c, {
        mode: 'pattern', trackId: t.id, patternIndex,
        quantize: '1bar', behavior: 'trigger', label: '',
      });
    });
  };

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Key map</span>
          <div className="seg">
            {project.keymap.layerNames.map((n, i) => (
              <button key={n} className={layer === i ? 'on' : ''} onClick={() => setLayer(i)}>
                {i + 1}. {n}
              </button>
            ))}
          </div>
          <div className="grow" />
          <span className="hint">Click a key below to edit what it does</span>
        </div>
        <div className="panel-body">
          <div className="pad-grid">
            {KEY_GRID.map((row, r) => (
              <div className="pad-row" key={r}>
                {row.map((code, c) => {
                  const index = r * GRID_COLS + c;
                  const cl = cells[index];
                  if (!cl) return <div className="pad" key={code} />;
                  const track = project.tracks.find((t) => t.id === cl.trackId);
                  const color = cl.mode === 'hit' && track ? track.color : MODE_COLOR[cl.mode];
                  return (
                    <button
                      key={code}
                      className={`pad ${cl.mode !== 'empty' ? 'assigned' : ''} ${selectedCell === index ? 'sel' : ''}`}
                      style={{ color, borderColor: cl.mode !== 'empty' ? `${color}44` : undefined }}
                      onClick={() => selectCell(index)}
                    >
                      {cl.mode !== 'empty' && <span className="pad-mode" style={{ background: color }} />}
                      <span className="pad-key">{keyLabel(code)}</span>
                      <span className="pad-name">{cellLabel(cl, project)}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="row wrap" style={{ marginTop: 12 }}>
            <span className="dim" style={{ fontSize: 10 }}>QUICK FILL</span>
            {[0, 1, 2, 3].map((r) => (
              <div className="row" key={r} style={{ gap: 4 }}>
                <span className="hint">Row {r + 1}:</span>
                <button className="chip-btn" onClick={() => fillRowWithKit(r)}>Kit</button>
                <button
                  className="chip-btn"
                  onClick={() => {
                    const lead = project.tracks.find((t) => t.instrument.kind === 'synth');
                    if (lead) fillRowWithScale(r, lead.id, 0, 0);
                  }}
                >
                  Scale
                </button>
                <button className="chip-btn" onClick={() => fillRowWithClips(r, r)}>Clips</button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">
            {selectedCell !== null
              ? `Key ${keyLabel(KEY_GRID[Math.floor(selectedCell / GRID_COLS)][selectedCell % GRID_COLS])}`
              : 'No key selected'}
          </span>
          {cell && (
            <button className="chip-btn" onClick={() => clearCell(layer, selectedCell!)}>Clear</button>
          )}
        </div>
        <div className="panel-body">
          {!cell ? (
            <div className="hint">
              Pick a key above. Each of the four layers holds its own forty assignments, so the
              board carries 160 in total — and you switch between them without lifting your
              playing hand.
            </div>
          ) : (
            <div className="col">
              <div className="row wrap">
                <span className="dim" style={{ fontSize: 10, width: 66 }}>DOES</span>
                <Seg
                  value={cell.mode}
                  options={MODES.map((m) => ({ value: m.value, label: m.label }))}
                  onChange={(mode) => patch({ mode })}
                />
              </div>
              <div className="hint">{MODES.find((m) => m.value === cell.mode)?.blurb}</div>

              {['hit', 'note', 'chord', 'repeat', 'pattern', 'record'].includes(cell.mode) && (
                <div className="row">
                  <span className="dim" style={{ fontSize: 10, width: 66 }}>TRACK</span>
                  <select
                    className="select grow"
                    value={cell.trackId ?? ''}
                    onChange={(e) => patch({ trackId: e.target.value || null })}
                  >
                    <option value="">— pick a track —</option>
                    {project.tracks.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {['hit', 'note', 'chord'].includes(cell.mode) && (
                <div className="controls">
                  <Knob label="Velocity" value={cell.velocity} min={0} max={1.2}
                    onChange={(v) => patch({ velocity: v })} format={(v) => `${Math.round(v * 100)}`} />
                  <Knob label="Degree" value={cell.degree} min={-7} max={14} step={1} bipolar
                    onChange={(v) => patch({ degree: v })} format={(v) => `${v}`} />
                  <Knob label="Octave" value={cell.octave} min={-3} max={3} step={1} bipolar
                    onChange={(v) => patch({ octave: v })} format={(v) => (v > 0 ? `+${v}` : `${v}`)} />
                  {cell.mode === 'chord' && (
                    <>
                      <Knob label="Notes" value={cell.chordSize} min={2} max={6} step={1}
                        onChange={(v) => patch({ chordSize: v })} format={(v) => `${v}`} />
                      <Knob label="Inversion" value={cell.inversion} min={0} max={4} step={1}
                        onChange={(v) => patch({ inversion: v })} format={(v) => `${v}`} />
                    </>
                  )}
                </div>
              )}

              {cell.mode === 'repeat' && (
                <>
                  <div className="row wrap">
                    <span className="dim" style={{ fontSize: 10, width: 66 }}>RATE</span>
                    <Seg
                      value={cell.repeatRate}
                      options={RATES.map((r) => ({ value: r, label: r }))}
                      onChange={(repeatRate) => patch({ repeatRate })}
                    />
                  </div>
                  <div className="controls">
                    <Knob label="Velocity" value={cell.velocity} min={0} max={1.2}
                      onChange={(v) => patch({ velocity: v })} format={(v) => `${Math.round(v * 100)}`} />
                    <Knob label="Vel ramp" value={cell.repeatRamp} min={-1} max={1} bipolar color="var(--warm)"
                      onChange={(v) => patch({ repeatRamp: v })}
                      format={(v) => (v > 0.02 ? 'build' : v < -0.02 ? 'fade' : 'flat')} />
                    <Knob label="Pitch ramp" value={cell.repeatPitch} min={-24} max={24} step={1} bipolar color="var(--hot)"
                      onChange={(v) => patch({ repeatPitch: v })} format={(v) => `${v > 0 ? '+' : ''}${v}st`} />
                    <Knob label="Degree" value={cell.degree} min={-7} max={14} step={1} bipolar
                      onChange={(v) => patch({ degree: v })} format={(v) => `${v}`} />
                  </div>
                  <div className="hint">
                    A roll with pitch ramp <code>+12</code> and velocity ramp set to build is the
                    snare rush that ends every eight bars. Rolls snap to their own grid, so they
                    land with the beat wherever your finger actually was.
                  </div>
                </>
              )}

              {cell.mode === 'pattern' && (
                <div className="row wrap">
                  <span className="dim" style={{ fontSize: 10, width: 66 }}>CLIP</span>
                  <Seg
                    value={cell.patternIndex}
                    options={[
                      { value: -1, label: 'Stop' },
                      ...(project.tracks.find((t) => t.id === cell.trackId)?.patterns ?? [])
                        .map((p, i) => ({ value: i, label: p.name })),
                    ]}
                    onChange={(patternIndex) => patch({ patternIndex })}
                  />
                </div>
              )}

              {cell.mode === 'scene' && (
                <div className="row">
                  <span className="dim" style={{ fontSize: 10, width: 66 }}>SCENE</span>
                  <select
                    className="select grow"
                    value={cell.sceneId ?? ''}
                    onChange={(e) => patch({ sceneId: e.target.value || null })}
                  >
                    <option value="">— pick a scene —</option>
                    {project.scenes.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {cell.mode === 'macro' && (
                <>
                  <div className="row wrap">
                    <span className="dim" style={{ fontSize: 10, width: 66 }}>EFFECT</span>
                    <Seg
                      value={cell.macro}
                      options={MACROS}
                      onChange={(macro) => patch({ macro })}
                    />
                  </div>
                  <Slider
                    label="Amount" min={0} max={1} value={cell.macroAmount}
                    onChange={(v) => patch({ macroAmount: v })}
                    format={(v) => `${Math.round(v * 100)}%`}
                  />
                </>
              )}

              {cell.mode !== 'empty' && (
                <>
                  <div className="row wrap">
                    <span className="dim" style={{ fontSize: 10, width: 66 }}>WHEN</span>
                    <Seg
                      value={cell.quantize}
                      options={QUANTS.map((q) => ({ value: q, label: q }))}
                      onChange={(quantize) => patch({ quantize })}
                    />
                  </div>
                  <div className="row wrap">
                    <span className="dim" style={{ fontSize: 10, width: 66 }}>HOLD</span>
                    <Seg
                      value={cell.behavior}
                      options={[
                        { value: 'trigger' as const, label: 'One-shot' },
                        { value: 'gate' as const, label: 'While held' },
                        { value: 'toggle' as const, label: 'Latch' },
                      ]}
                      onChange={(behavior) => patch({ behavior })}
                    />
                  </div>
                  <div className="row">
                    <span className="dim" style={{ fontSize: 10, width: 66 }}>LABEL</span>
                    <input
                      className="num-input"
                      style={{ width: 180, textAlign: 'left' }}
                      value={cell.label}
                      placeholder={cellLabel({ ...cell, label: '' }, project)}
                      onChange={(e) => patch({ label: e.target.value })}
                    />
                  </div>
                  <div className="hint">
                    <strong>When</strong> delays the action to the next grid line — leave it off
                    for anything you play by hand, set it to a bar for clip and scene launches so
                    changes land in time.
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
