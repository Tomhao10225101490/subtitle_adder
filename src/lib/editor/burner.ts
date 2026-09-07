// Burn pipeline: <video> → <canvas> (per-frame draw + subtitle overlay) → MediaRecorder → WebM blob.
// Output is .webm (VP9/Opus) which is universally accepted by TikTok / YouTube / IG / X / Discord.
// No upload, no server work.

import type { SubtitleStyle } from '../style';
import type { CaptionLine } from './whisper';
import { renderCaption, captionAt } from './subtitleRenderer';

export interface BurnOptions {
  videoEl: HTMLVideoElement;
  width: number;
  height: number;
  durationSec: number;
  captions: CaptionLine[];
  style: SubtitleStyle;
  /** Output frame rate (default 30). */
  fps?: number;
  /** Bitrate hint in bps (default 8 Mbps for 1080p). */
  bitrate?: number;
}

export interface BurnProgress {
  stage: 'preparing' | 'encoding' | 'paused' | 'finalizing' | 'done';
  percent: number;
  elapsedSec?: number;
  remainingSec?: number;
}

// One persistent WebAudio graph per video element. createMediaElementSource can only be
// called once per element — after that, ALL of the element's audio flows through this graph.
// previewGain → speakers keeps normal preview playback working; during a burn we mute the
// speaker branch and tap the stream branch instead, so the user doesn't hear the video
// playing at full volume while it encodes.
interface AudioTap {
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
  previewGain: GainNode;
}
const audioTaps = new WeakMap<HTMLVideoElement, AudioTap>();

function getAudioTap(videoEl: HTMLVideoElement): AudioTap | null {
  const existing = audioTaps.get(videoEl);
  if (existing) return existing;
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const source = ctx.createMediaElementSource(videoEl);
    const previewGain = ctx.createGain();
    previewGain.gain.value = 1;
    source.connect(previewGain);
    previewGain.connect(ctx.destination);
    const tap: AudioTap = { ctx, source, previewGain };
    audioTaps.set(videoEl, tap);
    return tap;
  } catch {
    return null; // element already captured elsewhere or WebAudio unavailable
  }
}

/** Pick the best supported MIME type for MediaRecorder. MP4 first (universal), WebM fallback. */
export function pickMimeType(): string {
  const candidates = [
    'video/mp4;codecs=h264,aac',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch { /* ignore */ }
  }
  return 'video/webm';
}

/** Map a MIME type to a sensible file extension. */
export function extensionForMime(mime: string): 'mp4' | 'webm' {
  return mime.startsWith('video/mp4') ? 'mp4' : 'webm';
}

export interface BurnResult {
  blob: Blob;
  mimeType: string;
  extension: 'mp4' | 'webm';
  durationSec: number;
  width: number;
  height: number;
}

