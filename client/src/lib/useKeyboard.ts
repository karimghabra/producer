/**
 * Physical keyboard → performance cells.
 *
 * Keys are read by `event.code`, so the grid follows the physical positions of
 * a QWERTY board regardless of the user's layout. Layers are the multiplier:
 * forty keys become a hundred and sixty assignments, and the modifiers let one
 * hand change what the other hand is playing without breaking the groove.
 */

import { useEffect, useRef } from 'react';
import { keyIndex } from '@shared/types';
import { useStore } from '../state/store';

/** Keys that mean something other than "play a cell". */
const TRANSPORT_KEYS = new Set([
  'Space', 'Escape', 'Tab', 'F1', 'F2', 'F3', 'F4',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

function isTyping(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
    (el as HTMLElement).isContentEditable;
}

export function useKeyboard(): void {
  // Tracks which (layer, index) each physical key triggered, so the release
  // goes to the same cell even if the layer changed while the key was down.
  const downMap = useRef(new Map<string, { layer: number; index: number }>());

  useEffect(() => {
    const store = useStore;

    function effectiveLayer(e: KeyboardEvent): number {
      const s = store.getState();
      if (e.ctrlKey || e.metaKey) return 2;
      if (e.altKey) return 3;
      return s.activeLayer;
    }

    async function onKeyDown(e: KeyboardEvent) {
      if (isTyping()) return;
      const s = store.getState();

      if (TRANSPORT_KEYS.has(e.code)) {
        switch (e.code) {
          case 'Space':
            e.preventDefault();
            void s.togglePlay();
            return;
          case 'Escape':
            e.preventDefault();
            s.panic();
            return;
          case 'Tab':
            e.preventDefault();
            if (!e.repeat) s.setFill(true);
            return;
          case 'F1': case 'F2': case 'F3': case 'F4':
            e.preventDefault();
            s.setLayer(Number(e.code.slice(1)) - 1);
            return;
          case 'ArrowUp':
            e.preventDefault();
            s.setBpm(s.project.bpm + (e.shiftKey ? 5 : 1));
            return;
          case 'ArrowDown':
            e.preventDefault();
            s.setBpm(s.project.bpm - (e.shiftKey ? 5 : 1));
            return;
          default:
            return;
        }
      }

      const index = keyIndex(e.code);
      if (index < 0) return;
      e.preventDefault();
      if (e.repeat) return;
      if (downMap.current.has(e.code)) return;

      const studio = s.getStudio() ?? await s.initAudio();
      const layer = effectiveLayer(e);
      downMap.current.set(e.code, { layer, index });
      // Shift is an accent, not a layer — drumming wants dynamics more than it
      // wants another bank.
      studio.performer.press(layer, index, e.shiftKey ? 1.25 : 1);
      store.setState((st) => ({ revision: st.revision + 1 }));
    }

    function onKeyUp(e: KeyboardEvent) {
      const s = store.getState();
      if (e.code === 'Tab') { s.setFill(false); return; }

      const entry = downMap.current.get(e.code);
      if (!entry) return;
      downMap.current.delete(e.code);
      s.getStudio()?.performer.release(entry.layer, entry.index);
      store.setState((st) => ({ revision: st.revision + 1 }));
    }

    // Losing focus mid-chord would leave notes hanging forever.
    function onBlur() {
      const s = store.getState();
      downMap.current.clear();
      s.getStudio()?.performer.releaseAll();
      s.setFill(false);
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
}
