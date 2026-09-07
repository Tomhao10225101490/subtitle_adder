// Whisper loader and transcription wrapper.
// Uses @huggingface/transformers (Transformers.js) which auto-detects WebGPU.

import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

// Cache models in IndexedDB so repeat visits load instantly.
env.useBrowserCache = true;
env.allowLocalModels = false;
env.allowRemoteModels = true;

// Model sizing trade-off for transformers.js / WebGPU:
//   whisper-tiny    ~40 MB  — fast but inaccurate, prone to hallucination
//   whisper-base   ~150 MB  — was default, still hallucinates on unclear speech
//   whisper-small          — noticeably more accurate, current default
//                             (463 MB as fp16 on WebGPU, 286 MB as q4 on CPU)
//   whisper-medium ~770 MB  — best balance for accuracy, but big download
// We upgraded from base → small after seeing real-world hallucination on clear-speech videos.
// The _timestamped export is the same whisper-small weights re-exported with
// cross-attentions, which is what word-level alignment needs. Measured side by side
// on 18.6 s of speech (q4/WASM): identical transcript, identical 4.9% word error
// rate, same download size, and word mode works where the plain export throws.
const MODEL_ID = 'onnx-community/whisper-small_timestamped';

let whisperPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
let activeDevice: 'webgpu' | 'wasm' | null = null;

export function getActiveDevice(): 'webgpu' | 'wasm' | null {
  return activeDevice;
}

export interface LoadProgress {
  status: 'downloading' | 'ready' | 'error';
  file?: string;
  percent?: number;
  message?: string;
}

/** Touch devices get the quantised weights: ~250 MB instead of ~463 MB, and it avoids
 *  the shader-f16 requirement that many mobile GPUs don't advertise. */
function isTouchDevice(): boolean {
  try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
}

/** The CPU/WASM quantisation. NOT q8 or int8: both ship a malformed QDQ graph for
 *  this model and onnxruntime-web refuses to build a session from them —
 *  "qdq_actions.cc:137 TransposeDQWeightsForMatMulNBits Missing required scale".
 *  That failure happens *after* the full download, so users paid for the weights and
 *  got an error. Measured: q4 builds a session and transcribes; q8 and int8 do not. */
const CPU_DTYPE = 'q4';

/** Disabled after a live regression on 2026-08-11.
 *
 *  The _timestamped export does produce word timings, and on an 18.6 s clip the pass
 *  cost only 25.9 s vs 25.1 s. But once enabled in production, five consecutive
 *  sessions reached model_download_done and then emitted neither transcribe_done nor
 *  transcribe_failed — the tab went quiet. Against the pre-change completion rate of
 *  52/70, five straight non-completions is a ~0.1% coincidence.
 *
 *  Cross-attention output grows with sequence length, so a clip of a few minutes
 *  needs far more memory than the benchmark clip did, and an out-of-memory kill
 *  leaves no JavaScript running to report anything. Re-enable only after measuring
 *  a multi-minute clip on a memory-constrained device. Karaoke meanwhile estimates
 *  word timings from word length, which is what it did for the previous six weeks. */
const MODEL_SUPPORTS_WORD_TIMESTAMPS = false;

/** Approximate download size in MB for the weights we are about to fetch. */
export function modelDownloadMb(): number {
  return ('gpu' in navigator) && !isTouchDevice() ? 463 : 286;
}

