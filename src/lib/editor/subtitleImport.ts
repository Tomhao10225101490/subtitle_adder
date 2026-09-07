// Parse existing subtitle files (.srt / .vtt) into CaptionLine[].
//
// This is the path for users who already have subtitles — they skip Whisper entirely,
// which means no model download at all. Deliberately tolerant: real-world SRT files
// come with BOMs, CRLF, missing indices, HTML tags and occasionally overlapping cues.

import type { CaptionLine } from './whisper';

export interface ImportResult {
  captions: CaptionLine[];
  format: 'srt' | 'vtt';
  /** Non-fatal problems worth surfacing to the user. */
  warnings: string[];
}

export class SubtitleParseError extends Error {}

/** "00:01:02,500" / "00:01:02.500" / "01:02.500" / "62.5" → seconds */
function parseTimestamp(raw: string): number | null {
  const t = raw.trim().replace(',', '.');
  const m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)$/);
  if (m) {
    const h = m[1] ? parseInt(m[1], 10) : 0;
    const min = parseInt(m[2], 10);
    const sec = parseFloat(m[3]);
    if (!isFinite(min) || !isFinite(sec)) return null;
    return h * 3600 + min * 60 + sec;
  }
  // Bare seconds — rare, but some tools emit it
  const bare = parseFloat(t);
  return isFinite(bare) ? bare : null;
}

/** Strip the markup subtitle files carry that a canvas renderer cannot show. */
function cleanText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')            // <i>, <b>, <font color=…>, VTT <c.classname>
    .replace(/\{\\[^}]*\}/g, '')        // ASS/SSA override blocks that leak into SRT
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

const CUE_LINE = /(-?[\d:.,]+)\s*-->\s*(-?[\d:.,]+)/;

/**
 * Parse SRT or WebVTT text. Format is auto-detected; both share the "start --> end"
 * cue structure, so one parser handles them with small differences.
 */
export function parseSubtitles(text: string, filename = ''): ImportResult {
  if (typeof text !== 'string' || !text.trim()) {
    throw new SubtitleParseError('The subtitle file is empty.');
  }

  // Strip BOM, normalise line endings
  const normalised = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const isVtt = /^\s*WEBVTT/i.test(normalised) || /\.vtt$/i.test(filename);
  const warnings: string[] = [];

  // Blocks are separated by blank lines. VTT NOTE/STYLE/REGION blocks are dropped.
  const blocks = normalised.split(/\n{2,}/);
  const captions: CaptionLine[] = [];
  let skipped = 0;

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (/^WEBVTT/i.test(trimmed)) continue;
    if (/^(NOTE|STYLE|REGION)\b/i.test(trimmed)) continue;

    const lines = trimmed.split('\n');
    const cueIdx = lines.findIndex(l => CUE_LINE.test(l));
    if (cueIdx === -1) { skipped++; continue; }

    const m = lines[cueIdx].match(CUE_LINE)!;
    const start = parseTimestamp(m[1]);
    const end = parseTimestamp(m[2]);
    if (start === null || end === null) { skipped++; continue; }

    const body = cleanText(lines.slice(cueIdx + 1).join('\n'));
    if (!body) { skipped++; continue; }

    captions.push({
      start: Math.max(0, start),
      end: Math.max(Math.max(0, start) + 0.1, end),
      text: body
    });
  }

  if (captions.length === 0) {
    throw new SubtitleParseError(
      isVtt
        ? 'No cues found — is this a valid .vtt file?'
        : 'No cues found — is this a valid .srt file? Each cue needs a "00:00:01,000 --> 00:00:03,000" line.'
    );
  }

  // Files are usually but not always in order.
  captions.sort((a, b) => a.start - b.start);

  // Overlapping cues would make captionAt() pick the first match and appear stuck.
  let overlaps = 0;
  for (let i = 1; i < captions.length; i++) {
    if (captions[i].start < captions[i - 1].end) {
      overlaps++;
      captions[i - 1].end = captions[i].start;
      if (captions[i - 1].end <= captions[i - 1].start) {
        captions[i - 1].end = captions[i - 1].start + 0.1;
      }
    }
  }

  if (skipped > 0) warnings.push(`${skipped} block${skipped === 1 ? '' : 's'} skipped (no readable timing or text).`);
  if (overlaps > 0) warnings.push(`${overlaps} overlapping cue${overlaps === 1 ? '' : 's'} trimmed so they display one at a time.`);

  return { captions, format: isVtt ? 'vtt' : 'srt', warnings };
}

/** Read a File and parse it. Throws SubtitleParseError with a user-facing message. */
export async function importSubtitleFile(file: File): Promise<ImportResult> {
  if (!/\.(srt|vtt)$/i.test(file.name)) {
    throw new SubtitleParseError(`${file.name} is not a .srt or .vtt file.`);
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new SubtitleParseError('Subtitle file is unexpectedly large (over 5 MB).');
  }
  let text: string;
  try {
    text = await file.text();
  } catch {
    throw new SubtitleParseError('Could not read the subtitle file.');
  }
  return parseSubtitles(text, file.name);
}
