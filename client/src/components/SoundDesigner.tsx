import type { DrumEngine, SynthEngine } from '@shared/types';
import { useStore } from '../state/store';
import { DRUM_ENGINES } from '../audio/drums';
import { SYNTH_ENGINES } from '../audio/synth';
import { Knob, Seg, Slider } from './controls';

const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);
const ms = (v: number) => (v >= 1 ? `${v.toFixed(2)}s` : `${Math.round(v * 1000)}ms`);
const pct = (v: number) => `${Math.round(v * 100)}`;

export function SoundDesigner() {
  const project = useStore((s) => s.project);
  const trackId = useStore((s) => s.selectedTrackId);
  const updateInstrument = useStore((s) => s.updateInstrument);
  const updateDrumParam = useStore((s) => s.updateDrumParam);
  const updateSynthParam = useStore((s) => s.updateSynthParam);
  const updateTrack = useStore((s) => s.updateTrack);
  const getStudio = useStore((s) => s.getStudio);
  const initAudio = useStore((s) => s.initAudio);

  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return <div className="panel"><div className="panel-body hint">No track selected.</div></div>;

  const inst = track.instrument;
  const isDrum = inst.kind === 'drum';

  const audition = async () => {
    const studio = getStudio() ?? await initAudio();
    const t = studio.engine.currentTime + 0.02;
    if (isDrum) {
      studio.engine.hitDrum(track.id, inst.engine as DrumEngine, inst.drum, t, 1, 0);
    } else {
      studio.transport.playTrackNow(track, t, 0.95, 0, 0, 0.7);
    }
  };

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title" style={{ color: track.color }}>{track.name}</span>
          <input
            className="name-input"
            value={track.name}
            onChange={(e) => updateTrack(track.id, { name: e.target.value })}
          />
          <Seg
            value={inst.kind}
            options={[
              { value: 'drum' as const, label: 'Drum' },
              { value: 'synth' as const, label: 'Synth' },
            ]}
            onChange={(kind) =>
              updateInstrument(track.id, {
                kind,
                engine: kind === 'drum' ? 'kick' : 'supersaw',
              })
            }
          />
          <div className="grow" />
          <button className="chip-btn" onClick={() => void audition()}>▶ Audition</button>
        </div>

        <div className="panel-body col">
          <div className="row wrap">
            <span className="dim" style={{ fontSize: 10, width: 66 }}>ENGINE</span>
            <Seg
              value={inst.engine}
              options={(isDrum ? DRUM_ENGINES : SYNTH_ENGINES).map((e) => ({
                value: e as DrumEngine | SynthEngine,
                label: e,
              }))}
              onChange={(engine) => updateInstrument(track.id, { engine })}
            />
          </div>

          {isDrum ? <DrumControls trackId={track.id} /> : <SynthControls trackId={track.id} />}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><span className="panel-title">Channel</span></div>
        <div className="panel-body">
          <div className="controls">
            <Knob label="Level" value={track.mixer.gain} min={0} max={1.5} color={track.color}
              onChange={(v) => useStore.getState().updateMixer(track.id, { gain: v })} format={pct} />
            <Knob label="Pan" value={track.mixer.pan} min={-1} max={1} bipolar color={track.color}
              onChange={(v) => useStore.getState().updateMixer(track.id, { pan: v })}
              format={(v) => (Math.abs(v) < 0.02 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`)} />
            <Knob label="Reverb" value={track.mixer.reverb} min={0} max={1} color="var(--accent-2)"
              onChange={(v) => useStore.getState().updateMixer(track.id, { reverb: v })} format={pct} />
            <Knob label="Delay" value={track.mixer.delay} min={0} max={1} color="var(--accent-2)"
              onChange={(v) => useStore.getState().updateMixer(track.id, { delay: v })} format={pct} />
            <Knob label="Sidechain" value={track.mixer.duck} min={0} max={1} color="var(--warm)"
              onChange={(v) => useStore.getState().updateMixer(track.id, { duck: v })} format={pct} />
          </div>
          <div className="hint" style={{ marginTop: 10 }}>
            Sidechain depth is how far this channel ducks each time{' '}
            <strong>
              {project.tracks.find((t) => t.id === project.master.sidechainSource)?.name ?? 'the source track'}
            </strong>{' '}
            fires. The duck is scheduled at the same instant as the hit, so it locks to the grid exactly.
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function DrumControls({ trackId }: { trackId: string }) {
  const track = useStore((s) => s.project.tracks.find((t) => t.id === trackId))!;
  const set = useStore((s) => s.updateDrumParam);
  const d = track.instrument.drum;
  const engine = track.instrument.engine as DrumEngine;

  const isTonal = engine === 'kick' || engine === 'tom' || engine === 'snare';
  const isMetal = engine === 'hat' || engine === 'cymbal';

  return (
    <div className="controls">
      <Knob
        label={isMetal ? 'Metal base' : 'Tune'}
        value={d.tune} min={20} max={isMetal ? 2000 : 1200} log color={track.color}
        onChange={(v) => set(trackId, 'tune', v)} format={hz}
      />
      <Knob label="Decay" value={d.decay} min={0.01} max={3} log color={track.color}
        onChange={(v) => set(trackId, 'decay', v)} format={ms} />
      {isTonal && (
        <>
          <Knob label="Punch" value={d.pitchMod} min={0} max={48} color="var(--hot)"
            onChange={(v) => set(trackId, 'pitchMod', v)} format={(v) => `${Math.round(v)}st`} />
          <Knob label="Punch time" value={d.pitchTime} min={0.002} max={0.4} log color="var(--hot)"
            onChange={(v) => set(trackId, 'pitchTime', v)} format={ms} />
        </>
      )}
      <Knob label="Noise" value={d.noise} min={0} max={1} color="var(--warm)"
        onChange={(v) => set(trackId, 'noise', v)} format={pct} />
      <Knob label="Snap" value={d.snap} min={0} max={1} color="var(--warm)"
        onChange={(v) => set(trackId, 'snap', v)} format={pct} />
      <Knob label="Cutoff" value={d.cutoff} min={60} max={20000} log color="var(--accent)"
        onChange={(v) => set(trackId, 'cutoff', v)} format={hz} />
      <Knob label="Reso" value={d.resonance} min={0.1} max={18} color="var(--accent)"
        onChange={(v) => set(trackId, 'resonance', v)} format={(v) => v.toFixed(1)} />
      <Knob label="Drive" value={d.drive} min={0} max={1} color="var(--accent-2)"
        onChange={(v) => set(trackId, 'drive', v)} format={pct} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function SynthControls({ trackId }: { trackId: string }) {
  const track = useStore((s) => s.project.tracks.find((t) => t.id === trackId))!;
  const set = useStore((s) => s.updateSynthParam);
  const p = track.instrument.synth;
  const engine = track.instrument.engine as SynthEngine;
  const isFM = engine === 'fm';
  const isUnison = engine !== 'sub' && engine !== 'fm';

  return (
    <div className="col">
      <div className="controls">
        {isUnison && (
          <>
            <Knob label="Voices" value={p.voices} min={1} max={9} step={1} color={track.color}
              onChange={(v) => set(trackId, 'voices', v)} format={(v) => `${Math.round(v)}`} />
            <Knob label="Detune" value={p.detune} min={0} max={1} color={track.color}
              onChange={(v) => set(trackId, 'detune', v)} format={pct} />
            <Knob label="Spread" value={p.spread} min={0} max={1} color={track.color}
              onChange={(v) => set(trackId, 'spread', v)} format={pct} />
          </>
        )}
        {isFM && (
          <>
            <Knob label="FM ratio" value={p.fmRatio} min={0.25} max={16} step={0.25} color={track.color}
              onChange={(v) => set(trackId, 'fmRatio', v)} format={(v) => `${v}:1`} />
            <Knob label="FM index" value={p.fmIndex} min={0} max={16} color={track.color}
              onChange={(v) => set(trackId, 'fmIndex', v)} format={(v) => v.toFixed(1)} />
          </>
        )}
        <Knob label="Octave" value={p.octave} min={-3} max={3} step={1} bipolar color={track.color}
          onChange={(v) => set(trackId, 'octave', v)} format={(v) => (v > 0 ? `+${v}` : `${v}`)} />
        <Knob label="Sub" value={p.sub} min={0} max={1} color="var(--hot)"
          onChange={(v) => set(trackId, 'sub', v)} format={pct} />
        <Knob label="Glide" value={p.glide} min={0} max={0.5} log={false} color="var(--warm)"
          onChange={(v) => set(trackId, 'glide', v)} format={ms} />
        <Knob label="Drive" value={p.drive} min={0} max={1} color="var(--accent-2)"
          onChange={(v) => set(trackId, 'drive', v)} format={pct} />
      </div>

      {isUnison && (
        <div className="hint">
          Detune follows the JP-8000's measured response — an 11th-order polynomial that is
          nearly flat near zero and opens sharply at the top. That non-linearity is what makes
          a supersaw sound like a supersaw rather than seven saws.
        </div>
      )}

      <div className="grid-2">
        <div>
          <div className="panel-title" style={{ marginBottom: 8 }}>Filter</div>
          <div className="row" style={{ marginBottom: 8 }}>
            <Seg
              value={p.filterType}
              options={[
                { value: 'lowpass' as const, label: 'LP' },
                { value: 'highpass' as const, label: 'HP' },
                { value: 'bandpass' as const, label: 'BP' },
                { value: 'notch' as const, label: 'Notch' },
              ]}
              onChange={(v) => set(trackId, 'filterType', v)}
            />
          </div>
          <div className="controls">
            <Knob label="Cutoff" value={p.cutoff} min={30} max={20000} log color="var(--accent)"
              onChange={(v) => set(trackId, 'cutoff', v)} format={hz} />
            <Knob label="Reso" value={p.resonance} min={0.1} max={28} color="var(--accent)"
              onChange={(v) => set(trackId, 'resonance', v)} format={(v) => v.toFixed(1)} />
            <Knob label="Env amt" value={p.filterEnv} min={-4} max={5} bipolar color="var(--accent)"
              onChange={(v) => set(trackId, 'filterEnv', v)} format={(v) => `${v.toFixed(1)}oct`} />
            <Knob label="Key track" value={p.keyTrack} min={0} max={1} color="var(--accent)"
              onChange={(v) => set(trackId, 'keyTrack', v)} format={pct} />
          </div>
        </div>

        <div>
          <div className="panel-title" style={{ marginBottom: 8 }}>Envelopes</div>
          <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
            <EnvBlock label="Amp" prefix="amp" trackId={trackId} env={p.amp} color={track.color} />
            <EnvBlock label="Filter" prefix="filt" trackId={trackId} env={p.filt} color="var(--accent)" />
          </div>
        </div>
      </div>
    </div>
  );
}

function EnvBlock({
  label, prefix, trackId, env, color,
}: {
  label: string; prefix: 'amp' | 'filt'; trackId: string;
  env: { attack: number; decay: number; sustain: number; release: number };
  color: string;
}) {
  const set = useStore((s) => s.updateSynthParam);
  return (
    <div className="grow">
      <div className="dim" style={{ fontSize: 9.5, marginBottom: 5, letterSpacing: '0.07em' }}>
        {label.toUpperCase()}
      </div>
      <Slider label="A" min={0.001} max={3} step={0.001} value={env.attack} format={ms}
        onChange={(v) => set(trackId, `${prefix}.attack`, v)} />
      <Slider label="D" min={0.005} max={4} step={0.005} value={env.decay} format={ms}
        onChange={(v) => set(trackId, `${prefix}.decay`, v)} />
      <Slider label="S" min={0} max={1} step={0.01} value={env.sustain} format={pct}
        onChange={(v) => set(trackId, `${prefix}.sustain`, v)} />
      <Slider label="R" min={0.005} max={5} step={0.005} value={env.release} format={ms}
        onChange={(v) => set(trackId, `${prefix}.release`, v)} />
    </div>
  );
}
