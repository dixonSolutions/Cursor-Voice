import {
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  effect,
  input,
  viewChild,
} from '@angular/core';
import type { AudioSpectrum } from '../../../voice-audio-meter.js';

const TAU = Math.PI * 2;
const SILENT = 0.028;
const VIZ_BINS = 32;

@Component({
  selector: 'cv-voice-orb',
  standalone: true,
  template: `
    <div
      class="cv-voice-orb"
      [class.cv-voice-orb--dim]="dimmed()"
      [class.cv-voice-orb--live]="live()"
      [class.cv-voice-orb--expanded]="expanded()">
      <canvas #canvas aria-hidden="true"></canvas>
      <div class="cv-voice-orb-glow" [style.opacity]="glowOpacity()" aria-hidden="true"></div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .cv-voice-orb {
        position: relative;
        width: 13rem;
        height: 13rem;
        margin: 0 auto;
        transition: width 0.35s ease, height 0.35s ease;
      }

      .cv-voice-orb--expanded {
        width: min(68vw, 68vh, 22rem);
        height: min(68vw, 68vh, 22rem);
      }

      .cv-voice-orb canvas {
        position: relative;
        z-index: 1;
        width: 100%;
        height: 100%;
        display: block;
        border-radius: 50%;
        background: transparent;
      }

      .cv-voice-orb-glow {
        position: absolute;
        inset: -12%;
        border-radius: 50%;
        background: radial-gradient(
          circle,
          rgba(59, 130, 246, 0.5) 0%,
          rgba(37, 99, 235, 0.15) 45%,
          transparent 70%
        );
        filter: blur(18px);
        z-index: 0;
        pointer-events: none;
        opacity: 0.2;
        transition: opacity 0.12s ease;
      }

      .cv-voice-orb--live .cv-voice-orb-glow {
        opacity: 0.35;
      }

      .cv-voice-orb--dim .cv-voice-orb-glow {
        opacity: 0.12;
      }

      .cv-voice-orb--dim canvas {
        opacity: 0.55;
      }
    `,
  ],
})
export class VoiceOrbComponent implements OnDestroy {
  /** Live frequency spectrum from VoiceAudioMeter (mic + AI playback). */
  readonly spectrum = input<AudioSpectrum>({
    bins: new Array(VIZ_BINS).fill(0),
    mic: 0,
    out: 0,
    active: 0,
  });
  readonly live = input(false);
  readonly dimmed = input(false);
  readonly expanded = input(false);

  protected glowOpacity = (): number => {
    const lv = this.spectrum().active;
    if (lv < SILENT) return this.live() ? 0.28 : 0.15;
    return Math.min(1, 0.35 + lv * 0.65);
  };

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private rafId = 0;
  private displayLevel = 0;
  private displayMic = 0;
  private displayOut = 0;
  private displayBins = new Float32Array(VIZ_BINS);

  constructor() {
    afterNextRender(() => {
      this.resizeCanvas();
      this.loop();
    });

    effect(() => {
      if (this.canvasRef()) this.resizeCanvas();
    });

    effect(() => {
      this.expanded();
      queueMicrotask(() => this.resizeCanvas());
    });
  }

  private resizeCanvas(): void {
    const el = this.canvasRef()?.nativeElement;
    if (!el) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = el.clientWidth || 208;
    el.width = Math.round(size * dpr);
    el.height = Math.round(size * dpr);
  }

