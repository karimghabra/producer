import { KEY_GRID, GRID_COLS, keyLabel, type Cell, type Project } from '@shared/types';
import { degreeToMidi, chordSymbol } from '@shared/theory';
import { NOTE_NAMES } from '@shared/types';
import { useStore } from '../state/store';

/** Colour per cell mode — the grid should be readable without reading it. */
export const MODE_COLOR: Record<Cell['mode'], string> = {
  hit: '#ff4d6d',
  note: '#4cc9f0',
  chord: '#c77dff',
  pattern: '#ffd166',
  scene: '#6ee7a8',
  repeat: '#ff9e6d',
  macro: '#b8c0ff',
  record: '#ff2d55',
  empty: 'transparent',
};

export function cellLabel(cell: Cell, project: Project): string {
  if (cell.label) return cell.label;
  const track = project.tracks.find((t) => t.id === cell.trackId);
  switch (cell.mode) {
    case 'hit': return track?.name ?? 'Hit';
    case 'note': {
      const midi = degreeToMidi(project.key, cell.degree, cell.octave, 4);
      return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
    }
    case 'chord': return chordSymbol(project.key, cell.degree, cell.chordSize);
    case 'pattern':
      return cell.patternIndex < 0
        ? `Stop ${track?.name ?? ''}`
        : `${track?.name ?? ''} ${track?.patterns[cell.patternIndex]?.name ?? cell.patternIndex + 1}`;
    case 'scene': return project.scenes.find((s) => s.id === cell.sceneId)?.name ?? 'Scene';
    case 'repeat': return `${track?.name ?? ''} ${cell.repeatRate}`;
    case 'macro': return cell.macro.replace(/([A-Z])/g, ' $1');
    case 'record': return `Rec ${track?.name ?? ''}`;
    default: return '';
  }
}

export function PadGrid() {
  const project = useStore((s) => s.project);
  const activeLayer = useStore((s) => s.activeLayer);
  const setLayer = useStore((s) => s.setLayer);
  const selectedCell = useStore((s) => s.selectedCell);
  const selectCell = useStore((s) => s.selectCell);
  const setView = useStore((s) => s.setView);
  const getStudio = useStore((s) => s.getStudio);
  const initAudio = useStore((s) => s.initAudio);
  // Re-render when a key is pressed or a clip launches.
  useStore((s) => s.revision);

  const studio = getStudio();
  const layer = project.keymap.layers[activeLayer] ?? [];

  const onPadDown = async (index: number, e: React.MouseEvent) => {
    if (e.shiftKey || e.button === 2) {
      selectCell(index);
      setView('map');
      return;
    }
    const s = studio ?? await initAudio();
    s.performer.press(activeLayer, index);
    useStore.setState((st) => ({ revision: st.revision + 1 }));
  };

  const onPadUp = (index: number) => {
    studio?.performer.release(activeLayer, index);
    useStore.setState((st) => ({ revision: st.revision + 1 }));
  };

  return (
    <section className="padzone">
      <div className="pad-head">
        <div className="layer-tabs">
          {project.keymap.layerNames.map((name, i) => (
            <button
              key={name}
              className={`layer-tab ${activeLayer === i ? 'on' : ''}`}
              onClick={() => setLayer(i)}
            >
              {name}
              <kbd>F{i + 1}</kbd>
            </button>
          ))}
        </div>

        <div className="kbd-legend grow" style={{ justifyContent: 'flex-end' }}>
          <span><kbd>Ctrl</kbd>hold → Clips</span>
          <span><kbd>Alt</kbd>hold → FX</span>
          <span><kbd>Shift</kbd>accent</span>
          <span><kbd>Tab</kbd>fill</span>
          <span><kbd>Space</kbd>play</span>
          <span><kbd>Esc</kbd>panic</span>
          <span className="dim">shift-click a pad to reassign</span>
        </div>
      </div>

      <div className="pad-grid">
        {KEY_GRID.map((row, r) => (
          <div className="pad-row" key={r}>
            {row.map((code, c) => {
              const index = r * GRID_COLS + c;
              const cell = layer[index];
              if (!cell) return <div className="pad" key={code} />;
              const id = `${activeLayer}:${index}`;
              const lit = studio?.performer.active.has(id) ?? false;
              const latched = studio?.performer.latched.has(id) ?? false;
              const track = project.tracks.find((t) => t.id === cell.trackId);
              const color = cell.mode === 'hit' && track ? track.color : MODE_COLOR[cell.mode];
              const assigned = cell.mode !== 'empty';

              return (
                <button
                  key={code}
                  className={[
                    'pad',
                    assigned ? 'assigned' : '',
                    lit ? 'lit' : '',
                    latched ? 'latched' : '',
                    selectedCell === index ? 'sel' : '',
                  ].filter(Boolean).join(' ')}
                  style={{
                    color,
                    background: lit ? color : undefined,
                    borderColor: assigned ? `${color}44` : undefined,
                  }}
                  onMouseDown={(e) => void onPadDown(index, e)}
                  onMouseUp={() => onPadUp(index)}
                  onMouseLeave={() => lit && onPadUp(index)}
                  onContextMenu={(e) => { e.preventDefault(); selectCell(index); setView('map'); }}
                  title={assigned ? `${cell.mode} · ${cell.behavior} · quantize ${cell.quantize}` : 'Unassigned — shift-click to set up'}
                >
                  {assigned && <span className="pad-mode" style={{ background: color }} />}
                  <span className="pad-key" style={lit ? { color: 'rgba(0,0,0,0.62)' } : undefined}>
                    {keyLabel(code)}
                  </span>
                  <span className="pad-name" style={lit ? { color: '#08111a' } : undefined}>
                    {cellLabel(cell, project)}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
