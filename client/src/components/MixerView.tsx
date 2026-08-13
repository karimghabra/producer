import { useStore } from '../state/store';
import { Knob, Seg, Slider } from './controls';

const pct = (v: number) => `${Math.round(v * 100)}`;
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);
const ms = (v: number) => (v >= 1 ? `${v.toFixed(2)}s` : `${Math.round(v * 1000)}ms`);

export function MixerView() {
  const project = useStore((s) => s.project);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const selectTrack = useStore((s) => s.selectTrack);
  const updateMixer = useStore((s) => s.updateMixer);
  const updateMaster = useStore((s) => s.updateMaster);
  const setNested = useStore((s) => s.updateMasterNested);
  const m = project.master;

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Channels</span>
          <span className="hint">Double-click any knob to reset it · hold shift while dragging for fine control</span>
        </div>
        <div className="panel-body">
          <div className="mixer-grid">
            {project.tracks.map((t) => (
              <div
                key={t.id}
                className={`strip ${selectedTrackId === t.id ? 'sel' : ''}`}
                onClick={() => selectTrack(t.id)}
              >
                <div className="strip-name" style={{ color: t.color }}>{t.name}</div>
                <div className="row" style={{ gap: 3 }}>
                  <button
                    className={`mini m ${t.mixer.mute ? 'on' : ''}`}
                    onClick={(e) => { e.stopPropagation(); updateMixer(t.id, { mute: !t.mixer.mute }); }}
                  >M</button>
                  <button
                    className={`mini s ${t.mixer.solo ? 'on' : ''}`}
                    onClick={(e) => { e.stopPropagation(); updateMixer(t.id, { solo: !t.mixer.solo }); }}
                  >S</button>
                  <div className="grow" />
                </div>
                <Knob label="Level" value={t.mixer.gain} min={0} max={1.5} color={t.color}
                  onChange={(v) => updateMixer(t.id, { gain: v })} format={pct} />
                <Knob label="Pan" value={t.mixer.pan} min={-1} max={1} bipolar color={t.color}
                  onChange={(v) => updateMixer(t.id, { pan: v })}
                  format={(v) => (Math.abs(v) < 0.02 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`)} />
                <div className="row" style={{ gap: 4 }}>
                  <div className="grow">
                    <Slider label="Rev" min={0} max={1} value={t.mixer.reverb} format={pct}
                      onChange={(v) => updateMixer(t.id, { reverb: v })} />
                    <Slider label="Dly" min={0} max={1} value={t.mixer.delay} format={pct}
                      onChange={(v) => updateMixer(t.id, { delay: v })} />
                    <Slider label="Duck" min={0} max={1} value={t.mixer.duck} format={pct}
                      onChange={(v) => updateMixer(t.id, { duck: v })} />
                  </div>
                </div>
                <div className="duck-bar" title={`Sidechain depth ${Math.round(t.mixer.duck * 100)}%`}>
                  <div className="duck-fill" style={{ width: `${t.mixer.duck * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-head"><span className="panel-title">Sidechain</span></div>
          <div className="panel-body col">
            <div className="row">
              <span className="dim" style={{ fontSize: 10, width: 66 }}>SOURCE</span>
              <select
                className="select grow"
                value={m.sidechainSource ?? ''}
                onChange={(e) => updateMaster({ sidechainSource: e.target.value || null })}
              >
                <option value="">— none —</option>
                {project.tracks.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <div className="controls">
              <Knob label="Attack" value={m.sidechainAttack} min={0.0005} max={0.08} log color="var(--warm)"
                onChange={(v) => updateMaster({ sidechainAttack: v })} format={ms} />
              <Knob label="Release" value={m.sidechainRelease} min={0.02} max={1.2} log color="var(--warm)"
                onChange={(v) => updateMaster({ sidechainRelease: v })} format={ms} />
              <Knob label="Curve" value={m.sidechainCurve} min={0.3} max={5} color="var(--warm)"
                onChange={(v) => updateMaster({ sidechainCurve: v })} format={(v) => v.toFixed(2)} />
            </div>
            <div className="hint">
              The recovery is <code>1 − a·(1 − x)^curve</code>. Above 1 the level hangs low then
              snaps back — the deep house pump. Below 1 it lifts immediately, which just tightens
              the low end. Depth is set per channel in the strips above.
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><span className="panel-title">Master</span></div>
          <div className="panel-body col">
            <div className="controls">
              <Knob label="Volume" value={m.gain} min={0} max={1.4} color="var(--good)"
                onChange={(v) => updateMaster({ gain: v })} format={pct} />
              <Knob label="Drive" value={m.drive} min={0} max={1} color="var(--accent-2)"
                onChange={(v) => updateMaster({ drive: v })} format={pct} />
              <Knob label="Cutoff" value={m.cutoff} min={100} max={20000} log color="var(--accent)"
                onChange={(v) => updateMaster({ cutoff: v })} format={hz} />
            </div>
            <div className="row">
              <button
                className={`chip-btn ${m.limiter ? 'on' : ''}`}
                onClick={() => updateMaster({ limiter: !m.limiter })}
                title="Catch peaks so heavy layering does not clip"
              >
                Limiter
              </button>
              <span className="hint">Bars per loop: used by the a:b trig conditions</span>
              <Seg
                value={project.barsPerLoop}
                options={[1, 2, 4, 8].map((n) => ({ value: n, label: `${n}` }))}
                onChange={(v) => {
                  useStore.setState((s) => ({
                    project: { ...s.project, barsPerLoop: v, updatedAt: Date.now() },
                  }));
                  useStore.getState().markDirty();
                }}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-head"><span className="panel-title">Reverb</span></div>
          <div className="panel-body col">
            <div className="controls">
              <Knob label="Size" value={m.reverb.size} min={0.2} max={9} log color="var(--accent-2)"
                onChange={(v) => setNested('reverb.size', v)} format={(v) => `${v.toFixed(1)}s`} />
              <Knob label="Damp" value={m.reverb.damp} min={0} max={1} color="var(--accent-2)"
                onChange={(v) => setNested('reverb.damp', v)} format={pct} />
              <Knob label="Predelay" value={m.reverb.predelay} min={0} max={0.2} color="var(--accent-2)"
                onChange={(v) => setNested('reverb.predelay', v)} format={ms} />
              <Knob label="Width" value={m.reverb.width} min={0} max={1} color="var(--accent-2)"
                onChange={(v) => setNested('reverb.width', v)} format={pct} />
              <Knob label="Return" value={m.reverb.mix} min={0} max={1.5} color="var(--accent-2)"
                onChange={(v) => setNested('reverb.mix', v)} format={pct} />
            </div>
            <div className="hint">
              The impulse response is generated, not sampled: decaying noise through a one-pole
              filter that darkens over time, with early reflections at prime-millisecond offsets
              so they never stack into a flutter. Changing size rebuilds it.
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><span className="panel-title">Delay</span></div>
          <div className="panel-body col">
            <div className="row">
              <span className="dim" style={{ fontSize: 10, width: 66 }}>TIME</span>
              <Seg
                value={m.delay.division}
                options={[
                  { value: 0.25, label: '1/16' },
                  { value: 1 / 3, label: '1/8T' },
                  { value: 0.5, label: '1/8' },
                  { value: 0.75, label: '1/8.' },
                  { value: 1, label: '1/4' },
                  { value: 1.5, label: '1/4.' },
                ]}
                onChange={(v) => setNested('delay.division', v)}
              />
            </div>
            <div className="controls">
              <Knob label="Feedback" value={m.delay.feedback} min={0} max={0.92} color="var(--accent)"
                onChange={(v) => setNested('delay.feedback', v)} format={pct} />
              <Knob label="Tone" value={m.delay.tone} min={200} max={16000} log color="var(--accent)"
                onChange={(v) => setNested('delay.tone', v)} format={hz} />
              <Knob label="Ping-pong" value={m.delay.pingpong} min={0} max={1} color="var(--accent)"
                onChange={(v) => setNested('delay.pingpong', v)} format={pct} />
              <Knob label="Return" value={m.delay.mix} min={0} max={1.5} color="var(--accent)"
                onChange={(v) => setNested('delay.mix', v)} format={pct} />
            </div>
            <div className="hint">
              Dotted eighth (1/8.) against a four-on-the-floor kick is the classic trance delay —
              the repeats land three-against-four and the pattern takes three bars to resolve.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
