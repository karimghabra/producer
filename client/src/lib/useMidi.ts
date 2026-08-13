/**
 * Web MIDI input.
 *
 * Incoming notes play the selected track directly — chromatically for synths,
 * or as pitched hits for drum tracks. With "snap" on, out-of-key notes are
 * pulled to the nearest scale tone, which makes a MIDI keyboard behave like
 * the computer keyboard's scale-locked rows.
 */

import { useEffect, useState } from 'react';
import { snapToScale, mtof, ftom } from '@shared/theory';
import { useStore } from '../state/store';
import type { SynthVoice } from '../audio/synth';

export interface MidiState {
  supported: boolean;
  inputs: string[];
  lastNote: number | null;
  error: string | null;
}

export function useMidi(snap: boolean): MidiState {
  const [state, setState] = useState<MidiState>({
    supported: typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator,
    inputs: [],
    lastNote: null,
    error: null,
  });

  useEffect(() => {
    const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<any> };
    if (!nav.requestMIDIAccess) return;

    let access: any = null;
    let disposed = false;
    const voices = new Map<number, { trackId: string; voice: SynthVoice }>();

    function handle(data: Uint8Array) {
      const status = data[0] & 0xf0;
      const note = data[1];
      const velRaw = data[2] ?? 0;
      const s = useStore.getState();
      const studio = s.getStudio();
      if (!studio) { void s.initAudio(); return; }

      const track = s.project.tracks.find((t) => t.id === s.selectedTrackId);
      if (!track) return;

      if (status === 0x90 && velRaw > 0) {
        const midi = snap ? snapToScale(s.project.key, note) : note;
        const velocity = velRaw / 127;
        setState((st) => ({ ...st, lastNote: midi }));

        if (track.instrument.kind === 'drum') {
          // Map the note onto the drum's tuning as a semitone offset from C3.
          studio.engine.hitDrum(
            track.id, track.instrument.engine as any, track.instrument.drum,
            studio.engine.currentTime, velocity, midi - 60,
          );
          if (track.id === s.project.master.sidechainSource) {
            studio.engine.duckAll(studio.engine.currentTime);
          }
        } else {
          const voice = studio.engine.noteOn(
            track.id, track.instrument.engine as any, track.instrument.synth,
            midi, studio.engine.currentTime, velocity,
          );
          voices.set(note, { trackId: track.id, voice });
        }
        return;
      }

      if (status === 0x80 || (status === 0x90 && velRaw === 0)) {
        const held = voices.get(note);
        if (held) {
          studio.engine.noteOff(held.trackId, held.voice, studio.engine.currentTime);
          voices.delete(note);
        }
        return;
      }

      // Mod wheel sweeps the master filter — the one control every
      // keyboard has, mapped to the one thing every DJ reaches for.
      if (status === 0xb0 && note === 1) {
        const amount = velRaw / 127;
        studio.engine.macroFilter('low', amount, amount > 0.02, 0.03);
      }
    }

    nav.requestMIDIAccess()
      .then((a: any) => {
        if (disposed) return;
        access = a;
        const attach = () => {
          const names: string[] = [];
          a.inputs.forEach((input: any) => {
            names.push(input.name ?? 'MIDI input');
            input.onmidimessage = (e: any) => handle(e.data);
          });
          setState((st) => ({ ...st, inputs: names, error: null }));
        };
        attach();
        a.onstatechange = attach;
      })
      .catch((e: Error) => {
        if (!disposed) setState((st) => ({ ...st, error: e.message }));
      });

    return () => {
      disposed = true;
      if (access) {
        access.inputs?.forEach((input: any) => { input.onmidimessage = null; });
        access.onstatechange = null;
      }
      const studio = useStore.getState().getStudio();
      for (const held of voices.values()) {
        studio?.engine.noteOff(held.trackId, held.voice, studio.engine.currentTime);
      }
      voices.clear();
    };
  }, [snap]);

  return state;
}

export { mtof, ftom };