export function loadWhisper(onProgress?: (p: LoadProgress) => void): Promise<AutomaticSpeechRecognitionPipeline> {
  if (whisperPromise) return whisperPromise;
  whisperPromise = (async () => {
    const attempt = async (device: 'webgpu' | 'wasm', dtype: 'fp16' | 'q4') => {
      activeDevice = device;
      console.log(`[SubtitleAdder Whisper] Loading on device: ${device} (${dtype})`);
      const transcriber = await pipeline('automatic-speech-recognition', MODEL_ID, {
        device,
        dtype,
        progress_callback: (info: any) => {
          if (info?.status === 'progress' && onProgress) {
            const pct = typeof info.progress === 'number' ? info.progress : 0;
            onProgress({ status: 'downloading', file: info.file, percent: pct, message: `Downloading model: ${info.file ?? ''} (${Math.round(pct)}%)` });
          } else if (info?.status === 'ready' && onProgress) {
            onProgress({ status: 'ready', percent: 100, message: `Model loaded on ${device.toUpperCase()}` });
          }
        }
      } as any);
      console.log(`[SubtitleAdder Whisper] Model ready on ${device.toUpperCase()}`);
      return transcriber;
    };

    const useGpu = ('gpu' in navigator) && !isTouchDevice();
    try {
      return await attempt(useGpu ? 'webgpu' : 'wasm', useGpu ? 'fp16' : CPU_DTYPE);
    } catch (e: any) {
      // A WebGPU failure used to be terminal — the user had already paid the whole
      // download and got nothing. Retry once on the CPU backend before giving up.
      if (useGpu) {
        console.warn('[SubtitleAdder Whisper] WebGPU load failed, retrying on WASM:', e);
        onProgress?.({ status: 'downloading', percent: 0, message: 'GPU unavailable — falling back to CPU…' });
        try {
          return await attempt('wasm', CPU_DTYPE);
        } catch (e2: any) {
          whisperPromise = null;
          onProgress?.({ status: 'error', message: e2?.message ?? 'Failed to load Whisper.' });
          throw e2;
        }
      }
      console.error('[SubtitleAdder Whisper] Load failed:', e);
      whisperPromise = null;
      onProgress?.({ status: 'error', message: e?.message ?? 'Failed to load Whisper.' });
      throw e;
    }
  })();
  return whisperPromise;
}

export interface CaptionWord {
  start: number; // seconds
  end: number;
  text: string;
}

export interface CaptionLine {
  start: number; // seconds
  end: number;
  text: string;
  /** Per-word timings (present when Whisper ran with word-level timestamps) — used by karaoke rendering */
  words?: CaptionWord[];
}

export interface TranscribeProgress {
  stage: 'preparing' | 'inferring' | 'finalizing' | 'done';
  percent?: number;
  message?: string;
}

