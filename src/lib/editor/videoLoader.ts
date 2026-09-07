// Load a user-supplied video file as a playable HTMLVideoElement + extract audio for Whisper.
// No upload — File → object URL → <video>.

export interface LoadedVideo {
  file: File;
  url: string;            // object URL (revoke when done)
  videoEl: HTMLVideoElement;
  width: number;
  height: number;
  durationSec: number;
}

export interface LoadProgress {
  stage: 'reading' | 'decoding' | 'ready';
  percent?: number;
}

/** Load the file into a video element. Resolves once metadata is available. */
export async function loadVideoFile(file: File, onProgress?: (p: LoadProgress) => void): Promise<LoadedVideo> {
  if (!file.type.startsWith('video/') && !/\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name)) {
    throw new Error(`这不是视频文件：${file.name}`);
  }
  onProgress?.({ stage: 'reading', percent: 5 });

  const url = URL.createObjectURL(file);
  const videoEl = document.createElement('video');
  videoEl.preload = 'auto';
  videoEl.muted = true; // critical: must be muted to autoplay/decode without user gesture in some browsers
  videoEl.playsInline = true;
  videoEl.crossOrigin = 'anonymous';
  videoEl.src = url;

  await new Promise<void>((resolve, reject) => {
    const onLoaded = () => {
      videoEl.removeEventListener('loadedmetadata', onLoaded);
      videoEl.removeEventListener('error', onError);
      resolve();
    };
    const onError = (e: Event) => {
      videoEl.removeEventListener('loadedmetadata', onLoaded);
      videoEl.removeEventListener('error', onError);
      // Matroska is the common case here: browsers don't decode .mkv, so point at the
      // one-line remux instead of a generic codec error.
      if (/\.mkv$/i.test(file.name)) {
        reject(new Error('浏览器无法直接播放 MKV。请先转成 MP4：ffmpeg -i "' + file.name + '" -c copy out.mp4'));
        return;
      }
      reject(new Error('视频无法解码，编码可能不受支持（' + (videoEl.error?.message || '未知错误') + '）'));
    };
    videoEl.addEventListener('loadedmetadata', onLoaded);
    videoEl.addEventListener('error', onError);
  });

  onProgress?.({ stage: 'decoding', percent: 60 });

  // MediaRecorder-produced WebM (screen recorders, Loom exports, our own showcase clips)
  // reports duration=Infinity because the container has no duration header. Seeking far
  // past the end forces the browser to scan the file and emit the real duration.
  if (!isFinite(videoEl.duration) || videoEl.duration <= 0) {
    await new Promise<void>(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        videoEl.removeEventListener('durationchange', onDur);
        resolve();
      };
      const onDur = () => {
        if (isFinite(videoEl.duration) && videoEl.duration > 0) finish();
      };
      const timer = setTimeout(finish, 4000); // give up quietly — durationSec stays 0
      videoEl.addEventListener('durationchange', onDur);
      try { videoEl.currentTime = 1e7; } catch { finish(); }
    });
  }

  // Seek to first frame to ensure the decoder has a frame ready.
  await new Promise<void>(resolve => {
    const finish = () => {
      videoEl.removeEventListener('seeked', onSeeked);
      clearTimeout(timer);
      resolve();
    };
    const onSeeked = () => finish();
    const timer = setTimeout(finish, 1500);
    videoEl.addEventListener('seeked', onSeeked);
    try { videoEl.currentTime = 0.01; } catch { finish(); }
  });

  onProgress?.({ stage: 'ready', percent: 100 });
  return {
    file,
    url,
    videoEl,
    width: videoEl.videoWidth,
    height: videoEl.videoHeight,
    durationSec: isFinite(videoEl.duration) ? videoEl.duration : 0
  };
}

/** Decode the file's audio track into a mono Float32Array @ 16 kHz, suitable for Whisper.
 *  Uses OfflineAudioContext for proper anti-aliased resampling — critical for Whisper accuracy. */
export async function extractAudioForWhisper(file: File, onProgress?: (p: number) => void): Promise<Float32Array> {
  onProgress?.(5);
  const arrayBuffer = await file.arrayBuffer();
  onProgress?.(15);

  // Step 1: Decode at the browser's native sample rate (typically 48 kHz).
  // Setting sampleRate on AudioContext is unreliable across browsers — Safari sometimes ignores it.
  // We decode natively first, then resample properly in step 2.
  const tempCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  let decoded: AudioBuffer;
  try {
    decoded = await tempCtx.decodeAudioData(arrayBuffer.slice(0));
  } catch (e: any) {
    tempCtx.close().catch(() => {});
    throw new Error('无法解码音轨，请使用带 AAC / Opus 音频的 MP4、MOV 或 WebM。（' + (e?.message || '解码失败') + '）');
  }
  tempCtx.close().catch(() => {});
  onProgress?.(50);

  const TARGET_RATE = 16000;

  // Step 2: Use OfflineAudioContext to resample and downmix to mono in one pass.
  // OfflineAudioContext applies proper anti-aliasing filtering, unlike a naive linear resampler.
  // The destination is 1-channel @ 16 kHz, which means the browser handles stereo→mono and rate conversion correctly.
  const targetLength = Math.ceil(decoded.duration * TARGET_RATE);
  const offlineCtx = new OfflineAudioContext(1, targetLength, TARGET_RATE);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start(0);
  const rendered = await offlineCtx.startRendering();
  onProgress?.(80);

  let audio = rendered.getChannelData(0);

  // Step 3: Audio normalization — boost gain if volume is too low for Whisper.
  // Quiet audio is a common cause of Whisper hallucinations. We compute peak and RMS,
  // then scale up so the loudest sample reaches ~0.9 (with a safety ceiling).
  let peak = 0;
  let sumSquares = 0;
  for (let i = 0; i < audio.length; i++) {
    const a = Math.abs(audio[i]);
    if (a > peak) peak = a;
    sumSquares += audio[i] * audio[i];
  }
  const rms = Math.sqrt(sumSquares / audio.length);

  // If audio is very quiet (peak < 0.3 or RMS < 0.02), boost it.
  if (peak > 0 && peak < 0.3) {
    const targetPeak = 0.9;
    const gain = Math.min(targetPeak / peak, 10); // Cap at 10× boost to avoid amplifying noise
    audio = audio.slice(); // Float32Array we got from rendered is read-only in some browsers
    for (let i = 0; i < audio.length; i++) {
      audio[i] *= gain;
    }
  }

  onProgress?.(100);
  return audio;
}

/** Diagnostic: return audio peak + RMS levels (useful for "audio too quiet" warnings). */
export function audioLevels(audio: Float32Array): { peak: number; rms: number } {
  let peak = 0;
  let sumSquares = 0;
  for (let i = 0; i < audio.length; i++) {
    const a = Math.abs(audio[i]);
    if (a > peak) peak = a;
    sumSquares += audio[i] * audio[i];
  }
  const rms = Math.sqrt(sumSquares / audio.length);
  return { peak, rms };
}

/** Format seconds as MM:SS or H:MM:SS. */
export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Format file size compactly. */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export function revokeLoaded(loaded: LoadedVideo) {
  try { URL.revokeObjectURL(loaded.url); } catch {}
  try { loaded.videoEl.src = ''; loaded.videoEl.load(); } catch {}
}
