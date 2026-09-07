// Export captions as SRT or VTT subtitle files.

import type { CaptionLine } from './whisper';

function toSrtTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds - Math.floor(seconds)) * 1000);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

function toVttTime(seconds: number): string {
  return toSrtTime(seconds).replace(',', '.');
}

export function captionsToSrt(lines: CaptionLine[]): string {
  return lines.map((line, i) =>
    `${i + 1}\n${toSrtTime(line.start)} --> ${toSrtTime(line.end)}\n${line.text}\n`
  ).join('\n');
}

export function captionsToVtt(lines: CaptionLine[]): string {
  return 'WEBVTT\n\n' + lines.map((line) =>
    `${toVttTime(line.start)} --> ${toVttTime(line.end)}\n${line.text}\n`
  ).join('\n');
}

export function downloadFile(content: string, filename: string, mimeType = 'text/plain') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}