export async function transcribe(
  audio: Float32Array,
  language: string,
  onProgress?: (p: TranscribeProgress) => void
): Promise<CaptionLine[]> {
  onProgress?.({ stage: 'preparing', percent: 5, message: 'Preparing audio for Whisper…' });

  // Silent input makes the model emit no tokens, and the tokenizer then fails with
  // "token_ids must be a non-empty array of integers" — a cryptic error for what is
  // really "this video has no audible speech". Catch it before the download/inference.
  let peak = 0;
  for (let i = 0; i < audio.length; i += 16) {
    const a = Math.abs(audio[i]);
    if (a > peak) peak = a;
  }
  if (audio.length === 0 || peak < 0.002) {
    throw new Error('这段视频没有可识别的人声（音轨静音或缺失）。请手动添加字幕，或导入 SRT/VTT。');
  }

  const transcriber = await loadWhisper();
  const audioSec = audio.length / 16000;
  // Measured on 18.6 s of real speech, q4 on WASM: 26.2 s of inference, i.e. 0.71x
  // realtime. Decode cost scales with the number of spoken words rather than clip
  // length, so this is a mid-range figure — dense speech is slower, sparse faster.
  // (An earlier 0.24x came from a near-silent 3 s clip and was mostly warm-up.)
  const speedMultiplier = activeDevice === 'webgpu' ? 7 : 0.7;
  const estSec = Math.round(audioSec / speedMultiplier);
  onProgress?.({ stage: 'inferring', percent: 10, message: `Transcribing on ${(activeDevice || '').toUpperCase()} — about ${estSec}s for ${Math.round(audioSec)}s of audio. Don't close the tab.` });

  // Run inference + simulate progress ramp so user sees activity
  const startTime = performance.now();
  let cancelTicker = false;
  const ticker = (async () => {
    while (!cancelTicker) {
      await new Promise(r => setTimeout(r, 1500));
      if (cancelTicker) break;
      const elapsed = (performance.now() - startTime) / 1000;
      const projected = Math.min(85, 10 + (elapsed / estSec) * 75);
      const remaining = Math.max(0, estSec - elapsed);
      onProgress?.({
        stage: 'inferring',
        percent: projected,
        message: `Transcribing… ~${Math.round(remaining)}s left (running on ${(activeDevice || '').toUpperCase()})`
      });
    }
  })();

  const commonOpts = {
    language,
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5,
    // Anti-repetition: stop Whisper from getting stuck in "I will show you. I will show you." loops
    no_repeat_ngram_size: 3,
    // Don't condition each chunk on the previous chunk's text — major source of repetition loops
    condition_on_previous_text: false,
    // Skip silent / non-speech segments entirely
    compression_ratio_threshold: 2.4,
    logprob_threshold: -1.0,
    no_speech_threshold: 0.6
  };

  let result: any;
  let wordLines: CaptionLine[] | null = null;
  try {
    // Word-level timestamps need a model exported with cross-attentions. The plain
    // whisper-small export has none, so this always throws
    // ("Model outputs must contain cross attentions") and we fall through to
    // sentence mode — karaoke then estimates word timings from word length.
    // Skipping the attempt avoids a wasted full inference pass per transcription.
    try {
      if (MODEL_SUPPORTS_WORD_TIMESTAMPS) {
        const wordResult = await transcriber(audio, { ...commonOpts, return_timestamps: 'word' } as any);
        wordLines = buildCuesFromWords((wordResult as any)?.chunks ?? []);
        if (!wordLines || wordLines.length === 0) wordLines = null;
        if (wordLines) result = wordResult;
      }
    } catch (e) {
      console.warn('[SubtitleAdder Whisper] Word-level timestamps unavailable, using sentence mode:', e);
      wordLines = null;
    }
    if (!wordLines) {
      result = await transcriber(audio, { ...commonOpts, return_timestamps: true } as any);
    }
  } finally {
    cancelTicker = true;
  }
  await ticker;

  if (wordLines) {
    onProgress?.({ stage: 'done', percent: 100 });
    return wordLines;
  }
  onProgress?.({ stage: 'finalizing', percent: 92, message: 'Cleaning up captions…' });

  const chunks = (result as any)?.chunks ?? [];
  const lines: CaptionLine[] = chunks
    .map((c: any) => ({
      start: c.timestamp?.[0] ?? 0,
      end: c.timestamp?.[1] ?? (c.timestamp?.[0] ?? 0) + 2,
      text: String(c.text ?? '').trim()
    }))
    .filter((l: CaptionLine) => l.text.length > 0);

  // Fallback if Whisper returned only `text` without chunks
  if (lines.length === 0 && (result as any)?.text) {
    const text = String((result as any).text).trim();
    const audioDur = audio.length / 16000;
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    const dur = audioDur / Math.max(sentences.length, 1);
    sentences.forEach((s, i) => lines.push({ start: i * dur, end: (i + 1) * dur, text: s }));
  }

  // Post-process: collapse consecutive duplicate lines and runaway repeating phrases.
  // Whisper sometimes outputs "I will show you. I will show you. I will show you." dozens of times —
  // this dedupes adjacent identical text and merges their timestamps.
  const deduped: CaptionLine[] = [];
  for (const line of lines) {
    const lastIdx = deduped.length - 1;
    if (lastIdx >= 0 && normalize(deduped[lastIdx].text) === normalize(line.text)) {
      // Same text as previous — extend the previous line's end timestamp
      deduped[lastIdx].end = Math.max(deduped[lastIdx].end, line.end);
    } else {
      deduped.push({ ...line });
    }
  }
  // Also strip lines whose text contains 4+ identical word-pairs in a row
  // (catches the rare loops within a single chunk's text)
  const cleanedRaw = deduped.map(line => ({ ...line, text: collapseRepeats(line.text) }));

  // Drop likely hallucinations: lines where the same sentence repeats 3+ times,
  // or text consists almost entirely of repeated short phrases. Happens on silent /
  // music-only / non-speech sections that slip past Whisper's no_speech_threshold.
  const cleaned = cleanedRaw.filter(line => !looksLikeHallucination(line.text));

  // CRITICAL: split each Whisper chunk into display-friendly cues.
  // Whisper sometimes returns a single chunk with 20+ sentences merged. Without splitting,
  // the renderer shows all those sentences at once stacked vertically. Each display cue
  // gets ~40 chars max and a proportional slice of the chunk's time range.
  const MAX_DISPLAY_CHARS = 42;
  const MIN_CUE_DURATION = 0.6; // seconds — never less than this per cue
  const MAX_CUE_DURATION = 6.0; // seconds — never more than this per cue
  const split: CaptionLine[] = [];
  for (const line of cleaned) {
    const text = line.text.trim();
    if (!text) continue;
    const dur = Math.max(0.01, line.end - line.start);

    // If short enough already, keep as-is (but enforce min duration)
    if (text.length <= MAX_DISPLAY_CHARS) {
      split.push({
        start: line.start,
        end: Math.max(line.end, line.start + MIN_CUE_DURATION),
        text
      });
      continue;
    }

    // Otherwise split into chunks of MAX_DISPLAY_CHARS, distributing time proportionally
    const chunks = splitForDisplay(line, MAX_DISPLAY_CHARS);
    // Cap each chunk's duration so a long Whisper segment doesn't produce one cue that lasts forever
    for (const chunk of chunks) {
      const chunkDur = Math.min(MAX_CUE_DURATION, Math.max(MIN_CUE_DURATION, chunk.end - chunk.start));
      split.push({
        start: chunk.start,
        end: chunk.start + chunkDur,
        text: chunk.text
      });
    }
  }

  // Final pass: ensure cues don't overlap (later cue starts after previous ends)
  for (let i = 1; i < split.length; i++) {
    if (split[i].start < split[i - 1].end) {
      split[i].start = split[i - 1].end;
      if (split[i].end <= split[i].start) {
        split[i].end = split[i].start + MIN_CUE_DURATION;
      }
    }
  }

  onProgress?.({ stage: 'done', percent: 100 });
  return split;
}

