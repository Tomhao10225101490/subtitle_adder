// Fast burn pipeline: WebCodecs transcode at full hardware speed (3–10× realtime).
// mp4box demuxes → VideoDecoder → canvas composite (frame + caption) → VideoEncoder → mp4-muxer.
// Audio is passed through untouched (no re-encode, no quality loss).
//
// Scope: MP4/MOV input with a codec the browser can decode (H.264/HEVC/VP9/AV1) and
// AAC audio (or no audio). Everything else throws FastPathError — the caller falls
// back to the realtime Canvas+MediaRecorder pipeline in burner.ts.

import { createFile, DataStream, MP4BoxBuffer } from 'mp4box';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { SubtitleStyle } from '../style';
import type { CaptionLine } from './whisper';
import { renderCaption, captionAt } from './subtitleRenderer';
import type { BurnProgress, BurnResult } from './burner';

export class FastPathError extends Error {}

export interface FastBurnOptions {
  file: File;
  /** Display dimensions (rotation already applied — what <video> reports). */
  width: number;
  height: number;
  durationSec: number;
  captions: CaptionLine[];
  style: SubtitleStyle;
  /** Bitrate hint in bps (default: same heuristic as realtime burner). */
  bitrate?: number;
}

/** Cheap pre-check: is this file worth attempting the fast path on? */
export function fastPathAvailable(file: File): boolean {
  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') return false;
  return /\.(mp4|m4v|mov)$/i.test(file.name) || ['video/mp4', 'video/quicktime'].includes(file.type);
}

const READ_CHUNK = 4 * 1024 * 1024;
const KEYFRAME_INTERVAL_US = 2_000_000;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/** Extract the codec description box (avcC/hvcC/…) needed by VideoDecoder. */
function getVideoDescription(iso: any, trackId: number): Uint8Array | null {
  try {
    const trak = iso.getTrackById(trackId);
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (!box) return null;
    const stream = new (DataStream as any)(undefined, 0, (DataStream as any).BIG_ENDIAN);
    box.write(stream);
    return new Uint8Array(stream.buffer, 8); // strip the 8-byte box header
  } catch {
    return null;
  }
}

/** AudioSpecificConfig for AAC passthrough — read from esds, or synthesize from track info. */
function getAudioSpecificConfig(iso: any, trackId: number, sampleRate: number, channels: number): Uint8Array {
  try {
    const trak = iso.getTrackById(trackId);
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    const esd = entry?.esds?.esd;
    const findTag = (d: any, tag: number): any => {
      if (!d) return null;
      if (d.tag === tag) return d;
      for (const c of d.descs || []) { const r = findTag(c, tag); if (r) return r; }
      return null;
    };
    const dsi = findTag(esd, 5); // DecoderSpecificInfo
    if (dsi?.data?.length) return new Uint8Array(dsi.data);
  } catch { /* synthesize below */ }
  // Synthesize AAC-LC AudioSpecificConfig: 5 bits object type, 4 bits freq index, 4 bits channels
  const freqs = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  let freqIndex = freqs.indexOf(sampleRate);
  if (freqIndex < 0) freqIndex = 4; // default 44100
  const objectType = 2; // AAC-LC
  return new Uint8Array([
    (objectType << 3) | (freqIndex >> 1),
    ((freqIndex & 1) << 7) | (channels << 3)
  ]);
}

/** Rotation in degrees (0/90/180/270) from the track's transformation matrix. */
function getRotation(matrix: ArrayLike<number> | undefined): number {
  if (!matrix || matrix.length < 5) return 0;
  const a = matrix[0] / 65536, b = matrix[1] / 65536;
  const deg = Math.round(Math.atan2(b, a) * 180 / Math.PI);
  return ((deg % 360) + 360) % 360;
}

/** Pick an H.264 encode codec string with a level that covers the resolution. */
function pickEncodeCodec(width: number, height: number): string {
  const pixels = width * height;
  if (pixels > 1920 * 1088) return 'avc1.640033'; // High 5.1 — up to 4K
  if (pixels > 1280 * 720) return 'avc1.64002A';  // High 4.2 — 1080p60
  return 'avc1.640020';                            // High 3.2 — 720p
}

