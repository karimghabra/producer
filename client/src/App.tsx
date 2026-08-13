import { useEffect, useState } from 'react';
import { useStore } from './state/store';
import { useKeyboard } from './lib/useKeyboard';
import { TopBar } from './components/TopBar';
import { TrackRail } from './components/TrackRail';
import { StepEditor } from './components/StepEditor';
import { SoundDesigner } from './components/SoundDesigner';
import { MixerView } from './components/MixerView';
import { MapEditor } from './components/MapEditor';
import { BrowserView } from './components/BrowserView';
import { SceneStrip } from './components/SceneStrip';
import { PadGrid } from './components/PadGrid';

export default function App() {
  const view = useStore((s) => s.view);
  const audioReady = useStore((s) => s.audioReady);
  const initAudio = useStore((s) => s.initAudio);
  const loadList = useStore((s) => s.loadProjectList);
  const [dismissed, setDismissed] = useState(false);

  useKeyboard();

  useEffect(() => { void loadList(); }, [loadList]);

  const begin = async () => {
    await initAudio();
    setDismissed(true);
  };

  return (
    <div className="app">
      <TopBar />

      <div className="workspace">
        <TrackRail />
        <div className="main-col">
          <div className="main-view">
            {view === 'steps' && <StepEditor />}
            {view === 'sound' && <SoundDesigner />}
            {view === 'mixer' && <MixerView />}
            {view === 'map' && <MapEditor />}
            {view === 'browser' && <BrowserView />}
          </div>
          <SceneStrip />
        </div>
      </div>

      <PadGrid />

      {!audioReady && !dismissed && (
        <div className="overlay" onClick={() => void begin()}>
          <div className="splash">
            <h1>Pulse</h1>
            <p>
              An EDM studio you play rather than draw. Every drum and synth here is generated
              from maths — no samples, nothing to download. Your keyboard is the instrument:
              forty keys across four layers, firing hits, chords, rolls, clips and effects.
            </p>
            <p style={{ fontSize: 12 }}>
              Browsers will not make sound until you interact with the page, so:
            </p>
            <button className="big-btn" onClick={(e) => { e.stopPropagation(); void begin(); }}>
              Start the audio engine
            </button>
            <div className="kbd-legend" style={{ justifyContent: 'center', marginTop: 22 }}>
              <span><kbd>Space</kbd>play</span>
              <span><kbd>A</kbd>–<kbd>L</kbd>drums</span>
              <span><kbd>Q</kbd>–<kbd>P</kbd>rolls</span>
              <span><kbd>F2</kbd>melody</span>
              <span><kbd>Tab</kbd>fill</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
