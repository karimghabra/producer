import { useStore } from '../state/store';
import { polymeterCycle } from '@shared/theory';

export function TrackRail() {
  const tracks = useStore((s) => s.project.tracks);
  const selected = useStore((s) => s.selectedTrackId);
  const recArmed = useStore((s) => s.recordArmed);
  const selectTrack = useStore((s) => s.selectTrack);
  const updateMixer = useStore((s) => s.updateMixer);
  const updateTrack = useStore((s) => s.updateTrack);
  const toggleRecordArm = useStore((s) => s.toggleRecordArm);
  const addTrack = useStore((s) => s.addTrack);

  // How long before every track's pattern lines up again — the real loop
  // length once polymeter is in play.
  const cycle = polymeterCycle(
    tracks.filter((t) => t.seqEnabled).map((t) => t.patterns[t.activePattern]?.length ?? 16),
  );
  const anyPoly = new Set(
    tracks.map((t) => t.patterns[t.activePattern]?.length ?? 16),
  ).size > 1;

  return (
    <aside className="rail">
      <div className="rail-head">
        <span>Tracks · {tracks.length}</span>
        {anyPoly && (
          <span title="Steps before all patterns realign (lowest common multiple)">
            cycle {cycle}
          </span>
        )}
      </div>

      {tracks.map((track) => {
        const pattern = track.patterns[track.activePattern];
        const armed = recArmed.includes(track.id);
        return (
          <div
            key={track.id}
            className={`track-row ${selected === track.id ? 'sel' : ''}`}
            onClick={() => selectTrack(track.id)}
          >
            <div className="track-swatch" style={{ background: track.color }} />
            <div className="track-meta">
              <div className="track-name" style={{ color: selected === track.id ? track.color : undefined }}>
                {track.name}
              </div>
              <div className="track-sub">
                <span>{track.instrument.engine}</span>
                <span>·</span>
                <span className={pattern ? 'lit' : ''}>{pattern?.name ?? '—'}</span>
                <span>·</span>
                <span>{pattern?.length ?? 0}</span>
                {pattern?.mode === 'euclid' && <span className="lit">E</span>}
                {!track.seqEnabled && <span style={{ color: 'var(--hot)' }}>OFF</span>}
                {track.queuedPattern !== null && (
                  <span style={{ color: 'var(--warm)' }} title="Queued for the next bar">
                    →{track.queuedPattern < 0 ? 'STOP' : track.patterns[track.queuedPattern]?.name}
                  </span>
                )}
              </div>
            </div>
            <div className="track-btns" onClick={(e) => e.stopPropagation()}>
              <button
                className={`mini r ${armed ? 'on' : ''}`}
                onClick={() => toggleRecordArm(track.id)}
                title="Arm for live recording — played notes are written into the pattern"
              >
                ●
              </button>
              <button
                className={`mini m ${track.mixer.mute ? 'on' : ''}`}
                onClick={() => updateMixer(track.id, { mute: !track.mixer.mute })}
                title="Mute"
              >
                M
              </button>
              <button
                className={`mini s ${track.mixer.solo ? 'on' : ''}`}
                onClick={() => updateMixer(track.id, { solo: !track.mixer.solo })}
                title="Solo"
              >
                S
              </button>
              <button
                className={`mini ${track.seqEnabled ? '' : 'on'}`}
                onClick={() => updateTrack(track.id, { seqEnabled: !track.seqEnabled })}
                title="Sequencer on/off — the track stays playable by hand either way"
                style={track.seqEnabled ? undefined : { background: 'var(--hot)', color: '#fff' }}
              >
                ▦
              </button>
            </div>
          </div>
        );
      })}

      <div className="rail-foot">
        <button className="wide-btn" onClick={addTrack}>+ Add track</button>
      </div>
    </aside>
  );
}
