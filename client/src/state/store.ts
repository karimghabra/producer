/**
 * Application state.
 *
 * The project document is the single source of truth; the audio objects are
 * created lazily on the first user gesture (browsers will not start an
 * AudioContext before one) and are kept in sync by `syncAudio`.
 */

import { create } from 'zustand';
import type {
  Project, Track, Pattern, Step, Cell, Scene, MasterFx, TrackMixer,
  Instrument, ProjectSummary, KeyCenter,
} from '@shared/types';
import { createProject, makePattern, emptyStep, uid, emptyCell, defaultKeyMap } from '@shared/defaults';
import { clamp } from '@shared/theory';
import { AudioEngine } from '../audio/engine';
import { Transport } from '../audio/scheduler';
import { Performer, type PerformerAction } from '../audio/performer';
import * as api from '../lib/api';

export type MainView = 'steps' | 'sound' | 'mixer' | 'map' | 'browser';

interface Studio {
  engine: AudioEngine;
  transport: Transport;
  performer: Performer;
}

let studio: Studio | null = null;
let autosaveTimer: number | null = null;

export interface AppState {
  project: Project;
  // ---- ui ----
  view: MainView;
  selectedTrackId: string;
  selectedPatternIndex: number | null;
  activeLayer: number;
  layerLocked: boolean;
  selectedStep: number | null;
  selectedCell: number | null;
  audioReady: boolean;
  playing: boolean;
  fill: boolean;
  recordArmed: string[];
  /** Scene waiting on a quantize boundary, shown pulsing in the strip. */
  queuedScene: string | null;
  projects: ProjectSummary[];
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  lastError: string | null;
  /** Bumped whenever the sequencer launches a queued clip, to redraw the UI. */
  revision: number;

  // ---- lifecycle ----
  initAudio: () => Promise<Studio>;
  getStudio: () => Studio | null;
  syncAudio: () => void;

  // ---- transport ----
  togglePlay: () => Promise<void>;
  stop: () => void;
  setBpm: (bpm: number) => void;
  setSwing: (swing: number) => void;
  setSwingUnit: (unit: number) => void;
  setHumanize: (ms: number) => void;
  setKey: (key: Partial<KeyCenter>) => void;
  setFill: (on: boolean) => void;
  panic: () => void;

  // ---- ui ----
  setView: (v: MainView) => void;
  selectTrack: (id: string) => void;
  selectPattern: (index: number | null) => void;
  setLayer: (n: number) => void;
  toggleLayerLock: () => void;
  selectStep: (i: number | null) => void;
  selectCell: (i: number | null) => void;

  // ---- tracks ----
  updateTrack: (trackId: string, patch: Partial<Track>) => void;
  updateMixer: (trackId: string, patch: Partial<TrackMixer>) => void;
  updateInstrument: (trackId: string, patch: Partial<Instrument>) => void;
  updateDrumParam: (trackId: string, key: string, value: number) => void;
  updateSynthParam: (trackId: string, path: string, value: number | string) => void;
  addTrack: () => void;
  removeTrack: (trackId: string) => void;
  toggleRecordArm: (trackId: string) => void;

  // ---- patterns ----
  queuePattern: (trackId: string, index: number) => void;
  setActivePattern: (trackId: string, index: number) => void;
  updatePattern: (trackId: string, index: number, patch: Partial<Pattern>) => void;
  updateStep: (trackId: string, patternIndex: number, stepIndex: number, patch: Partial<Step>) => void;
  toggleStep: (trackId: string, patternIndex: number, stepIndex: number) => void;
  clearPattern: (trackId: string, index: number) => void;
  randomizePattern: (trackId: string, index: number, density: number) => void;
  addPattern: (trackId: string) => void;

  // ---- scenes ----
  launchScene: (sceneId: string) => void;
  captureScene: (sceneId: string) => void;
  addScene: () => void;