  private loop = (): void => {
    const el = this.canvasRef()?.nativeElement;
    if (el) {
      const { mic, out, active, bins } = this.spectrum();
      const rise = active > this.displayLevel ? 0.55 : 0.22;
      this.displayLevel += (active - this.displayLevel) * rise;
      this.displayMic += (mic - this.displayMic) * 0.35;
      this.displayOut += (out - this.displayOut) * 0.35;
      for (let i = 0; i < VIZ_BINS; i++) {
        const v = bins[i] ?? 0;
        this.displayBins[i] += (v - this.displayBins[i]!) * 0.4;
      }
      this.draw(el);
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  private draw(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const baseR = Math.min(w, h) * 0.38;
    const level = this.displayLevel;
    const mic = this.displayMic;
    const out = this.displayOut;
    const speaking = level >= SILENT || this.maxBin() >= 0.06;
    const userTalk = mic > out && mic >= SILENT;

    const highlight = userTalk ? '#e0f2fe' : '#bae6fd';
    const mid = userTalk ? '#38bdf8' : '#60a5fa';
    const deep = userTalk ? '#1d4ed8' : '#1e3a8a';

    ctx.clearRect(0, 0, w, h);

    const glow = speaking ? 0.35 + level * 0.65 : this.live() ? 0.22 : 0.12;
    const bloom = ctx.createRadialGradient(cx, cy, baseR * 0.2, cx, cy, baseR * 1.35);
    bloom.addColorStop(0, `rgba(96, 165, 250, ${0.18 * glow})`);
    bloom.addColorStop(0.55, `rgba(37, 99, 235, ${0.06 * glow})`);
    bloom.addColorStop(1, 'rgba(15, 23, 42, 0)');
    ctx.fillStyle = bloom;
    ctx.fillRect(0, 0, w, h);

    const coreR = baseR * (speaking ? 1 + level * 0.03 : 1);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, TAU);
    ctx.clip();

    const sphere = ctx.createRadialGradient(
      cx - coreR * 0.28,
      cy - coreR * 0.32,
      coreR * 0.08,
      cx + coreR * 0.1,
      cy + coreR * 0.12,
      coreR * 1.05,
    );
    sphere.addColorStop(0, highlight);
    sphere.addColorStop(0.45, mid);
    sphere.addColorStop(1, deep);
    ctx.fillStyle = sphere;
    ctx.fillRect(cx - coreR, cy - coreR, coreR * 2, coreR * 2);

    if (speaking) {
      const minR = coreR * 0.12;
      const maxR = coreR * 0.92;

      ctx.beginPath();
      for (let i = 0; i <= VIZ_BINS; i++) {
        const bin = this.displayBins[i % VIZ_BINS] ?? 0;
        const radius = minR + (maxR - minR) * (0.35 + bin * 0.65);
        const angle = (i / VIZ_BINS) * TAU - Math.PI / 2;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = `rgba(224, 242, 254, ${0.1 + level * 0.18})`;
      ctx.fill();

      for (let ring = 1; ring <= 3; ring++) {
        const ringBin = this.avgBinSlice(ring - 1, 3);
        const ringR = coreR * (0.28 + (ring / 4) * 0.55) + ringBin * coreR * 0.12;
        ctx.beginPath();
        ctx.arc(cx, cy, ringR, 0, TAU);
        ctx.strokeStyle = `rgba(186, 230, 253, ${0.08 + ringBin * 0.22 + level * 0.12})`;
        ctx.lineWidth = Math.max(1, w * 0.006);
        ctx.stroke();
      }

      ctx.beginPath();
      for (let i = 0; i <= VIZ_BINS; i++) {
        const bin = this.displayBins[i % VIZ_BINS] ?? 0;
        const radius = minR + (maxR - minR) * (0.35 + bin * 0.65);
        const angle = (i / VIZ_BINS) * TAU - Math.PI / 2;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = userTalk
        ? `rgba(224, 242, 254, ${0.2 + level * 0.35})`
        : `rgba(186, 230, 253, ${0.18 + level * 0.3})`;
      ctx.lineWidth = Math.max(1.5, w * 0.005);
      ctx.stroke();
    }

    const sheen = ctx.createRadialGradient(
      cx - coreR * 0.35,
      cy - coreR * 0.4,
      0,
      cx - coreR * 0.1,
      cy - coreR * 0.15,
      coreR * 0.75,
    );
    sheen.addColorStop(0, `rgba(255, 255, 255, ${speaking ? 0.22 + level * 0.15 : 0.14})`);
    sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(cx - coreR, cy - coreR, coreR * 2, coreR * 2);

    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, TAU);
    ctx.strokeStyle = `rgba(186, 230, 253, ${speaking ? 0.22 + level * 0.3 : 0.14})`;
    ctx.lineWidth = Math.max(1, w * 0.004);
    ctx.stroke();
  }

  private avgBinSlice(slice: number, slices: number): number {
    const start = Math.floor((slice / slices) * VIZ_BINS);
    const end = Math.floor(((slice + 1) / slices) * VIZ_BINS);
    let sum = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      sum += this.displayBins[i] ?? 0;
      count++;
    }
    return count > 0 ? sum / count : 0;
  }

  private maxBin(): number {
    let m = 0;
    for (let i = 0; i < VIZ_BINS; i++) {
      m = Math.max(m, this.displayBins[i] ?? 0);
    }
    return m;
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.rafId);
  }
}