/**
 * Group word-level Whisper chunks into short display cues (TikTok-style: a few words
 * at a time), preserving per-word timings for karaoke rendering.
 */
function buildCuesFromWords(chunks: any[]): CaptionLine[] {
  const MAX_WORDS_PER_CUE = 4;
  const MAX_CHARS_PER_CUE = 28;
  const MAX_GAP_SEC = 0.8;   // silence gap that forces a new cue
  const MIN_CUE_DURATION = 0.5;

  const words: CaptionWord[] = [];
  for (const c of chunks) {
    const text = String(c?.text ?? '').trim();
    if (!text) continue;
    const start = c.timestamp?.[0];
    const end = c.timestamp?.[1];
    if (typeof start !== 'number' || !isFinite(start)) continue;
    words.push({
      start,
      end: typeof end === 'number' && isFinite(end) ? end : start + 0.3,
      text
    });
  }
  if (words.length === 0) return [];

  const cues: CaptionLine[] = [];
  let cur: CaptionWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    const text = cur.map(w => w.text).join(' ');
    cues.push({
      start: cur[0].start,
      end: Math.max(cur[cur.length - 1].end, cur[0].start + MIN_CUE_DURATION),
      text,
      words: cur
    });
    cur = [];
  };
  for (const w of words) {
    const joined = cur.map(x => x.text).join(' ');
    const gap = cur.length ? w.start - cur[cur.length - 1].end : 0;
    if (cur.length >= MAX_WORDS_PER_CUE || (joined + ' ' + w.text).length > MAX_CHARS_PER_CUE || gap > MAX_GAP_SEC) {
      flush();
    }
    cur.push(w);
  }
  flush();

  // Drop hallucinated cues, then make cue ranges non-overlapping
  const cleaned = cues.filter(c => !looksLikeHallucination(c.text));
  for (let i = 1; i < cleaned.length; i++) {
    if (cleaned[i].start < cleaned[i - 1].end) {
      cleaned[i] = { ...cleaned[i], start: cleaned[i - 1].end };
      if (cleaned[i].end <= cleaned[i].start) {
        cleaned[i] = { ...cleaned[i], end: cleaned[i].start + MIN_CUE_DURATION };
      }
    }
  }
  return cleaned;
}

/**
 * Detects Whisper hallucination patterns on silent / non-speech / music-only audio.
 * Whisper sometimes produces "do do", "la la", "[Music]", or repeated short sentences
 * when given audio without clear speech. Catch these so they don't end up as captions.
 */
