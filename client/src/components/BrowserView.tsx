import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { useMidi } from '../lib/useMidi';
import { Slider } from './controls';

function when(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function BrowserView() {
  const project = useStore((s) => s.project);
  const projects = useStore((s) => s.projects);
  const lastError = useStore((s) => s.lastError);
  const loadList = useStore((s) => s.loadProjectList);
  const openProject = useStore((s) => s.openProject);
  const newProject = useStore((s) => s.newProject);
  const deleteProject = useStore((s) => s.deleteProject);
  const saveProject = useStore((s) => s.saveProject);
  const setHumanize = useStore((s) => s.setHumanize);
  const setSwingUnit = useStore((s) => s.setSwingUnit);

  const [snapMidi, setSnapMidi] = useState(true);
  const midi = useMidi(snapMidi);

  useEffect(() => { void loadList(); }, [loadList]);

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Projects</span>
          <div className="grow" />
          <button className="chip-btn" onClick={() => void saveProject()}>Save current</button>
          <button className="chip-btn" onClick={() => void newProject('Untitled')}>+ New</button>
        </div>
        <div className="panel-body">
          {lastError && (
            <div className="hint" style={{ color: 'var(--warm)', marginBottom: 10 }}>
              Server unreachable ({lastError}). Everything still works — your project is mirrored
              to this browser's local storage and will sync when the API comes back.
            </div>
          )}
          <div className="proj-list">
            {projects.length === 0 && (
              <div className="hint">No saved projects yet. The current one autosaves as you work.</div>
            )}
            {projects.map((p) => (
              <div key={p.id} className={`proj-row ${p.id === project.id ? 'cur' : ''}`}>
                <span className="proj-name">{p.name}</span>
                <span className="proj-meta">{Math.round(p.bpm)} BPM</span>
                <span className="proj-meta">{when(p.updatedAt)}</span>
                {p.id !== project.id && (
                  <button className="chip-btn" onClick={() => void openProject(p.id)}>Open</button>
                )}
                {p.id === project.id && <span className="chip-btn on">Current</span>}
                <button
                  className="chip-btn"
                  onClick={() => { if (confirm(`Delete "${p.name}"? This cannot be undone.`)) void deleteProject(p.id); }}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-head"><span className="panel-title">MIDI input</span></div>
          <div className="panel-body col">
            {!midi.supported && (
              <div className="hint">
                This browser does not expose Web MIDI. Chrome and Edge do; Firefox and Safari
                need it enabled. The computer keyboard works regardless.
              </div>
            )}
            {midi.supported && midi.inputs.length === 0 && (
              <div className="hint">No MIDI devices detected. Plug one in — it appears here automatically.</div>
            )}
            {midi.inputs.map((name) => (
              <div key={name} className="row">
                <span className="scene-dot" style={{ background: 'var(--good)' }} />
                <span>{name}</span>
              </div>
            ))}
            {midi.error && <div className="hint" style={{ color: 'var(--hot)' }}>{midi.error}</div>}
            <div className="row">
              <button
                className={`chip-btn ${snapMidi ? 'on' : ''}`}
                onClick={() => setSnapMidi(!snapMidi)}
              >
                Snap to key
              </button>
              <span className="hint">
                Pulls out-of-key notes to the nearest scale tone. MIDI plays whichever track is
                selected; the mod wheel sweeps the master filter.
              </span>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><span className="panel-title">Feel</span></div>
          <div className="panel-body col">
            <Slider
              label="Humanize" min={0} max={20} step={0.5} value={project.humanize}
              onChange={setHumanize} format={(v) => `${v.toFixed(1)}ms`}
            />
            <Slider
              label="Swing grp" min={2} max={8} step={2} value={project.swingUnit}
              onChange={setSwingUnit} format={(v) => `${v} steps`}
            />
            <div className="hint">
              Humanize is a hash of the step position, not a random number — the same step drifts
              the same way every time round the loop, which reads as a player's habit rather than
              a wobble. Set it to zero for machine-tight.
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><span className="panel-title">How to play</span></div>
        <div className="panel-body">
          <div className="grid-2">
            <div className="col" style={{ gap: 6 }}>
              <div className="hint"><strong style={{ color: 'var(--accent)' }}>Layers</strong> — the four rows of keys mean something different on each of the four layers. <code>F1</code>–<code>F4</code> lock a layer; holding <code>Ctrl</code> or <code>Alt</code> jumps to Clips or FX only while held, so you can fire a clip mid-phrase and drop straight back to drumming.</div>
              <div className="hint"><strong style={{ color: 'var(--hot)' }}>Rolls</strong> — the row above the drums retriggers while held. Rates go from eighths down to sixty-fourths, including triplets, and they snap to their own grid so a roll lands in time even if your finger did not.</div>
              <div className="hint"><strong style={{ color: 'var(--warm)' }}>Fill</strong> — hold <code>Tab</code> to switch on every step whose condition is FILL and silence every <code>!FILL</code> step. One key, and the bar rearranges itself.</div>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <div className="hint"><strong style={{ color: 'var(--accent-2)' }}>Euclidean patterns</strong> — set a pattern to Euclidean and it distributes N hits across its length as evenly as arithmetic allows. Rotating the result moves the emphasis without changing the density.</div>
              <div className="hint"><strong style={{ color: 'var(--good)' }}>Polymeter</strong> — give tracks different pattern lengths. A 16-step hat against a 12-step bass takes 48 steps to come back around, so a four-bar loop stops sounding like a four-bar loop.</div>
              <div className="hint"><strong>Conditions</strong> — <code>1:4</code> on a step means it only fires on the first of every four passes. A handful of those turns one pattern into an arrangement.</div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
