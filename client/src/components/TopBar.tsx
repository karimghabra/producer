import { useEffect, useRef, useState } from 'react';
import { NOTE_NAMES, SCALES, type ScaleName } from '@shared/types';
import { useStore, type MainView } from '../state/store';
import { usePlayhead } from '../lib/usePlayhead';
import { Scope, Meter } from './controls';

const VIEWS: Array<{ id: MainView; label: string }> = [
  { id: 'steps', label: 'SEQUENCE' },
  { id: 'sound', label: 'SOUND' },
  { id: 'mixer', label: 'MIX' },
  { id: 'map', label: 'KEY MAP' },
  { id: 'browser', label: 'FILES' },
];

function Icon({ name }: { name: 'play' | 'stop' | 'fill' | 'panic' }) {
  const common = { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'currentColor' };
  switch (name) {
    case 'play': return <svg {...common}><path d="M4 2.5v11l9-5.5z" /></svg>;
    case 'stop': return <svg {...common}><rect x="3.5" y="3.5" width="9" height="9" rx="1.2" /></svg>;
    case 'fill': return <svg {...common}><path d="M9 1 3 9h3.5L6 15l6-8H8.5z" /></svg>;
    case 'panic': return <svg {...common}><path d="M8 1.5 15 14H1zM7.2 5.8h1.6v4H7.2zm0 5.2h1.6v1.6H7.2z" /></svg>;
  }
}

/**
 * Watches for an audio context that will not start. Without this, a machine
 * with no working output silently does nothing and the app looks broken.
 */
function AudioWarning() {
  const audioReady = useStore((s) => s.audioReady);
  const [suspended, setSuspended] = useState(false);

  useEffect(() => {
    if (!audioReady) return;
    const id = window.setInterval(() => {
      const studio = useStore.getState().getStudio();
      setSuspended(!!studio && studio.engine.state !== 'running');
    }, 1000);
    return () => window.clearInterval(id);
  }, [audioReady]);

  if (!suspended) return null;
  return (
    <span
      className="save-chip error"
      title="The browser has not started the audio device. Click anywhere on the page, and check that an output device is available."
      onClick={() => void useStore.getState().getStudio()?.engine.resume()}
    >
      audio asleep
    </span>
  );
}

export function TopBar() {
  const project = useStore((s) => s.project);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const playing = useStore((s) => s.playing);
  const fill = useStore((s) => s.fill);
  const saveState = useStore((s) => s.saveState);
  const togglePlay = useStore((s) => s.togglePlay);
  const setBpm = useStore((s) => s.setBpm);
  const setSwing = useStore((s) => s.setSwing);
  const setKey = useStore((s) => s.setKey);
  const setFill = useStore((s) => s.setFill);
  const panic = useStore((s) => s.panic);
  const rename = useStore((s) => s.renameProject);
  const saveProject = useStore((s) => s.saveProject);

  const head = usePlayhead();
  const taps = useRef<number[]>([]);
  const [bpmText, setBpmText] = useState<string | null>(null);

  /** Tap tempo: average the last few gaps, discarding anything implausible. */
  const tap = () => {
    const now = performance.now();
    const t = taps.current;
    if (t.length && now - t[t.length - 1] > 2200) t.length = 0;
    t.push(now);
    if (t.length > 5) t.shift();
    if (t.length < 2) return;
    const gaps: number[] = [];
    for (let i = 1; i < t.length; i++) gaps.push(t[i] - t[i - 1]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (mean > 120 && mean < 2000) setBpm(60000 / mean);
  };

  const commitBpm = () => {
    if (bpmText !== null) {
      const n = Number(bpmText);
      if (Number.isFinite(n)) setBpm(n);
      setBpmText(null);
    }
  };

  return (
    <header className="topbar">
      <div className="brand">
        <svg width="19" height="19" viewBox="0 0 32 32" aria-hidden>
          <path
            d="M3 16h4l3.5-10L15 26l4-14 2.6 4H29"
            stroke="currentColor" strokeWidth="2.6" fill="none"
            strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
        PULSE
      </div>

      <div className="transport">
        <button
          className={`tbtn ${playing ? 'on' : ''}`}
          onClick={() => void togglePlay()}
          title="Play / stop  (Space)"
        >
          <Icon name={playing ? 'stop' : 'play'} />
        </button>
        <button
          className={`tbtn fill ${fill ? 'on' : ''}`}
          onMouseDown={() => setFill(true)}
          onMouseUp={() => setFill(false)}
          onMouseLeave={() => fill && setFill(false)}
          title="Fill — hold to enable FILL trig conditions  (Tab)"
        >
          <Icon name="fill" />
        </button>
        <button className="tbtn" onClick={panic} title="Panic — kill all notes and effects  (Esc)">
          <Icon name="panic" />
        </button>
      </div>

      <div className="pos-readout" title="Bar . Beat . Sixteenth">
        {String(head.bar + 1).padStart(2, '0')}
        <span className="dim">.</span>{head.beat + 1}
        <span className="dim">.</span>{(head.sixteenth % 4) + 1}
      </div>

      <div className="field">
        <label>BPM</label>
        <input
          className="num-input"
          value={bpmText ?? project.bpm}
          onChange={(e) => setBpmText(e.target.value)}
          onBlur={commitBpm}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          title="Tempo — arrow keys nudge, shift+arrow by 5"
        />
        <button className="chip-btn" onClick={tap} title="Tap four times in time">TAP</button>
      </div>

      <div className="field" style={{ width: 118 }}>
        <label>SWING</label>
        <input
          type="range" min={0} max={1} step={0.01}
          value={project.swing}
          onChange={(e) => setSwing(Number(e.target.value))}
          title="0 = straight, 1 = full triplet shuffle"
        />
        <span className="mono" style={{ fontSize: 10, width: 26 }}>
          {Math.round(project.swing * 100)}
        </span>
      </div>

      <div className="field">
        <label>KEY</label>
        <select
          className="select"
          value={project.key.root}
          onChange={(e) => setKey({ root: Number(e.target.value) })}
        >
          {NOTE_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}
        </select>
        <select
          className="select"
          value={project.key.scale}
          onChange={(e) => setKey({ scale: e.target.value as ScaleName })}
        >
          {Object.keys(SCALES).map((s) => (
            <option key={s} value={s}>
              {s.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}
            </option>
          ))}
        </select>
      </div>

      <div className="spacer" />

      <AudioWarning />
      <Scope />
      <Meter />

      <div className="tabs">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            className={`tab ${view === v.id ? 'on' : ''}`}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>

      <input
        className="name-input"
        value={project.name}
        onChange={(e) => rename(e.target.value)}
        title="Project name"
      />
      <button
        className={`save-chip ${saveState}`}
        onClick={() => void saveProject()}
        title="Save now — autosaves after every change anyway"
      >
        {saveState === 'saving' ? 'saving' : saveState === 'saved' ? 'saved'
          : saveState === 'error' ? 'local only' : 'save'}
      </button>
    </header>
  );
}