/** Burn captions via WebCodecs at full speed. Throws FastPathError when this file/browser can't take the fast path. */
export async function fastBurnVideo(opts: FastBurnOptions, onProgress?: (p: BurnProgress) => void): Promise<BurnResult> {
  if (!opts.durationSec || opts.durationSec <= 0) throw new FastPathError('Unknown duration');
  onProgress?.({ stage: 'preparing', percent: 2 });

  // keepMdatData=true — mp4box v2 discards sample data by default, which silently
  // breaks setExtractionOptions (onSamples never fires).
  const iso: any = createFile(true);

  // ── Phase 1: read until moov is parsed (metadata) ─────────────────
  let readyInfo: any = null;
  let readyError: any = null;
  iso.onReady = (info: any) => { readyInfo = info; };
  iso.onError = (e: any) => { readyError = e; };

  let offset = 0;
  const appendNext = async (): Promise<boolean> => {
    if (offset >= opts.file.size) return false;
    const buf = await opts.file.slice(offset, offset + READ_CHUNK).arrayBuffer();
    iso.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buf, offset));
    offset += buf.byteLength;
    return true;
  };

  while (!readyInfo && !readyError) {
    if (!(await appendNext())) break;
  }
  if (readyError || !readyInfo) throw new FastPathError('Could not parse MP4 structure');

  const videoTrack = readyInfo.videoTracks?.[0];
  if (!videoTrack) throw new FastPathError('No video track');
  const audioTrack = readyInfo.audioTracks?.[0] ?? null;
  if (audioTrack && !String(audioTrack.codec).startsWith('mp4a')) {
    throw new FastPathError(`Audio codec ${audioTrack.codec} — passthrough needs AAC`);
  }

  // ── Configure decoder ─────────────────────────────────────────────
  const description = getVideoDescription(iso, videoTrack.id);
  const decoderConfig: VideoDecoderConfig = {
    codec: videoTrack.codec,
    codedWidth: videoTrack.video?.width || videoTrack.track_width,
    codedHeight: videoTrack.video?.height || videoTrack.track_height,
    ...(description ? { description } : {}),
    hardwareAcceleration: 'no-preference'
  };
  const decSupport = await VideoDecoder.isConfigSupported(decoderConfig).catch(() => null);
  if (!decSupport?.supported) throw new FastPathError(`Decoder unsupported: ${videoTrack.codec}`);

  // ── Configure encoder + muxer ─────────────────────────────────────
  // Output canvas uses DISPLAY dimensions (rotation applied), forced even for H.264.
  const rotation = getRotation(videoTrack.matrix);
  const W = Math.max(2, Math.floor(opts.width / 2) * 2);
  const H = Math.max(2, Math.floor(opts.height / 2) * 2);
  const fps = Math.min(120, Math.max(10, Math.round(videoTrack.nb_samples / opts.durationSec) || 30));
  const bitrate = opts.bitrate ?? Math.min(12_000_000, Math.max(2_000_000, W * H * 8));

  const encoderConfig: VideoEncoderConfig = {
    codec: pickEncodeCodec(W, H),
    width: W,
    height: H,
    bitrate,
    framerate: fps,
    hardwareAcceleration: 'no-preference',
    avc: { format: 'avc' }
  } as VideoEncoderConfig;
  const encSupport = await VideoEncoder.isConfigSupported(encoderConfig).catch(() => null);
  if (!encSupport?.supported) throw new FastPathError('H.264 encoder unsupported');

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H },
    ...(audioTrack ? {
      audio: {
        codec: 'aac' as const,
        sampleRate: audioTrack.audio?.sample_rate || 44100,
        numberOfChannels: audioTrack.audio?.channel_count || 2
      }
    } : {}),
    fastStart: 'in-memory',
    // 'offset' zeroes each track independently. Sources with B-frames have a first video
    // cts of 1-2 frame durations (compensated by an edit list we don't parse) — zeroing
    // per track reproduces the source's intended A/V alignment.
    firstTimestampBehavior: 'offset'
  });

  // ── Compositing canvas ────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new FastPathError('No 2D context');

  let fatal: any = null;
  let lastKeyUs = -Infinity;
  let encodedFrames = 0;
  const totalFrames = Math.max(1, videoTrack.nb_samples);
  const startTs = performance.now();

  const encoder = new VideoEncoder({
    output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { if (!fatal) fatal = e; } },
    error: (e) => { fatal = e; }
  });
  encoder.configure(encoderConfig);

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        ctx.save();
        ctx.translate(W / 2, H / 2);
        ctx.rotate(rotation * Math.PI / 180);
        const fw = rotation % 180 === 0 ? W : H;
        const fh = rotation % 180 === 0 ? H : W;
        ctx.drawImage(frame, -fw / 2, -fh / 2, fw, fh);
        ctx.restore();

        const t = frame.timestamp / 1e6;
        const line = captionAt(opts.captions, t);
        if (line) {
          const dur = line.end - line.start;
          const progress = dur > 0 ? Math.min(1, Math.max(0, (t - line.start) / dur)) : 1;
          renderCaption({ ctx, width: W, height: H }, opts.style, line.text, progress, { tSec: t, line });
        }

        const keyFrame = frame.timestamp - lastKeyUs >= KEYFRAME_INTERVAL_US;
        if (keyFrame) lastKeyUs = frame.timestamp;
        const outFrame = new VideoFrame(canvas, {
          timestamp: frame.timestamp,
          duration: frame.duration ?? undefined
        });
        encoder.encode(outFrame, { keyFrame });
        outFrame.close();

        encodedFrames++;
        if (encodedFrames % 15 === 0) {
          const percent = Math.min(98, (encodedFrames / totalFrames) * 100);
          const elapsed = (performance.now() - startTs) / 1000;
          const remaining = percent > 2 ? (elapsed / percent) * (100 - percent) : 0;
          onProgress?.({ stage: 'encoding', percent, elapsedSec: elapsed, remainingSec: remaining });
        }
      } catch (e) {
        fatal = e;
      } finally {
        frame.close();
      }
    },
    error: (e) => { fatal = e; }
  });
  decoder.configure(decoderConfig);

  // ── Phase 2: extract samples, pump with backpressure ─────────────
  const videoQueue: any[] = [];
  const audioSamples: { data: Uint8Array; ts: number; dur: number }[] = [];
  const audioTimescale = audioTrack?.timescale || 1;

  iso.onSamples = (id: number, _user: any, samples: any[]) => {
    for (const s of samples) {
      if (id === videoTrack.id) {
        videoQueue.push(s);
      } else if (audioTrack && id === audioTrack.id) {
        audioSamples.push({
          data: s.data,
          ts: Math.round(s.cts * 1e6 / s.timescale),
          dur: Math.round(s.duration * 1e6 / s.timescale)
        });
      }
    }
  };
  iso.setExtractionOptions(videoTrack.id, null, { nbSamples: 100 });
  if (audioTrack) iso.setExtractionOptions(audioTrack.id, null, { nbSamples: 100 });
  iso.start();

  let readingDone = false;
  const reader = (async () => {
    while (await appendNext()) {
      while (videoQueue.length > 400 && !fatal) await sleep(10); // cap compressed backlog
      if (fatal) return;
    }
    iso.flush();
    readingDone = true;
  })();

  try {
    // Pump: feed decoder from the queue, throttled by both codec queues
    while (!fatal) {
      const s = videoQueue.shift();
      if (!s) {
        if (readingDone) break;
        await sleep(5);
        continue;
      }
      while ((decoder.decodeQueueSize > 24 || encoder.encodeQueueSize > 12) && !fatal) await sleep(5);
      decoder.decode(new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: Math.round(s.cts * 1e6 / s.timescale),
        duration: Math.round(s.duration * 1e6 / s.timescale),
        data: s.data
      }));
    }
    await reader;
    if (fatal) throw fatal;

    await decoder.flush();
    await encoder.flush();
    if (fatal) throw fatal;

    onProgress?.({ stage: 'finalizing', percent: 99 });

    if (audioTrack && audioSamples.length) {
      const asc = getAudioSpecificConfig(
        iso, audioTrack.id,
        audioTrack.audio?.sample_rate || 44100,
        audioTrack.audio?.channel_count || 2
      );
      let first = true;
      for (const a of audioSamples) {
        muxer.addAudioChunkRaw(a.data, 'key', a.ts, a.dur, first ? {
          decoderConfig: {
            codec: audioTrack.codec,
            sampleRate: audioTrack.audio?.sample_rate || 44100,
            numberOfChannels: audioTrack.audio?.channel_count || 2,
            description: asc
          }
        } as any : undefined);
        first = false;
      }
    }

    muxer.finalize();
    const buffer = (muxer.target as InstanceType<typeof ArrayBufferTarget>).buffer;
    const blob = new Blob([buffer], { type: 'video/mp4' });
    onProgress?.({ stage: 'done', percent: 100 });
    console.log(`[SubtitleAdder] Fast burn complete in ${((performance.now() - startTs) / 1000).toFixed(1)}s (${(blob.size / 1024 / 1024).toFixed(1)} MB, ${encodedFrames} frames)`);

    return { blob, mimeType: 'video/mp4', extension: 'mp4', durationSec: opts.durationSec, width: W, height: H };
  } finally {
    try { if (decoder.state !== 'closed') decoder.close(); } catch {}
    try { if (encoder.state !== 'closed') encoder.close(); } catch {}
    try { iso.stop(); } catch {}
  }
}
