import type { CaptionLine } from './whisper';

export function cloneCaptions(lines: CaptionLine[]): CaptionLine[] {
  return lines.map((line) => ({
    start: line.start,
    end: line.end,
    text: line.text,
    words: line.words?.map((w) => ({ ...w }))
  }));
}

export function captionsFingerprint(lines: CaptionLine[]): string {
  return JSON.stringify(lines);
}

export function activeCaptionIndex(lines: CaptionLine[], t: number): number {
  for (let i = 0; i < lines.length; i++) {
    if (t >= lines[i].start && t <= lines[i].end) return i;
  }
  return -1;
}

export function splitCaptionAt(lines: CaptionLine[], index: number, atSec: number): CaptionLine[] {
  const next = cloneCaptions(lines);
  const line = next[index];
  if (!line) return next;
  const t = Math.min(Math.max(atSec, line.start + 0.15), line.end - 0.15);
  const ratio = (t - line.start) / Math.max(0.01, line.end - line.start);
  const words = line.text.split(/\s+/).filter(Boolean);
  const cut = Math.max(1, Math.min(words.length - 1, Math.round(words.length * ratio)));
  const leftText = words.slice(0, cut).join(' ') || line.text;
  const rightText = words.slice(cut).join(' ') || line.text;
  const left: CaptionLine = { start: line.start, end: t, text: leftText };
  const right: CaptionLine = { start: t, end: line.end, text: rightText };
  next.splice(index, 1, left, right);
  return next;
}

export function mergeCaptionWithNext(lines: CaptionLine[], index: number): CaptionLine[] {
  const next = cloneCaptions(lines);
  if (index < 0 || index >= next.length - 1) return next;
  const a = next[index];
  const b = next[index + 1];
  next.splice(index, 2, {
    start: a.start,
    end: b.end,
    text: `${a.text} ${b.text}`.replace(/\s+/g, ' ').trim()
  });
  return next;
}

export class CaptionHistory {
  private states: CaptionLine[][] = [[]];
  private index = 0;
  private readonly limit = 80;

  reset(initial: CaptionLine[] = []) {
    this.states = [cloneCaptions(initial)];
    this.index = 0;
  }

  commit(lines: CaptionLine[]) {
    const fp = captionsFingerprint(lines);
    if (fp === captionsFingerprint(this.states[this.index])) return;
    this.states = this.states.slice(0, this.index + 1);
    this.states.push(cloneCaptions(lines));
    if (this.states.length > this.limit) {
      this.states.shift();
    }
    this.index = this.states.length - 1;
  }

  undo(): CaptionLine[] | null {
    if (this.index <= 0) return null;
    this.index -= 1;
    return cloneCaptions(this.states[this.index]);
  }

  redo(): CaptionLine[] | null {
    if (this.index >= this.states.length - 1) return null;
    this.index += 1;
    return cloneCaptions(this.states[this.index]);
  }

  get canUndo() {
    return this.index > 0;
  }

  get canRedo() {
    return this.index < this.states.length - 1;
  }
}