/** Burn captions into video and return a downloadable Blob + format metadata. */
export async function burnVideo(opts: BurnOptions, onProgress?: (p: BurnProgress) => void): Promise<BurnResult> {
  if (!opts.durationSec || opts.durationSec <= 0) {
    throw new Error('Video duration unknown — the file may be missing its duration header. Try re-exporting it as MP4 first.');
  }
  const fps = opts.fps ?? 30;
  const bitrate = opts.bitrate ?? Math.min(12_000_000, Math.max(2_000_000, opts.width * opts.height * 8));

  // Set up canvas
  const canvas = document.createElement('canvas');
  canvas.width = opts.width;
  canvas.height = opts.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Could not get 2D canvas context.');

  // Capture canvas as a video stream
  const canvasStream = (canvas as any).captureStream(fps) as MediaStream;

  // Mix in original audio (so the caption-burned output has sound) via a WebAudio tap.
  // The speaker branch is muted during the burn so the user doesn't hear the video
  // playing while it encodes; the recorder branch still receives full audio.
  const tap = getAudioTap(opts.videoEl);
  let streamDest: MediaStreamAudioDestinationNode | null = null;
  if (tap) {
    try {
      if (tap.ctx.state === 'suspended') {
        // resume() never settles without user activation — don't let it hang the burn
        await Promise.race([tap.ctx.resume(), new Promise(r => setTimeout(r, 800))]);
      }
      streamDest = tap.ctx.createMediaStreamDestination();
      tap.source.connect(streamDest);
      tap.previewGain.gain.value = 0; // silence speakers for the duration of the burn
      streamDest.stream.getAudioTracks().forEach(t => canvasStream.addTrack(t));
    } catch {
      /* fall through — output will be silent if audio capture not supported */
    }
  }
  const releaseAudio = () => {
    if (!tap) return;
    try { if (streamDest) tap.source.disconnect(streamDest); } catch {}
    try { tap.previewGain.gain.value = 1; } catch {}
  };

  // Set up MediaRecorder
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(canvasStream, {
    mimeType,
    videoBitsPerSecond: bitrate,
    audioBitsPerSecond: 128_000
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

  const finalBlob = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      try {
        const blob = new Blob(chunks, { type: mimeType });
        resolve(blob);
      } catch (e) { reject(e); }
    };
    recorder.onerror = (e: any) => reject(e?.error ?? new Error('Recording error'));
  });
  finalBlob.catch(() => {}); // avoid unhandled rejection when the burn aborts before awaiting
  const ext = extensionForMime(mimeType);
  console.log(`[SubtitleAdder] Encoding output as ${mimeType} (.${ext})`);

  // Reset video to start, unmute (we want the audio in the output), and play
  const v = opts.videoEl;
  v.muted = false;       // need audio to be captured. Browser blocks autoplay-with-sound without user gesture, but burn is triggered by click.
  v.volume = 1.0;        // captured audio level (doesn't affect playback to user)
  v.currentTime = 0;
  await new Promise<void>(r => {
    const onSeeked = () => { v.removeEventListener('seeked', onSeeked); r(); };
    v.addEventListener('seeked', onSeeked);
  });

  onProgress?.({ stage: 'preparing', percent: 5 });

  // Start recording
  recorder.start(1000); // collect data every second

  const startTimestamp = performance.now();

  // Background tabs freeze requestAnimationFrame while the video keeps playing, which
  // would record frozen frames with running audio. Pause both recorder and video when
  // the tab is hidden and resume when it's visible again — the queued rAF picks the
  // render loop back up automatically.
  const onVisibility = () => {
    if (document.hidden) {
      try { if (recorder.state === 'recording') recorder.pause(); } catch {}
      try { v.pause(); } catch {}
      onProgress?.({ stage: 'paused', percent: Math.min(99, (v.currentTime / opts.durationSec) * 100) });
    } else {
      try { if (recorder.state === 'paused') recorder.resume(); } catch {}
      v.play().catch(() => {});
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  // Render loop — drives the canvas at fps from <video> currentTime
  let stopped = false;
  try {
  await new Promise<void>(async (resolve, reject) => {
    let lastFrameTime = performance.now();
    let renderedFrames = 0;
    const totalFrames = Math.ceil(opts.durationSec * fps);

    function drawFrame() {
      if (stopped) return;
      try {
        // Draw video frame
        ctx.drawImage(v, 0, 0, opts.width, opts.height);

        // Draw caption overlay
        const t = v.currentTime;
        const line = captionAt(opts.captions, t);
        if (line) {
          const dur = line.end - line.start;
          const progress = dur > 0 ? Math.min(1, Math.max(0, (t - line.start) / dur)) : 1;
          renderCaption({ ctx: ctx!, width: opts.width, height: opts.height }, opts.style, line.text, progress, { tSec: t, line });
        }

        renderedFrames++;
        const elapsed = (performance.now() - startTimestamp) / 1000;
        const percent = Math.min(99, (t / opts.durationSec) * 100);
        const remaining = elapsed > 1 ? (elapsed / Math.max(percent, 1)) * (100 - percent) : 0;
        onProgress?.({
          stage: 'encoding',
          percent,
          elapsedSec: elapsed,
          remainingSec: remaining
        });
      } catch (e) {
        stopped = true;
        reject(e);
        return;
      }

      if (v.ended || v.currentTime >= opts.durationSec - 0.05) {
        stopped = true;
        resolve();
      } else {
        requestAnimationFrame(drawFrame);
      }
    }

    // Safety net: if rAF is throttled/frozen (occluded window, background rendering) the
    // render loop can miss the end condition entirely — resolve when the video itself ends.
    const onEnded = () => {
      if (!stopped) {
        stopped = true;
        resolve();
      }
    };
    v.addEventListener('ended', onEnded, { once: true });

    // Kick off playback. Browsers may reject play() without user gesture if videoEl wasn't muted at load —
    // we set muted=false above so the captured audio comes through. Burn is always triggered via button click,
    // which is a valid user gesture, so play() should be allowed.
    try {
      await v.play();
    } catch (e: any) {
      stopped = true;
      reject(new Error('Browser blocked playback. Try interacting with the page first, then burn again. (' + (e?.message ?? '') + ')'));
      return;
    }
    requestAnimationFrame(drawFrame);
  });

  onProgress?.({ stage: 'finalizing', percent: 99 });

  // Stop recording and wait for final blob
  if (recorder.state !== 'inactive') recorder.stop();
  // Pause video to avoid audio bleeding past end of recording
  v.pause();
  v.muted = true;
  v.currentTime = 0;

  const blob = await finalBlob;
  onProgress?.({ stage: 'done', percent: 100 });

  return {
    blob,
    mimeType,
    extension: ext,
    durationSec: opts.durationSec,
    width: opts.width,
    height: opts.height
  };
  } finally {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibility);
    releaseAudio();
    try { if (recorder.state !== 'inactive') recorder.stop(); } catch {}
    // Stop the canvas stream tracks
    canvasStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
  }
}
