// Canvas2D subtitle renderer.
// Mirrors the CSS preview from stylePreview.ts but draws onto a Canvas frame.

import type { SubtitleStyle } from '../style';
import type { CaptionLine } from './whisper';

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
}

/** Extra render info needed by time-aware animations (karaoke). */
export interface RenderExtra {
  /** Absolute video time in seconds */
  tSec?: number;
  /** The caption line being rendered (for word timings) */
  line?: CaptionLine;
}

/** Returns the active caption line for the given video time, or null. */
export function captionAt(lines: CaptionLine[], t: number): CaptionLine | null {
  for (const line of lines) {
    if (t >= line.start && t <= line.end) return line;
  }
  return null;
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Wrap text into lines that respect the style's maxLineChars. */
function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) {
      out.push(cur.trim());
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) out.push(cur.trim());
  return out.length > 0 ? out : [text];
}

/** Compute font CSS string. */
function fontString(style: SubtitleStyle, fontSizePx: number): string {
  const italic = style.italic ? 'italic ' : '';
  return `${italic}${style.weight} ${fontSizePx}px '${style.font}', system-ui, sans-serif`;
}

/** Render a single caption line onto the canvas at the style's position. */
export function renderCaption(
  rc: RenderContext,
  style: SubtitleStyle,
  text: string,
  /** progress 0..1 within the caption's lifetime — used for animations like pop / wipe */
  progress: number = 1,
  /** absolute time + word timings — required for karaoke word highlighting */
  extra?: RenderExtra
) {
  if (style.animation === 'karaoke') {
    renderKaraoke(rc, style, text, progress, extra);
    return;
  }
  const { ctx, width, height } = rc;
  const fontSize = Math.max(8, Math.round(style.size * height));
  const tracking = (style.tracking ?? 0) * fontSize;
  const leading = style.leading ?? 1.2;
  const lineHeight = fontSize * leading;
  const maxChars = style.maxLineChars ?? 32;

  ctx.save();
  ctx.font = fontString(style, fontSize);
  ctx.textAlign = style.align === 'left' ? 'left' : style.align === 'right' ? 'right' : 'center';
  ctx.textBaseline = 'middle';
  // letterSpacing isn't broadly supported on CanvasRenderingContext2D yet; we apply per-char draw if needed.
  (ctx as any).letterSpacing = `${tracking}px`;

  const display = style.uppercase ? text.toUpperCase() : text;
  const lines = wrapText(display, maxChars);

  // Compute total block height
  const blockHeight = lines.length * lineHeight;

  // Compute X based on align
  const offsetX = style.align === 'left' ? width * 0.05 : style.align === 'right' ? width * 0.95 : width / 2;

  // Compute Y based on position + offsetY
  let baseY: number;
  if (style.position === 'top') {
    baseY = height * (style.offsetY || 0.05) + lineHeight / 2;
  } else if (style.position === 'center') {
    baseY = height / 2 - blockHeight / 2 + lineHeight / 2 + (style.offsetY || 0) * height;
  } else {
    baseY = height - height * (style.offsetY || 0.1) - blockHeight + lineHeight / 2;
  }

  // Animation: pop = scale-in over first 150 ms (assume 30 fps, ~5 frames)
  let scale = 1;
  if (style.animation === 'pop' && progress < 0.15) {
    const t = progress / 0.15;
    scale = 0.85 + 0.15 * easeOutCubic(t);
  } else if (style.animation === 'bounce' && progress < 0.20) {
    const t = progress / 0.20;
    // Bouncy: overshoot then settle
    scale = 0.9 + 0.20 * (Math.sin(t * Math.PI) + t);
    scale = Math.min(scale, 1.15);
  } else if (style.animation === 'fade') {
    if (progress < 0.10) {
      ctx.globalAlpha *= progress / 0.10;
    } else if (progress > 0.90) {
      ctx.globalAlpha *= (1 - progress) / 0.10;
    }
  } else if (style.animation === 'typewriter') {
    // Reveal characters progressively in first 60 % of lifetime
    const reveal = Math.min(1, progress / 0.6);
    const totalChars = lines.reduce((s, l) => s + l.length, 0);
    let charsRemaining = Math.floor(totalChars * reveal);
    const truncated: string[] = [];
    for (const ln of lines) {
      if (charsRemaining <= 0) { truncated.push(''); continue; }
      truncated.push(ln.slice(0, charsRemaining));
      charsRemaining -= ln.length;
    }
    lines.length = 0;
    truncated.forEach(l => lines.push(l));
  }

  ctx.translate(offsetX, baseY + blockHeight / 2 - lineHeight / 2);
  if (scale !== 1) {
    ctx.scale(scale, scale);
  }
  ctx.translate(-offsetX, -(baseY + blockHeight / 2 - lineHeight / 2));

  // Draw each line
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    const y = baseY + i * lineHeight;

    // Background pill (per line, sized to text)
    if (style.bg && (style.bgOpacity ?? 0) > 0) {
      const metrics = ctx.measureText(t);
      const padX = (style.bgPadX ?? 0.6) * fontSize;
      const padY = (style.bgPadY ?? 0.3) * fontSize;
      const radius = (style.bgRadius ?? 0.3) * fontSize;
      const textW = metrics.width;
      let pillX: number;
      if (style.align === 'left') pillX = offsetX - padX;
      else if (style.align === 'right') pillX = offsetX - textW - padX;
      else pillX = offsetX - textW / 2 - padX;
      const pillY = y - lineHeight / 2 - padY + (lineHeight - fontSize) / 2;
      const pillW = textW + padX * 2;
      const pillH = fontSize + padY * 2;
      ctx.fillStyle = hexToRgba(style.bg, style.bgOpacity ?? 0.5);
      roundRect(ctx, pillX, pillY, pillW, pillH, radius);
      ctx.fill();
    }

    // Drop shadow
    if (style.shadow === 'soft') {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = fontSize * 0.4;
      ctx.shadowOffsetY = fontSize * 0.05;
    } else if (style.shadow === 'hard') {
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = fontSize * 0.04;
      ctx.shadowOffsetY = fontSize * 0.04;
    } else {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    }

    // Stroke (8-direction outline for crisp look)
    if (style.stroke && (style.strokeWidth ?? 0) > 0) {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.strokeStyle = style.stroke;
      ctx.lineJoin = 'round';
      ctx.lineWidth = (style.strokeWidth ?? 0.08) * fontSize;
      ctx.strokeText(t, offsetX, y);
    }

    // Foreground fill
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.fillStyle = style.color;
    ctx.fillText(t, offsetX, y);
  }

  ctx.restore();
}