  // ---- keymap ----
  updateCell: (layer: number, index: number, patch: Partial<Cell>) => void;
  clearCell: (layer: number, index: number) => void;
  resetKeyMap: (layer?: number) => void;

  // ---- master ----
  updateMaster: (patch: Partial<MasterFx>) => void;
  updateMasterNested: (path: string, value: number | boolean) => void;

  // ---- persistence ----
  loadProjectList: () => Promise<void>;
  saveProject: () => Promise<void>;
  openProject: (id: string) => Promise<void>;
  newProject: (name?: string) => Promise<void>;
  renameProject: (name: string) => void;
  deleteProject: (id: string) => Promise<void>;
  replaceProject: (p: Project) => void;
  markDirty: () => void;
}

// ---------------------------------------------------------------------------
// Immutable update helpers
// ---------------------------------------------------------------------------

function withTracks(p: Project, fn: (tracks: Track[]) => Track[]): Project {
  return { ...p, tracks: fn(p.tracks), updatedAt: Date.now() };
}

function mapTrack(p: Project, trackId: string, fn: (t: Track) => Track): Project {
  return withTracks(p, (tracks) => tracks.map((t) => (t.id === trackId ? fn(t) : t)));
}

function mapPattern(
  p: Project, trackId: string, index: number, fn: (pat: Pattern) => Pattern,
): Project {
  return mapTrack(p, trackId, (t) => ({
    ...t,
    patterns: t.patterns.map((pat, i) => (i === index ? fn(pat) : pat)),
  }));
}

/** Resize a pattern's step array, preserving what fits. */
function resizeSteps(steps: Step[], length: number): Step[] {
  if (steps.length === length) return steps;
  if (steps.length > length) return steps.slice(0, length);
  return [...steps, ...Array.from({ length: length - steps.length }, emptyStep)];
}

function setDeep<T extends object>(obj: T, path: string, value: unknown): T {
  const parts = path.split('.');
  const out: any = { ...obj };
  let cur = out;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = { ...cur[parts[i]] };
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return out;
}

const LOCAL_KEY = 'pulse.project';

