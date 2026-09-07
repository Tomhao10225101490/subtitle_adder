import type { SubtitleStyle } from '../style';
import { DEFAULT_STYLE } from '../style';
import type { CaptionLine } from './whisper';
import { cloneCaptions } from './captions';

export const PROJECT_FORMAT = 'subtitle-adder-project-v1';

export interface CaptionProject {
  format: typeof PROJECT_FORMAT;
  exportedAt: string;
  videoFileName: string;
  videoDurationSec: number;
  language: string;
  captions: CaptionLine[];
  style: SubtitleStyle;
}

export function serializeProject(input: {
  videoFileName: string;
  videoDurationSec: number;
  language: string;
  captions: CaptionLine[];
  style: SubtitleStyle;
}): string {
  const project: CaptionProject = {
    format: PROJECT_FORMAT,
    exportedAt: new Date().toISOString(),
    videoFileName: input.videoFileName,
    videoDurationSec: input.videoDurationSec,
    language: input.language,
    captions: cloneCaptions(input.captions),
    style: { ...input.style }
  };
  return JSON.stringify(project, null, 2);
}

export function parseProject(text: string): CaptionProject {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('工程文件不是有效的 JSON。');
  }

  const captions = parsed?.captions ?? parsed?.lines;
  if (!Array.isArray(captions)) {
    throw new Error('不是有效的工程文件：缺少 captions 数组。');
  }

  const normalized: CaptionLine[] = [];
  captions.forEach((c: any, i: number) => {
    const start = Number(c?.start);
    const end = Number(c?.end);
    const lineText = String(c?.text ?? '').trim();
    if (!lineText) return;
    if (!isFinite(start) || !isFinite(end)) {
      throw new Error(`第 ${i + 1} 条字幕缺少有效的时间。`);
    }
    const line: CaptionLine = {
      start: Math.max(0, start),
      end: Math.max(start + 0.05, end),
      text: String(c.text ?? '')
    };
    if (Array.isArray(c.words)) {
      line.words = c.words
        .map((w: any) => ({
          start: Number(w.start),
          end: Number(w.end),
          text: String(w.text ?? '')
        }))
        .filter((w: { start: number; end: number; text: string }) => isFinite(w.start) && isFinite(w.end) && w.text);
    }
    normalized.push(line);
  });
  if (normalized.length === 0) {
    throw new Error('工程文件里没有有效字幕。');
  }

  const incomingStyle = parsed?.style ?? {};
  const style: SubtitleStyle = { ...DEFAULT_STYLE, ...incomingStyle };

  return {
    format: PROJECT_FORMAT,
    exportedAt: String(parsed?.exportedAt ?? new Date().toISOString()),
    videoFileName: String(parsed?.videoFileName ?? ''),
    videoDurationSec: Number(parsed?.videoDurationSec) || 0,
    language: String(parsed?.language ?? 'zh'),
    captions: normalized,
    style
  };
}

export function projectBasename(videoFileName: string): string {
  return (videoFileName || 'video').replace(/\.[^.]+$/, '') || 'video';
}