/**
 * Karaoke rendering: draw the cue word by word, highlighting the currently spoken word.
 * Uses real Whisper word timings when present, otherwise synthesizes them proportionally
 * to word length (manual captions, imported SRT).
 */
function renderKaraoke(
  rc: RenderContext,
  style: SubtitleStyle,
  text: string,
  progress: number,
  extra?: RenderExtra
) {
  const { ctx, width, height } = rc;
  const fontSize = Math.max(8, Math.round(style.size * height));
  const leading = style.leading ?? 1.2;
  const lineHeight = fontSize * leading;
  const maxChars = style.maxLineChars ?? 32;

  const display = style.uppercase ? text.toUpperCase() : text;
  const tokens = display.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return;

  // Word timings: real (Whisper word mode) or synthesized proportional to word length
  const lineStart = extra?.line?.start ?? 0;
  const lineEnd = extra?.line?.end ?? lineStart + 1;
  const realWords = extra?.line?.words;
  let timings: { start: number; end: number }[];
  if (realWords && realWords.length === tokens.length) {
    timings = realWords.map(w => ({ start: w.start, end: w.end }));
  } else {
    const totalChars = tokens.reduce((s, w) => s + w.length, 0) || 1;
    const dur = Math.max(0.01, lineEnd - lineStart);
    let acc = lineStart;
    timings = tokens.map(tk => {
      const wdur = dur * (tk.length / totalChars);
      const w = { start: acc, end: acc + wdur };
      acc += wdur;
      return w;
    });
  }
  const t = extra?.tSec ?? lineStart + progress * Math.max(0.01, lineEnd - lineStart);
  let active = -1;
  for (let i = 0; i < timings.length; i++) if (t >= timings[i].start) active = i;

  ctx.save();
  ctx.font = fontString(style, fontSize);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  (ctx as any).letterSpacing = `${(style.tracking ?? 0) * fontSize}px`;

  // Wrap words into visual lines
  const lines: { text: string; idx: number }[][] = [];
  let cur: { text: string; idx: number }[] = [];
  let curLen = 0;
  tokens.forEach((tk, idx) => {
    if (curLen > 0 && curLen + 1 + tk.length > maxChars) { lines.push(cur); cur = []; curLen = 0; }
    cur.push({ text: tk, idx });
    curLen += (curLen ? 1 : 0) + tk.length;
  });
  if (cur.length) lines.push(cur);

  const blockHeight = lines.length * lineHeight;
  let baseY: number;
  if (style.position === 'top') {
    baseY = height * (style.offsetY || 0.05) + lineHeight / 2;
  } else if (style.position === 'center') {
    baseY = height / 2 - blockHeight / 2 + lineHeight / 2 + (style.offsetY || 0) * height;
  } else {
    baseY = height - height * (style.offsetY || 0.1) - blockHeight + lineHeight / 2;
  }

  const spaceW = ctx.measureText(' ').width;
  const highlight = style.highlightColor || '#FFD400';

  for (let li = 0; li < lines.length; li++) {
    const lw = lines[li];
    const y = baseY + li * lineHeight;
    const totalW = lw.reduce((s, w) => s + ctx.measureText(w.text).width, 0) + spaceW * (lw.length - 1);
    let x = style.align === 'left' ? width * 0.05
      : style.align === 'right' ? width * 0.95 - totalW
      : (width - totalW) / 2;

    // Background pill per visual line
    if (style.bg && (style.bgOpacity ?? 0) > 0) {
      const padX = (style.bgPadX ?? 0.6) * fontSize;
      const padY = (style.bgPadY ?? 0.3) * fontSize;
      const radius = (style.bgRadius ?? 0.3) * fontSize;
      ctx.fillStyle = hexToRgba(style.bg, style.bgOpacity ?? 0.5);
      roundRect(ctx, x - padX, y - lineHeight / 2 - padY + (lineHeight - fontSize) / 2, totalW + padX * 2, fontSize + padY * 2, radius);
      ctx.fill();
    }

    for (const w of lw) {
      const wW = ctx.measureText(w.text).width;
      const isActive = w.idx === active;

      if (style.shadow === 'soft') {
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = fontSize * 0.4;
        ctx.shadowOffsetY = fontSize * 0.05;
      } else if (style.shadow === 'hard') {
        ctx.shadowColor = 'rgba(0,0,0,0.85)';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = fontSize * 0.04;
        ctx.shadowOffsetY = fontSize * 0.04;
      } else {
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      }

      if (style.stroke && (style.strokeWidth ?? 0) > 0) {
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.strokeStyle = style.stroke;
        ctx.lineJoin = 'round';
        ctx.lineWidth = (style.strokeWidth ?? 0.08) * fontSize;
        ctx.strokeText(w.text, x, y);
      }

      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.fillStyle = isActive ? highlight : style.color;
      ctx.fillText(w.text, x, y);
      x += wW + spaceW;
    }
  }
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