function loadLocal(): Project | null {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Project;
    return p && Array.isArray(p.tracks) && p.keymap ? p : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------

const initial = loadLocal() ?? createProject('First Track');

export const useStore = create<AppState>((set, get) => ({
  project: initial,
  view: 'steps',
  selectedTrackId: initial.tracks[0]?.id ?? '',
  selectedPatternIndex: null,
  activeLayer: 0,
  layerLocked: false,
  selectedStep: null,
  selectedCell: null,
  audioReady: false,
  playing: false,
  fill: false,
  recordArmed: [],
  queuedScene: null,
  projects: [],
  saveState: 'idle',
  lastError: null,
  revision: 0,

  // ---- lifecycle ---------------------------------------------------------

  async initAudio() {
    if (studio) {
      await studio.engine.resume();
      return studio;
    }
    const engine = new AudioEngine();
    const transport = new Transport(engine, () => get().project);
    const performer = new Performer(engine, transport, {
      getProject: () => get().project,
      dispatch: (action: PerformerAction) => {
        const s = get();
        switch (action.type) {
          case 'queuePattern':
            s.queuePattern(action.trackId, action.patternIndex);
            break;
          case 'queueScene':
            set({ queuedScene: action.sceneId });
            break;
          case 'launchPattern':
            if (action.patternIndex < 0) {
              s.updateTrack(action.trackId, { seqEnabled: false, queuedPattern: null });
            } else {
              s.setActivePattern(action.trackId, action.patternIndex);
              s.updateTrack(action.trackId, { seqEnabled: true, queuedPattern: null });
            }
            break;
          case 'setTrackEnabled':
            s.updateTrack(action.trackId, { seqEnabled: action.enabled, queuedPattern: null });
            break;
          case 'launchScene':
            s.launchScene(action.sceneId);
            set({ queuedScene: null });
            break;
          case 'toggleRecord':
            s.toggleRecordArm(action.trackId);
            break;
        }
        set((st) => ({ revision: st.revision + 1 }));
      },
    });

    transport.onRecord = (ev) => {
      const s = get();
      const track = s.project.tracks.find((t) => t.id === ev.trackId);
      if (!track) return;
      s.updateStep(ev.trackId, track.activePattern, ev.step, {
        on: true,
        velocity: ev.velocity,
        degree: ev.degree,
        octave: ev.octave,
      });
    };
    transport.onLaunch = () => set((st) => ({ revision: st.revision + 1 }));

    engine.syncProject(get().project);
    studio = { engine, transport, performer };
    if (import.meta.env.DEV) {
      // Both handles come from this module instance, so anything poking at
      // them from the console is guaranteed to be driving the same store the
      // app is rendering from.
      Object.assign(window, { pulse: studio, pulseStore: useStore });
    }
    // The graph is usable while suspended, so publish it first and let the
    // context wake up on its own schedule. Awaiting here would gate the entire
    // UI on an output device being available.
    set({ audioReady: true });
    void engine.resume();
    return studio;
  },

  getStudio: () => studio,

  /**
   * Push mixer and master state into the audio graph. The transport reads the
   * project live, so it needs nothing here — only the nodes that hold their own
   * copy of a value (gains, sends, filter frequencies) have to be told.
   */
  syncAudio() {
    if (!studio) return;
    const p = get().project;
    studio.engine.setBpm(p.bpm);
    studio.engine.syncProject(p);
  },

  // ---- transport ---------------------------------------------------------

  async togglePlay() {
    const s = await get().initAudio();
    get().syncAudio();
    if (s.transport.isPlaying) {
      s.transport.stop();
      set({ playing: false });
    } else {
      await s.transport.start();
      set({ playing: true });
    }
  },

  stop() {
    studio?.transport.stop();
    set({ playing: false });
  },

  setBpm(bpm) {
    set((s) => ({ project: { ...s.project, bpm: clamp(Math.round(bpm), 40, 240) } }));
    studio?.engine.setBpm(get().project.bpm);
    get().syncAudio();
    get().markDirty();
  },

  setSwing(swing) {
    set((s) => ({ project: { ...s.project, swing: clamp(swing, 0, 1) } }));
    get().syncAudio();
    get().markDirty();
  },

  setSwingUnit(unit) {
    set((s) => ({ project: { ...s.project, swingUnit: clamp(Math.round(unit), 2, 8) } }));
    get().syncAudio();
    get().markDirty();
  },

  setHumanize(ms) {
    set((s) => ({ project: { ...s.project, humanize: clamp(ms, 0, 30) } }));
    get().syncAudio();
    get().markDirty();
  },

  setKey(key) {
    set((s) => ({ project: { ...s.project, key: { ...s.project.key, ...key } } }));
    get().syncAudio();
    get().markDirty();
  },

  setFill(on) {
    if (studio) studio.transport.fillActive = on;
    set({ fill: on });
  },

  panic() {
    studio?.performer.panic();
    studio?.transport.stop();
    set({ playing: false });
  },

  // ---- ui ----------------------------------------------------------------

  setView: (view) => set({ view }),
  selectTrack: (selectedTrackId) => set({ selectedTrackId, selectedStep: null }),
  selectPattern: (selectedPatternIndex) => set({ selectedPatternIndex }),
  setLayer: (n) => {
    studio?.performer.releaseAll();
    set({ activeLayer: clamp(n, 0, 3) });
  },
  toggleLayerLock: () => set((s) => ({ layerLocked: !s.layerLocked })),
  selectStep: (selectedStep) => set({ selectedStep }),
  selectCell: (selectedCell) => set({ selectedCell }),

  // ---- tracks ------------------------------------------------------------

  updateTrack(trackId, patch) {
    set((s) => ({ project: mapTrack(s.project, trackId, (t) => ({ ...t, ...patch })) }));
    get().syncAudio();
    get().markDirty();
  },

  updateMixer(trackId, patch) {
    set((s) => ({
      project: mapTrack(s.project, trackId, (t) => ({ ...t, mixer: { ...t.mixer, ...patch } })),
    }));
    get().syncAudio();
    get().markDirty();
  },

  updateInstrument(trackId, patch) {
    set((s) => ({
      project: mapTrack(s.project, trackId, (t) => ({
        ...t, instrument: { ...t.instrument, ...patch },
      })),
    }));
    get().markDirty();
  },

  updateDrumParam(trackId, key, value) {
    set((s) => ({
      project: mapTrack(s.project, trackId, (t) => ({
        ...t,
        instrument: { ...t.instrument, drum: { ...t.instrument.drum, [key]: value } },
      })),
    }));
    get().markDirty();
  },

  updateSynthParam(trackId, path, value) {
    set((s) => ({
      project: mapTrack(s.project, trackId, (t) => ({
        ...t,
        instrument: { ...t.instrument, synth: setDeep(t.instrument.synth, path, value) },
      })),
    }));
    get().markDirty();
  },

  addTrack() {
    const s = get();
    const colors = ['#ff4d6d', '#ffd166', '#8ef6e4', '#a0e7a0', '#c77dff', '#4cc9f0', '#b8c0ff', '#ffa07a'];
    const track: Track = {
      id: uid('trk'),
      name: `Track ${s.project.tracks.length + 1}`,
      color: colors[s.project.tracks.length % colors.length],
      instrument: {
        kind: 'drum', engine: 'kick',
        drum: { tune: 55, decay: 0.4, pitchMod: 24, pitchTime: 0.045, noise: 0, drive: 0.3, cutoff: 18000, resonance: 0.7, snap: 0.5 },
        synth: s.project.tracks[0]?.instrument.synth ?? ({} as any),
      },
      mixer: { gain: 0.85, pan: 0, mute: false, solo: false, reverb: 0, delay: 0, duck: 0 },
      patterns: [makePattern('A'), makePattern('B'), makePattern('C'), makePattern('D')],
      activePattern: 0,
      queuedPattern: null,
      seqEnabled: true,
    };
    set((st) => ({
      project: withTracks(st.project, (ts) => [...ts, track]),
      selectedTrackId: track.id,
    }));
    get().syncAudio();
    get().markDirty();
  },

  removeTrack(trackId) {
    set((s) => {
      const project = withTracks(s.project, (ts) => ts.filter((t) => t.id !== trackId));
      return {
        project,
        selectedTrackId: s.selectedTrackId === trackId
          ? project.tracks[0]?.id ?? ''
          : s.selectedTrackId,
      };
    });
    get().syncAudio();
    get().markDirty();
  },

  toggleRecordArm(trackId) {
    const s = get();
    const armed = new Set(s.recordArmed);
    if (armed.has(trackId)) armed.delete(trackId); else armed.add(trackId);
    if (studio) {
      studio.transport.recordArmed.clear();
      for (const id of armed) studio.transport.recordArmed.add(id);
    }
    set({ recordArmed: [...armed] });
  },

  // ---- patterns ----------------------------------------------------------

  /**
   * Mark a launch as pending. Purely cosmetic — the sequencer does not read
   * this — but without it a bar-quantized launch looks like a dropped keypress
   * for up to a full bar.
   */
  queuePattern(trackId, index) {
    set((s) => ({
      project: mapTrack(s.project, trackId, (t) => ({ ...t, queuedPattern: index })),
    }));
  },

  setActivePattern(trackId, index) {
    set((s) => ({
      project: mapTrack(s.project, trackId, (t) => ({
        ...t, activePattern: clamp(index, 0, t.patterns.length - 1), queuedPattern: null,
      })),
    }));
    get().syncAudio();
    get().markDirty();
  },

  updatePattern(trackId, index, patch) {
    set((s) => ({
      project: mapPattern(s.project, trackId, index, (pat) => {
        const next = { ...pat, ...patch };
        if (patch.length !== undefined && patch.length !== pat.length) {
          next.length = clamp(Math.round(patch.length), 1, 64);
          next.steps = resizeSteps(pat.steps, next.length);
        }
        return next;
      }),
    }));
    get().syncAudio();
    get().markDirty();
  },

  updateStep(trackId, patternIndex, stepIndex, patch) {
    set((s) => ({
      project: mapPattern(s.project, trackId, patternIndex, (pat) => ({
        ...pat,
        steps: pat.steps.map((st, i) => (i === stepIndex ? { ...st, ...patch } : st)),
      })),
    }));
    get().syncAudio();
    get().markDirty();
  },

  toggleStep(trackId, patternIndex, stepIndex) {
    const pat = get().project.tracks.find((t) => t.id === trackId)?.patterns[patternIndex];
    const on = pat?.steps[stepIndex]?.on ?? false;
    get().updateStep(trackId, patternIndex, stepIndex, { on: !on });
  },

  clearPattern(trackId, index) {
    set((s) => ({
      project: mapPattern(s.project, trackId, index, (pat) => ({
        ...pat, mode: 'manual', steps: pat.steps.map(() => emptyStep()),
      })),
    }));
    get().syncAudio();
    get().markDirty();
  },

  /**
   * Fill a pattern using the logistic map rather than Math.random. It produces
   * clustered, structured densities — runs of hits and runs of rests — which
   * sounds far more like a played part than uniform noise does.
   */
  randomizePattern(trackId, index, density) {
    set((s) => ({
      project: mapPattern(s.project, trackId, index, (pat) => {
        let x = 0.31 + Math.random() * 0.3;
        return {
          ...pat,
          mode: 'manual',
          steps: pat.steps.map((st, i) => {
            x = clamp(3.9 * x * (1 - x), 0.0001, 0.9999);
            const downbeat = i % 4 === 0;
            const on = x < density * (downbeat ? 1.5 : 0.85);
            return { ...st, on, velocity: on ? clamp(0.55 + x * 0.5, 0.3, 1) : st.velocity };
          }),
        };
      }),
    }));
    get().syncAudio();
    get().markDirty();
  },

  addPattern(trackId) {
    set((s) => ({
      project: mapTrack(s.project, trackId, (t) => ({
        ...t,
        patterns: [...t.patterns, makePattern(String.fromCharCode(65 + t.patterns.length))],
      })),
    }));
    get().markDirty();
  },

  // ---- scenes ------------------------------------------------------------

  launchScene(sceneId) {
    set((s) => {
      const scene = s.project.scenes.find((sc) => sc.id === sceneId);
      if (!scene) return {};
      return {
        project: withTracks(s.project, (tracks) =>
          tracks.map((t) => {
            const idx = scene.slots[t.id];
            if (idx === undefined) return t;
            return {
              ...t,
              activePattern: clamp(idx, 0, t.patterns.length - 1),
              seqEnabled: true,
              queuedPattern: null,
            };
          }),
        ),
      };
    });
    get().syncAudio();
    get().markDirty();
  },

  captureScene(sceneId) {
    set((s) => ({
      project: {
        ...s.project,
        scenes: s.project.scenes.map((sc) =>
          sc.id === sceneId
            ? { ...sc, slots: Object.fromEntries(s.project.tracks.map((t) => [t.id, t.activePattern])) }
            : sc,
        ),
        updatedAt: Date.now(),
      },
    }));
    get().markDirty();
  },

  addScene() {
    set((s) => {
      const scene: Scene = {
        id: uid('scn'),
        name: `Scene ${s.project.scenes.length + 1}`,
        slots: Object.fromEntries(s.project.tracks.map((t) => [t.id, t.activePattern])),
      };
      return { project: { ...s.project, scenes: [...s.project.scenes, scene], updatedAt: Date.now() } };
    });
    get().markDirty();
  },

  // ---- keymap ------------------------------------------------------------

  updateCell(layer, index, patch) {
    set((s) => ({
      project: {
        ...s.project,
        keymap: {
          ...s.project.keymap,
          layers: s.project.keymap.layers.map((l, li) =>
            li === layer ? l.map((c, ci) => (ci === index ? { ...c, ...patch } : c)) : l,
          ),
        },
        updatedAt: Date.now(),
      },
    }));
    get().markDirty();
  },

  clearCell(layer, index) {
    get().updateCell(layer, index, emptyCell());
  },

  /**
   * Rebuild the key map from the current tracks and scenes. Pass a layer to
   * reset only that one. Needed because the map is stored in the project, so
   * an existing project keeps whatever defaults it was created with.
   */
  resetKeyMap(layer) {
    studio?.performer.panic();
    set((s) => {
      const fresh = defaultKeyMap(s.project.tracks, s.project.scenes);
      const layers = layer === undefined
        ? fresh.layers
        : s.project.keymap.layers.map((l, i) => (i === layer ? fresh.layers[i] : l));
      return {
        project: {
          ...s.project,
          keymap: { layers, layerNames: fresh.layerNames },
          updatedAt: Date.now(),
        },
      };
    });
    get().markDirty();
  },

  // ---- master ------------------------------------------------------------

  updateMaster(patch) {
    set((s) => ({ project: { ...s.project, master: { ...s.project.master, ...patch }, updatedAt: Date.now() } }));
    studio?.engine.applyMaster(get().project.master);
    get().markDirty();
  },

  updateMasterNested(path, value) {
    set((s) => ({
      project: { ...s.project, master: setDeep(s.project.master, path, value), updatedAt: Date.now() },
    }));
    studio?.engine.applyMaster(get().project.master);
    get().markDirty();
  },

  // ---- persistence -------------------------------------------------------

  async loadProjectList() {
    try {
      set({ projects: await api.listProjects() });
    } catch (e) {
      set({ lastError: (e as Error).message });
    }
  },

  async saveProject() {
    const p = get().project;
    set({ saveState: 'saving' });
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(p));
      await api.saveProject(p);
      set({ saveState: 'saved', lastError: null });
      void get().loadProjectList();
      window.setTimeout(() => {
        if (get().saveState === 'saved') set({ saveState: 'idle' });
      }, 1600);
    } catch (e) {
      // The local mirror already succeeded, so work is never lost offline.
      set({ saveState: 'error', lastError: (e as Error).message });
    }
  },

  async openProject(id) {
    try {
      const p = await api.getProject(id);
      get().replaceProject(p);
      set({ view: 'steps' });
    } catch (e) {
      set({ lastError: (e as Error).message });
    }
  },

  async newProject(name) {
    try {
      const p = await api.createProject(name ?? 'Untitled');
      get().replaceProject(p);
    } catch {
      get().replaceProject(createProject(name ?? 'Untitled'));
    }
    set({ view: 'steps' });
  },

  renameProject(name) {
    set((s) => ({ project: { ...s.project, name, updatedAt: Date.now() } }));
    get().markDirty();
  },

  async deleteProject(id) {
    try {
      await api.deleteProject(id);
      await get().loadProjectList();
    } catch (e) {
      set({ lastError: (e as Error).message });
    }
  },

  replaceProject(p) {
    studio?.performer.panic();
    studio?.transport.stop();
    set({
      project: p,
      selectedTrackId: p.tracks[0]?.id ?? '',
      selectedStep: null,
      selectedCell: null,
      playing: false,
      recordArmed: [],
    });
    get().syncAudio();
    localStorage.setItem(LOCAL_KEY, JSON.stringify(p));
  },

  markDirty() {
    if (autosaveTimer !== null) window.clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => {
      autosaveTimer = null;
      void get().saveProject();
    }, 1800);
  },
}));
