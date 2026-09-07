// Browser capability detection for the BurnSub engine.
// Returns hard blockers + soft warnings. Hard blockers stop the user;
// soft warnings just slow things down.

export interface Capability {
  webcodecs: boolean;
  webgpu: boolean;
  mediaRecorder: boolean;
  fileApi: boolean;
  canvasCaptureStream: boolean;
}

export interface CapabilityCheck {
  caps: Capability;
  blockers: string[];   // hard — show error UI, halt
  warnings: string[];   // soft — show info, proceed
}

export function checkCapabilities(): CapabilityCheck {
  const caps: Capability = {
    webcodecs: typeof globalThis.VideoEncoder !== 'undefined' && typeof globalThis.VideoDecoder !== 'undefined',
    webgpu: 'gpu' in navigator,
    mediaRecorder: typeof MediaRecorder !== 'undefined',
    fileApi: typeof FileReader !== 'undefined' && typeof Blob !== 'undefined',
    canvasCaptureStream: (() => {
      try {
        return typeof (document.createElement('canvas') as any).captureStream === 'function';
      } catch { return false; }
    })()
  };

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!caps.fileApi) blockers.push('当前浏览器不支持 File API，请换用最新版 Chrome 或 Edge。');
  if (!caps.mediaRecorder && !caps.canvasCaptureStream) {
    blockers.push('当前浏览器无法烧录视频（缺少 MediaRecorder / Canvas captureStream）。');
  }

  if (!caps.webgpu) {
    warnings.push('未检测到 WebGPU，自动识别会走 CPU，速度会慢很多。建议使用 Chrome 113+。');
  }
  if (!caps.webcodecs) {
    warnings.push('未检测到 WebCodecs，将改用较慢的 Canvas + MediaRecorder 导出 WebM。');
  }

  return { caps, blockers, warnings };
}

export function preferredOutputContainer(caps: Capability): 'mp4' | 'webm' {
  // For v0.1 we use Canvas + MediaRecorder which produces WebM natively.
  // Even when WebCodecs is available, WebM via MediaRecorder is more reliable cross-browser.
  return 'webm';
}
