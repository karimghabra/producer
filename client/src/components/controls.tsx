/** Shared input primitives: knobs, sliders, segmented buttons, meters. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { clamp, expScale, invExpScale } from '@shared/theory';
import { PARAM_HELP } from '@shared/presets';
import { useStore } from '../state/store';

// ---------------------------------------------------------------------------
// Knob
// ---------------------------------------------------------------------------

export interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  /** Logarithmic travel — right for anything measured in Hz. */
  log?: boolean;
  step?: number;
  format?: (v: number) => string;
  color?: string;
  /** Draw the arc from the centre instead of the left, for bipolar values. */
  bipolar?: boolean;
  /** Plain-English explanation, shown on hover. Falls back to PARAM_HELP. */
  hint?: string;
}

export function Knob({
  label, value, min, max, onChange,
  log = false, step = 0, format, color = 'var(--accent)', bipolar = false, hint,
}: KnobProps) {
  const dragging = useRef<{ y: number; norm: number } | null>(null);

  const toNorm = useCallback(
    (v: number) => (log ? invExpScale(v, min, max) : (v - min) / (max - min)),
    [log, min, max],
  );
  const fromNorm = useCallback(
    (n: number) => {
      const raw = log ? expScale(n, min, max) : min + n * (max - min);
      return step > 0 ? Math.round(raw / step) * step : raw;
    },
    [log, min, max, step],
  );

  const norm = clamp(toNorm(value), 0, 1);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    dragging.current = { y: e.clientY, norm };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragging.current;
    if (!d) return;
    // Fine mode while shift is held — knobs need both coarse and precise.
    const scale = e.shiftKey ? 600 : 160;
    const next = clamp(d.norm + (d.y - e.clientY) / scale, 0, 1);
    onChange(fromNorm(next));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    dragging.current = null;
    try { (e.target as Element).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const onDoubleClick = () => onChange(fromNorm(bipolar ? 0.5 : 0));

  // The arc spans 270°, from -135° to +135°, which is how a hardware pot reads.
  const R = 17;
  const SWEEP = 270;
  const angleFor = (n: number) => -135 + n * SWEEP;
  const rad = (a: number) => ((a - 90) * Math.PI) / 180;
  const pt = (a: number, r: number) => [22 + r * Math.cos(rad(a)), 22 + r * Math.sin(rad(a))];

  const arcPath = (from: number, to: number) => {
    const [x1, y1] = pt(angleFor(from), R);
    const [x2, y2] = pt(angleFor(to), R);
    const large = Math.abs(to - from) * SWEEP > 180 ? 1 : 0;
    const sweep = to >= from ? 1 : 0;
    return `M ${x1} ${y1} A ${R} ${R} 0 ${large} ${sweep} ${x2} ${y2}`;
  };

  const [px, py] = pt(angleFor(norm), R - 4.5);
  const display = format ? format(value) : value.toFixed(value < 10 ? 2 : 0);
  const help = hint ?? PARAM_HELP[label];
  const tip = `${label}${help ? `\n\n${help}` : ''}\n\nDrag to change · shift for fine · double-click to reset`;

  return (
    <div className="knob">
      <div
        className="knob-dial"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        title={tip}
      >
        <svg width="44" height="44" viewBox="0 0 44 44">
          <path d={arcPath(0, 1)} fill="none" stroke="var(--panel-3)" strokeWidth="3.5" strokeLinecap="round" />
          {Math.abs(norm - (bipolar ? 0.5 : 0)) > 0.004 && (
            <path
              d={arcPath(bipolar ? 0.5 : 0, norm)}
              fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round"
            />
          )}
          <circle cx="22" cy="22" r="12.5" fill="var(--panel-2)" stroke="var(--border)" />
          <line x1="22" y1="22" x2={px} y2={py} stroke={color} strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
      <div className="knob-label" title={tip}>{label}</div>
      <div className="knob-value">{display}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slider
// ---------------------------------------------------------------------------

export function Slider({
  label, value, min, max, step = 0.01, onChange, format, hint,
}: {
  label: string; value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; format?: (v: number) => string; hint?: string;
}) {
  const help = hint ?? PARAM_HELP[label];
  return (
    <div className="slider-row" title={help ? `${label} — ${help}` : label}>
      <label>{label}</label>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="val">{format ? format(value) : value.toFixed(2)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Segmented control
// ---------------------------------------------------------------------------

export function Seg<T extends string | number>({
  value, options, onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={String(o.value)}
          className={o.value === value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spectrum scope
// ---------------------------------------------------------------------------

export function Scope() {
  const ref = useRef<HTMLCanvasElement>(null);
  const buf = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const [engineReady, setReady] = useState(false);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const canvas = ref.current;
      if (!canvas) return;
      const studio = useStore.getState().getStudio();
      if (!studio) { setReady(false); return; }
      setReady(true);

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const w = canvas.width, h = canvas.height;
      const bins = studio.engine.spectrumSize;
      if (!buf.current || buf.current.length !== bins) buf.current = new Uint8Array(bins);
      const data = buf.current;
      studio.engine.getSpectrum(data);

      ctx.clearRect(0, 0, w, h);
      // Log-spaced bands: the ear hears octaves, not linear frequency, so a
      // linear FFT plot wastes nine tenths of its width on the top octave.
      const BANDS = 40;
      const barW = w / BANDS;
      for (let i = 0; i < BANDS; i++) {
        const lo = Math.floor(Math.pow(bins, i / BANDS));
        const hi = Math.max(lo + 1, Math.floor(Math.pow(bins, (i + 1) / BANDS)));
        let sum = 0;
        for (let j = lo; j < hi && j < bins; j++) sum += data[j];
        const v = (sum / (hi - lo)) / 255;
        const bh = Math.max(1, v * v * h);
        const hue = 190 + (i / BANDS) * 90;
        ctx.fillStyle = `hsl(${hue} 85% ${42 + v * 26}%)`;
        ctx.fillRect(i * barW, h - bh, barW - 1, bh);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={ref} className="scope" width={150} height={30} title={engineReady ? 'Master spectrum' : 'Press play to start audio'} />;
}

// ---------------------------------------------------------------------------
// Level meter
// ---------------------------------------------------------------------------

export function Meter() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    let smoothed = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const studio = useStore.getState().getStudio();
      const el = ref.current;
      if (!studio || !el) return;
      const { peak } = studio.engine.readMeter();
      // Fast attack, slow release — the way a real meter behaves.
      smoothed = peak > smoothed ? peak : smoothed * 0.9 + peak * 0.1;
      const pct = clamp(smoothed, 0, 1) * 100;
      el.style.height = `${pct}%`;
      el.style.background = smoothed > 0.95 ? 'var(--hot)'
        : smoothed > 0.75 ? 'var(--warm)' : 'var(--good)';
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="meter" title="Master level">
      <div className="meter-fill" ref={ref} style={{ height: '0%' }} />
    </div>
  );
}
