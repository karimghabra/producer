import { useStore } from '../state/store';

export function SceneStrip() {
  const scenes = useStore((s) => s.project.scenes);
  const launchScene = useStore((s) => s.launchScene);
  const captureScene = useStore((s) => s.captureScene);
  const addScene = useStore((s) => s.addScene);

  return (
    <div className="scene-strip">
      <span className="dim" style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
        Scenes
      </span>
      {scenes.map((scene) => (
        <button
          key={scene.id}
          className="scene"
          onClick={() => launchScene(scene.id)}
          onContextMenu={(e) => { e.preventDefault(); captureScene(scene.id); }}
          title="Click to launch · right-click to overwrite with the current clip selection"
        >
          <span className="scene-dot" />
          {scene.name}
        </button>
      ))}
      <button className="scene" onClick={addScene} style={{ borderStyle: 'dashed' }}>
        + Capture
      </button>
      <span className="hint" style={{ marginLeft: 4 }}>
        A scene sets every track's clip at once. Right-click one to overwrite it with what is
        playing now.
      </span>
    </div>
  );
}
