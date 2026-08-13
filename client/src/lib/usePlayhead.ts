/**
 * The playhead lives on the audio clock, not in React state — re-rendering the
 * tree 100 times a second would be absurd. This hook samples it once per
 * animation frame and only re-renders when a value the UI actually shows has
 * changed.
 */

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { PPQN } from '../audio/scheduler';

export interface Playhead {
  playing: boolean;
  bar: number;
  beat: number;
  sixteenth: number;
  tick: number;
}

const IDLE: Playhead = { playing: false, bar: 0, beat: 0, sixteenth: 0, tick: 0 };

export function usePlayhead(): Playhead {
  const [head, setHead] = useState<Playhead>(IDLE);
  const last = useRef('');

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const studio = useStore.getState().getStudio();
      if (!studio) {
        if (last.current !== 'idle') { last.current = 'idle'; setHead(IDLE); }
        return;
      }
      const p = studio.transport.position;
      const key = `${p.playing}|${p.bar}|${p.beat}|${p.sixteenth}`;
      if (key === last.current) return;
      last.current = key;
      setHead({
        playing: p.playing, bar: p.bar, beat: p.beat,
        sixteenth: p.sixteenth, tick: p.tick,
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return head;
}

/**
 * Which step of a given pattern is sounding right now. Patterns have their own
 * lengths and resolutions, so this cannot be derived from the bar position —
 * it has to be computed per pattern.
 */
export function stepAt(tick: number, length: number, resolution: number): number {
  if (length <= 0) return 0;
  const ticksPerStep = PPQN / resolution;
  const pos = Math.floor(tick / ticksPerStep);
  return ((pos % length) + length) % length;
}