function looksLikeHallucination(text: string): boolean {
  if (!text) return true;
  const t = text.trim();
  if (t.length < 2) return true;

  const lower = t.toLowerCase();

  // Pattern 1: known stock hallucinations from Whisper's YouTube training set
  const stockHallucinations = [
    'thanks for watching',
    'subscribe to my channel',
    'please subscribe',
    'thank you for watching',
    'amara.org community',
    'subtitles by',
    'transcript by',
    'subtitles provided',
    'closed captioning',
    'translated by',
    'captions by'
  ];
  for (const h of stockHallucinations) {
    if (lower.includes(h)) return true;
  }

  // Pattern 2: sound-effect placeholders Whisper sometimes outputs
  // e.g. "[Music]", "(applause)", "♪", "Music", "Bell ringing"
  const soundEffectPattern = /^[\[\(♪♫]?\s*(music|applause|laughter|silence|bell ringing|inaudible|crowd cheering|background noise)\s*[\]\)♪♫]?$/i;
  if (soundEffectPattern.test(t)) return true;
  if (/^[\[\(].{1,30}[\]\)]$/.test(t)) return true; // anything wrapped in brackets like "[Music]" or "(speaking)"
  if (/^[♪♫]+$/.test(t)) return true;

  // Pattern 3: caption is just onomatopoeia / vocal filler
  // Whisper produces these on music: "do do", "la la la", "na na", "oh oh", "uh huh", "mm hmm"
  const onomatopoeic = new Set([
    'do', 'da', 'de', 'di', 'du',
    'la', 'le', 'li', 'lo', 'lu',
    'na', 'ne', 'ni', 'no', 'nu',
    'oh', 'ah', 'eh', 'uh', 'um', 'er',
    'mm', 'hm', 'hmm', 'mmm',
    'yeah', 'yo', 'wow', 'huh',
    'tra', 'ra', 'ba', 'pa',
    'shh', 'oof', 'whoa'
  ]);

  const words = lower.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);

  // Pattern 3a: ALL words are onomatopoeic (the whole caption is "do do do" or "la la la")
  if (words.length > 0 && words.length <= 12) {
    const onomatopoeicCount = words.filter(w => onomatopoeic.has(w)).length;
    if (onomatopoeicCount === words.length) return true;
    // Or 80%+ onomatopoeic with at most 1 non-onomatopoeic token
    if (words.length >= 2 && onomatopoeicCount / words.length >= 0.8) return true;
  }

  // Pattern 3b: text is ≥50% one repeated short token (e.g. "you you you you you")
  if (words.length >= 4) {
    const wordCounts = new Map<string, number>();
    for (const w of words) {
      wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
    }
    const topWord = [...wordCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topWord && topWord[1] / words.length >= 0.5 && topWord[0].length <= 5) {
      return true;
    }
  }

  // Pattern 4: same sentence 3+ times in a row
  const sentences = t.split(/(?<=[.!?])\s+/).filter(Boolean).map(normalize);
  if (sentences.length >= 3) {
    const counts = new Map<string, number>();
    for (const s of sentences) {
      if (s.length < 4) continue;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    for (const c of counts.values()) {
      if (c >= 3) return true;
    }
  }

  // Pattern 5: caption is just a single very short non-word token
  // e.g. "DO DO", "LA LA", "MM" (after stripping punctuation, total alphabetic chars < 6 AND ≤2 words)
  const alphabeticChars = lower.replace(/[^a-z]/g, '').length;
  if (alphabeticChars < 6 && words.length <= 3) {
    // Allow real short words: "yes", "no", "ok", "hi", "hey", "bye", "wait", "stop", "go", "now"
    const realShortWords = new Set(['yes', 'no', 'ok', 'okay', 'hi', 'hey', 'bye', 'wait', 'stop', 'go', 'now', 'why', 'how', 'who', 'wow']);
    const isReal = words.every(w => realShortWords.has(w));
    if (!isReal) return true;
  }

  return false;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\w]+/g, ' ').trim();
}

/**
 * Collapse internal repeats: turns "I will show you. I will show you. I will show you."
 * into "I will show you." (only keeps first occurrence of any 3+-word phrase repeated 2+ times).
 */
function collapseRepeats(text: string): string {
  // Try splitting on sentence terminators first
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length <= 1) return text;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sentences) {
    const key = normalize(s);
    if (key.length < 8) { // very short fragment — keep as-is
      out.push(s);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.join(' ').trim() || text;
}

/** Heuristically split a long line into shorter caption-friendly chunks (≤ maxChars each). */
export function splitForDisplay(line: CaptionLine, maxChars: number): CaptionLine[] {
  if (line.text.length <= maxChars) return [line];
  const words = line.text.split(/\s+/);
  const chunks: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) {
      chunks.push(cur.trim());
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) chunks.push(cur.trim());
  const dur = line.end - line.start;
  const each = dur / chunks.length;
  return chunks.map((t, i) => ({ start: line.start + i * each, end: line.start + (i + 1) * each, text: t }));
}
