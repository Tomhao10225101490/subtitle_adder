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

const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

export function splitTextAtRatio(text: string, ratio: number): [string, string] {
  const trimmed = text.trim();
  const spaceParts = trimmed.split(/\s+/).filter(Boolean);
  if (spaceParts.length >= 2) {
    const cut = Math.max(1, Math.min(spaceParts.length - 1, Math.round(spaceParts.length * ratio)));
    return [spaceParts.slice(0, cut).join(' '), spaceParts.slice(cut).join(' ')];
  }
  const chars = [...trimmed];
  if (chars.length < 2) return [trimmed, ''];
  const cut = Math.max(1, Math.min(chars.length - 1, Math.round(chars.length * ratio)));
  return [chars.slice(0, cut).join(''), chars.slice(cut).join('')];
}

export function joinCaptionText(a: string, b: string): string {
  const left = a.trim();
  const right = b.trim();
  if (!left) return right;
  if (!right) return left;
  if (CJK.test(left.slice(-1)) || CJK.test(right[0])) return left + right;
  return `${left} ${right}`;
}

export function splitCaptionAt(lines: CaptionLine[], index: number, atSec: number): CaptionLine[] {
  const next = cloneCaptions(lines);
  const line = next[index];
  if (!line) return next;
  const duration = line.end - line.start;
  if (duration < 0.4) return next;
  const t = Math.min(Math.max(atSec, line.start + 0.15), line.end - 0.15);
  if (t <= line.start + 0.05 || t >= line.end - 0.05) return next;
  const ratio = (t - line.start) / Math.max(0.01, duration);
  const [leftText, rightText] = splitTextAtRatio(line.text, ratio);
  if (!leftText || !rightText) return next;
  next.splice(index, 1, { start: line.start, end: t, text: leftText }, { start: t, end: line.end, text: rightText });
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
    text: joinCaptionText(a.text, b.text)
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
