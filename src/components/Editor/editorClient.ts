import { checkCapabilities } from '../../lib/editor/compat';
import { loadVideoFile, extractAudioForWhisper, fmtTime, fmtSize, revokeLoaded, type LoadedVideo } from '../../lib/editor/videoLoader';
import { loadWhisper, transcribe, modelDownloadMb, type CaptionLine } from '../../lib/editor/whisper';
import { renderCaption, captionAt } from '../../lib/editor/subtitleRenderer';
import { burnVideo, pickMimeType, extensionForMime, type BurnProgress, type BurnResult } from '../../lib/editor/burner';
import { fastBurnVideo, fastPathAvailable } from '../../lib/editor/fastBurner';
import { importSubtitleFile } from '../../lib/editor/subtitleImport';
import { captionsToSrt, captionsToVtt, downloadFile, downloadBlob } from '../../lib/editor/srtExport';
import { DEFAULT_STYLE, STYLE_PRESETS, presetBySlug, type SubtitleStyle } from '../../lib/style';
import { CaptionHistory, activeCaptionIndex, mergeCaptionWithNext, splitCaptionAt } from '../../lib/editor/captions';
import { parseProject, projectBasename, serializeProject } from '../../lib/editor/project';

export function initEditor() {
  const compat = checkCapabilities();
  const compatWarn = document.getElementById('compat-warn') as HTMLDivElement;
  const compatBlock = document.getElementById('compat-block') as HTMLDivElement;
  if (compat.warnings.length) {
    compatWarn.textContent = compat.warnings.join(' · ');
    compatWarn.classList.remove('hidden');
  }
  if (compat.blockers.length) {
    compatBlock.textContent = compat.blockers.join(' · ');
    compatBlock.classList.remove('hidden');
  }

  let style: SubtitleStyle = { ...DEFAULT_STYLE };
  let loadedVideo: LoadedVideo | null = null;
  let captions: CaptionLine[] = [];
  let selectedIndex = -1;
  let isPlaying = false;
  let userMuted = false;
  let rafId = 0;
  let pendingProject: ReturnType<typeof parseProject> | null = null;
  const history = new CaptionHistory();
  let commitTimer = 0;

  const stageDrop = document.getElementById('stage-drop')!;
  const stageEditor = document.getElementById('stage-editor')!;
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const pickBtn = document.getElementById('pick-file')!;
  const fileName = document.getElementById('file-name')!;
  const fileMeta = document.getElementById('file-meta')!;
  const resetBtn = document.getElementById('reset-btn')!;
  const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
  const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement;
  const saveProjectBtn = document.getElementById('save-project-btn')!;
  const loadProjectBtn = document.getElementById('load-project-btn')!;
  const projectFileInput = document.getElementById('project-file-input') as HTMLInputElement;
  const presetSelect = document.getElementById('preset-select') as HTMLSelectElement;
  const previewCanvas = document.getElementById('preview-canvas') as HTMLCanvasElement;
  const previewCtx = previewCanvas.getContext('2d', { alpha: false })!;
  const hiddenVideo = document.getElementById('hidden-video') as HTMLVideoElement;
  const previewStatus = document.getElementById('preview-status')!;
  const playPause = document.getElementById('play-pause')!;
  const muteToggle = document.getElementById('mute-toggle')!;
  const seekBar = document.getElementById('seek-bar') as HTMLInputElement;
  const timeDisplay = document.getElementById('time-display')!;
  const captionsList = document.getElementById('captions-list')!;
  const captionStatus = document.getElementById('caption-status')!;
  const captionBtn = document.getElementById('caption-btn') as HTMLButtonElement;
  const captionProgress = document.getElementById('caption-progress')!;
  const captionBar = document.getElementById('caption-bar')!;
  const addLineBtn = document.getElementById('add-line-btn')!;
  const splitBtn = document.getElementById('split-btn')!;
  const mergeBtn = document.getElementById('merge-btn')!;
  const exportSrtBtn = document.getElementById('export-srt-btn')!;
  const exportVttBtn = document.getElementById('export-vtt-btn')!;
  const importSubsBtn = document.getElementById('import-subs-btn')!;
  const subsFileInput = document.getElementById('subs-file-input') as HTMLInputElement;
  const burnBtn = document.getElementById('burn-btn') as HTMLButtonElement;
  const burnProgress = document.getElementById('burn-progress')!;
  const burnStage = document.getElementById('burn-stage')!;
  const burnPercent = document.getElementById('burn-percent')!;
  const burnBar = document.getElementById('burn-bar')!;
  const burnEta = document.getElementById('burn-eta')!;
  const burnHint = document.getElementById('burn-hint')!;
  const timeline = document.getElementById('timeline')!;
  const timelineBlocks = document.getElementById('timeline-blocks')!;
  const timelinePlayhead = document.getElementById('timeline-playhead')!;
  const timelineHint = document.getElementById('timeline-hint')!;

  const ctlFont = document.getElementById('ctl-font') as HTMLSelectElement;
  const ctlWeight = document.getElementById('ctl-weight') as HTMLSelectElement;
  const ctlSize = document.getElementById('ctl-size') as HTMLInputElement;
  const ctlTracking = document.getElementById('ctl-tracking') as HTMLInputElement;
  const ctlColor = document.getElementById('ctl-color') as HTMLInputElement;
  const ctlColorText = document.getElementById('ctl-color-text') as HTMLInputElement;
  const ctlStroke = document.getElementById('ctl-stroke') as HTMLInputElement;
  const ctlStrokeText = document.getElementById('ctl-stroke-text') as HTMLInputElement;
  const ctlStrokeWidth = document.getElementById('ctl-stroke-width') as HTMLInputElement;
  const ctlBg = document.getElementById('ctl-bg') as HTMLInputElement;
  const ctlBgOpacity = document.getElementById('ctl-bg-opacity') as HTMLInputElement;
  const ctlBgEnabled = document.getElementById('ctl-bg-enabled') as HTMLInputElement;
  const ctlPosition = document.getElementById('ctl-position') as HTMLSelectElement;
  const ctlAlign = document.getElementById('ctl-align') as HTMLSelectElement;
  const ctlOffsetY = document.getElementById('ctl-offset-y') as HTMLInputElement;
  const ctlAnimation = document.getElementById('ctl-animation') as HTMLSelectElement;
  const ctlShadow = document.getElementById('ctl-shadow') as HTMLSelectElement;
  const ctlUppercase = document.getElementById('ctl-uppercase') as HTMLInputElement;
  const ctlItalic = document.getElementById('ctl-italic') as HTMLInputElement;
  const ctlLanguage = document.getElementById('ctl-language') as HTMLSelectElement;
  const sizeVal = document.getElementById('size-val')!;
  const trackingVal = document.getElementById('tracking-val')!;
  const strokeWidthVal = document.getElementById('stroke-width-val')!;
  const offsetVal = document.getElementById('offset-val')!;

  function showStatus(text: string) {
    previewStatus.textContent = text;
    previewStatus.classList.remove('hidden');
  }
  function hideStatus() {
    previewStatus.classList.add('hidden');
  }

  function scheduleCommit() {
    window.clearTimeout(commitTimer);
    commitTimer = window.setTimeout(() => {
      history.commit(captions);
      syncHistoryButtons();
    }, 350);
  }

  function syncHistoryButtons() {
    undoBtn.disabled = !history.canUndo;
    redoBtn.disabled = !history.canRedo;
  }

  function syncBurnState() {
    const ready = !!loadedVideo && captions.length > 0;
    burnBtn.disabled = !ready;
    burnHint.textContent = ready
      ? '可以导出了。改字幕只改工程数据，不会动原始视频。'
      : '先生成或导入字幕，改好后再导出。内部始终是可编辑 JSON，只有这里才会把字幕压进画面。';
  }

  function applyStyleToControls() {
    ctlFont.value = style.font;
    ctlWeight.value = String(style.weight);
    ctlSize.value = String(style.size * 100);
    sizeVal.textContent = `${(style.size * 100).toFixed(1)}%`;
    ctlTracking.value = String((style.tracking ?? 0) * 100);
    trackingVal.textContent = `${((style.tracking ?? 0) * 100).toFixed(1)}%`;
    ctlColor.value = style.color;
    ctlColorText.value = style.color;
    ctlStroke.value = style.stroke || '#000000';
    ctlStrokeText.value = style.stroke || '#000000';
    ctlStrokeWidth.value = String((style.strokeWidth ?? 0) * 100);
    strokeWidthVal.textContent = `${((style.strokeWidth ?? 0) * 100).toFixed(0)}%`;
    ctlBg.value = style.bg || '#000000';
    ctlBgOpacity.value = String((style.bgOpacity ?? 0) * 100);
    ctlBgEnabled.checked = !!style.bg && (style.bgOpacity ?? 0) > 0;
    ctlPosition.value = style.position;
    ctlAlign.value = style.align;
    ctlOffsetY.value = String((style.offsetY ?? 0) * 100);
    offsetVal.textContent = `${((style.offsetY ?? 0) * 100).toFixed(0)}%`;
    ctlAnimation.value = style.animation || 'none';
    ctlShadow.value = style.shadow || 'none';
    ctlUppercase.checked = !!style.uppercase;
    ctlItalic.checked = !!style.italic;
    const match = STYLE_PRESETS.find((p) => p.slug === style.preset);
    presetSelect.value = match ? match.slug : 'custom';
  }

  function syncControlsToStyle() {
    style.font = ctlFont.value;
    style.weight = parseInt(ctlWeight.value, 10);
    style.size = parseFloat(ctlSize.value) / 100;
    sizeVal.textContent = `${parseFloat(ctlSize.value).toFixed(1)}%`;
    style.tracking = parseFloat(ctlTracking.value) / 100;
    trackingVal.textContent = `${parseFloat(ctlTracking.value).toFixed(1)}%`;
    style.color = ctlColorText.value || ctlColor.value;
    style.stroke = ctlStrokeText.value || ctlStroke.value;
    style.strokeWidth = parseFloat(ctlStrokeWidth.value) / 100;
    strokeWidthVal.textContent = `${parseFloat(ctlStrokeWidth.value).toFixed(0)}%`;
    style.bg = ctlBgEnabled.checked ? ctlBg.value : '';
    style.bgOpacity = ctlBgEnabled.checked ? parseFloat(ctlBgOpacity.value) / 100 : 0;
    style.position = ctlPosition.value as SubtitleStyle['position'];
    style.align = ctlAlign.value as SubtitleStyle['align'];
    style.offsetY = parseFloat(ctlOffsetY.value) / 100;
    offsetVal.textContent = `${parseFloat(ctlOffsetY.value).toFixed(0)}%`;
    style.animation = ctlAnimation.value as SubtitleStyle['animation'];
    style.shadow = ctlShadow.value as SubtitleStyle['shadow'];
    style.uppercase = ctlUppercase.checked;
    style.italic = ctlItalic.checked;
    style.preset = 'custom';
    presetSelect.value = 'custom';
  }

  function setCaptions(next: CaptionLine[], opts?: { commit?: boolean; selected?: number; status?: string }) {
    captions = next;
    if (typeof opts?.selected === 'number') selectedIndex = opts.selected;
    if (selectedIndex >= captions.length) selectedIndex = captions.length - 1;
    if (opts?.commit !== false) {
      history.commit(captions);
      syncHistoryButtons();
    }
    renderCaptionsList();
    renderTimeline();
    syncBurnState();
    if (opts?.status) captionStatus.textContent = opts.status;
  }

  function renderCaptionsList() {
    if (captions.length === 0) {
      captionsList.innerHTML = '<div class="text-xs text-slate-500 text-center py-6">还没有字幕。点「自动识别」或「加一行」。</div>';
      renderTimeline();
      return;
    }
    captionsList.innerHTML = captions.map((c, i) => `
      <div class="caption-row rounded-lg border border-slate-800 bg-slate-900/40 p-2.5 ${i === selectedIndex ? 'is-active' : ''}" data-row="${i}">
        <div class="flex items-center gap-2 mb-1.5 text-xs text-slate-500">
          <input type="number" data-i="${i}" data-k="start" value="${c.start.toFixed(2)}" step="0.05" class="cap-edit w-16 bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-slate-300 mono" />
          <span>→</span>
          <input type="number" data-i="${i}" data-k="end" value="${c.end.toFixed(2)}" step="0.05" class="cap-edit w-16 bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-slate-300 mono" />
          <span class="ml-auto text-[10px] text-slate-600">${(c.end - c.start).toFixed(1)}s</span>
          <button type="button" data-del="${i}" class="text-red-400 hover:text-red-300 text-xs">删除</button>
        </div>
        <textarea data-i="${i}" data-k="text" rows="2" class="cap-edit w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-white">${c.text.replace(/</g, '&lt;')}</textarea>
      </div>
    `).join('');

    captionsList.querySelectorAll<HTMLElement>('[data-row]').forEach((row) => {
      row.addEventListener('click', (ev) => {
        if ((ev.target as HTMLElement).closest('input, textarea, button')) return;
        const i = parseInt(row.dataset.row || '-1', 10);
        selectCaption(i, true);
      });
    });
    captionsList.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.cap-edit').forEach((el) => {
      el.addEventListener('focus', () => {
        const i = parseInt(el.dataset.i || '-1', 10);
        selectCaption(i, false);
      });
      el.addEventListener('input', () => {
        const i = parseInt(el.dataset.i || '-1', 10);
        const k = el.dataset.k as 'start' | 'end' | 'text';
        if (!captions[i]) return;
        if (k === 'text') captions[i].text = el.value;
        else captions[i][k] = parseFloat(el.value) || 0;
        scheduleCommit();
        renderTimeline();
      });
    });
    captionsList.querySelectorAll<HTMLButtonElement>('button[data-del]').forEach((b) => {
      b.addEventListener('click', () => {
        const i = parseInt(b.dataset.del || '-1', 10);
        const next = captions.filter((_, idx) => idx !== i);
        setCaptions(next, { selected: Math.min(i, next.length - 1), status: `还剩 ${next.length} 条` });
      });
    });
    highlightActive(-1);
  }

  function renderTimeline() {
    const duration = loadedVideo?.durationSec || 1;
    if (captions.length === 0) {
      timelineBlocks.innerHTML = '';
      timelineHint.textContent = '';
      return;
    }
    timelineBlocks.innerHTML = captions.map((c, i) => {
      const left = Math.max(0, (c.start / duration) * 100);
      const width = Math.max(0.6, ((c.end - c.start) / duration) * 100);
      return `<button type="button" data-tl="${i}" class="timeline-block absolute top-1 bottom-1 rounded-sm bg-orange-400/70 hover:bg-orange-300 ${i === selectedIndex ? 'is-active' : ''}" style="left:${left}%;width:${width}%;" title="${c.text.replace(/"/g, '&quot;')}"></button>`;
    }).join('');
    timelineBlocks.querySelectorAll<HTMLButtonElement>('button[data-tl]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const i = parseInt(btn.dataset.tl || '-1', 10);
        selectCaption(i, true);
      });
    });
    timelineHint.textContent = `${captions.length} 条`;
  }

  function selectCaption(index: number, seek: boolean) {
    selectedIndex = index;
    document.querySelectorAll('.caption-row').forEach((el) => {
      el.classList.toggle('is-active', el.getAttribute('data-row') === String(index));
    });
    document.querySelectorAll('.timeline-block').forEach((el) => {
      el.classList.toggle('is-active', el.getAttribute('data-tl') === String(index));
    });
    const line = captions[index];
    if (seek && line && loadedVideo) {
      hiddenVideo.currentTime = line.start + 0.01;
    }
    const row = captionsList.querySelector(`[data-row="${index}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }

  function highlightActive(playbackIndex: number) {
    const current = playbackIndex >= 0 ? playbackIndex : selectedIndex;
    document.querySelectorAll('.caption-row').forEach((el) => {
      const i = el.getAttribute('data-row');
      el.classList.toggle('is-active', i === String(selectedIndex) || i === String(current));
    });
    document.querySelectorAll('.timeline-block').forEach((el) => {
      const i = el.getAttribute('data-tl');
      el.classList.toggle('is-active', i === String(selectedIndex) || i === String(current));
    });
  }

  function drawPreview(time: number) {
    if (!loadedVideo) return;
    const w = previewCanvas.width;
    const h = previewCanvas.height;
    try {
      previewCtx.drawImage(hiddenVideo, 0, 0, w, h);
    } catch {
      previewCtx.fillStyle = '#000';
      previewCtx.fillRect(0, 0, w, h);
    }
    const line = captionAt(captions, time);
    if (line) {
      const dur = line.end - line.start;
      const progress = dur > 0 ? Math.min(1, Math.max(0, (time - line.start) / dur)) : 1;
      renderCaption({ ctx: previewCtx, width: w, height: h }, style, line.text, progress, { tSec: time, line });
    } else if (captions.length === 0) {
      renderCaption({ ctx: previewCtx, width: w, height: h }, style, '字幕会出现在这里', 1);
    }
  }

  function startPreviewLoop() {
    cancelAnimationFrame(rafId);
    const tick = () => {
      if (!loadedVideo) return;
      const t = hiddenVideo.currentTime;
      drawPreview(t);
      seekBar.value = String(t);
      timeDisplay.textContent = `${fmtTime(t)} / ${fmtTime(loadedVideo.durationSec)}`;
      const duration = loadedVideo.durationSec || 1;
      timelinePlayhead.style.left = `${(t / duration) * 100}%`;
      highlightActive(activeCaptionIndex(captions, t));
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  async function openEditor(file: File) {
    if (compat.blockers.length) {
      alert('当前浏览器缺少必要能力，请换用 Chrome 113+ 或 Edge。');
      return;
    }
    showStatus('正在读取视频…');
    try {
      if (loadedVideo) revokeLoaded(loadedVideo);
      loadedVideo = await loadVideoFile(file, (p) => showStatus(`正在读取… ${p.percent ?? ''}%`));
    } catch (e: any) {
      alert(e?.message || '无法打开视频');
      hideStatus();
      return;
    }

    fileName.textContent = file.name;
    fileMeta.textContent = `${loadedVideo.width}×${loadedVideo.height} · ${fmtTime(loadedVideo.durationSec)} · ${fmtSize(file.size)}`;
    previewCanvas.width = loadedVideo.width;
    previewCanvas.height = loadedVideo.height;
    const previewWrap = document.getElementById('preview-wrap');
    if (previewWrap && loadedVideo.width > 0 && loadedVideo.height > 0) {
      previewWrap.style.aspectRatio = `${loadedVideo.width} / ${loadedVideo.height}`;
    }
    hiddenVideo.src = loadedVideo.url;
    hiddenVideo.load();
    await new Promise<void>((r) => hiddenVideo.addEventListener('loadeddata', () => r(), { once: true }));
    hiddenVideo.currentTime = 0.01;
    await new Promise<void>((r) => hiddenVideo.addEventListener('seeked', () => r(), { once: true }));

    stageDrop.classList.add('hidden');
    stageEditor.classList.remove('hidden');
    captionBtn.disabled = false;
    seekBar.max = String(loadedVideo.durationSec);
    timeDisplay.textContent = `0:00 / ${fmtTime(loadedVideo.durationSec)}`;
    hideStatus();

    if (pendingProject) {
      applyLoadedProject(pendingProject, file.name);
      pendingProject = null;
    } else {
      captions = [];
      selectedIndex = -1;
      history.reset([]);
      captionStatus.textContent = '可以自动识别，或导入已有字幕';
      renderCaptionsList();
      renderTimeline();
      syncBurnState();
      syncHistoryButtons();
    }
    drawPreview(0);
    startPreviewLoop();
  }

  function applyLoadedProject(project: ReturnType<typeof parseProject>, currentFileName: string) {
    style = { ...DEFAULT_STYLE, ...project.style };
    applyStyleToControls();
    if (project.language) ctlLanguage.value = project.language;
    setCaptions(project.captions, {
      commit: false,
      selected: 0,
      status: `已载入 ${project.captions.length} 条字幕`
    });
    history.reset(project.captions);
    syncHistoryButtons();
    if (project.videoFileName && project.videoFileName !== currentFileName) {
      alert(`工程记录的视频是「${project.videoFileName}」，你现在打开的是「${currentFileName}」。字幕已载入，请确认时间轴是否对齐。`);
    }
  }

  pickBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) openEditor(f);
  });
  stageDrop.addEventListener('click', (ev) => {
    if ((ev.target as HTMLElement).closest('button')) return;
    fileInput.click();
  });
  ['dragenter', 'dragover'].forEach((e) => stageDrop.addEventListener(e, (ev) => {
    ev.preventDefault();
    stageDrop.classList.add('is-dragover');
  }));
  ['dragleave', 'drop'].forEach((e) => stageDrop.addEventListener(e, (ev) => {
    ev.preventDefault();
    stageDrop.classList.remove('is-dragover');
  }));
  stageDrop.addEventListener('drop', (ev) => {
    const f = (ev as DragEvent).dataTransfer?.files?.[0];
    if (f) openEditor(f);
  });

  document.getElementById('try-sample')?.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const btn = ev.currentTarget as HTMLButtonElement;
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = '正在加载示例…';
    try {
      const resp = await fetch('/sample.mp4');
      if (!resp.ok) throw new Error('示例视频不可用');
      const blob = await resp.blob();
      await openEditor(new File([blob], 'sample.mp4', { type: 'video/mp4' }));
      setCaptions([
        { start: 0.0, end: 1.5, text: '这是字幕加加' },
        { start: 1.5, end: 3.2, text: '识别错了可以直接改' },
        { start: 3.2, end: 4.8, text: '时间轴、文字、样式都能调' },
        { start: 4.8, end: 6.4, text: '最后导出已经配好字幕的视频' },
        { start: 6.4, end: 7.9, text: '现在试试你自己的视频吧' }
      ], { selected: 0, status: '已载入示例字幕，改几个字再导出看看' });
    } catch (e: any) {
      alert('无法加载示例视频：' + (e?.message || '未知错误'));
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  });

  playPause.addEventListener('click', async () => {
    if (!loadedVideo) return;
    if (isPlaying) {
      hiddenVideo.pause();
      playPause.textContent = '播放';
      isPlaying = false;
      return;
    }
    hiddenVideo.muted = userMuted;
    try {
      await hiddenVideo.play();
      isPlaying = true;
      playPause.textContent = '暂停';
    } catch {
      hiddenVideo.muted = true;
      userMuted = true;
      muteToggle.textContent = '🔇';
      try {
        await hiddenVideo.play();
        isPlaying = true;
        playPause.textContent = '暂停';
      } catch (e2: any) {
        alert('无法播放：' + (e2?.message || ''));
      }
    }
  });
  hiddenVideo.addEventListener('ended', () => {
    isPlaying = false;
    playPause.textContent = '播放';
  });
  muteToggle.addEventListener('click', () => {
    userMuted = !userMuted;
    hiddenVideo.muted = userMuted;
    muteToggle.textContent = userMuted ? '🔇' : '🔊';
  });
  seekBar.addEventListener('input', () => {
    if (!loadedVideo) return;
    hiddenVideo.currentTime = parseFloat(seekBar.value);
  });
  timeline.addEventListener('click', (ev) => {
    if (!loadedVideo) return;
    if ((ev.target as HTMLElement).closest('button')) return;
    const rect = timeline.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    hiddenVideo.currentTime = ratio * loadedVideo.durationSec;
  });

  captionBtn.addEventListener('click', async () => {
    if (!loadedVideo) return;
    captionBtn.disabled = true;
    captionProgress.classList.remove('hidden');
    const setBar = (pct: number) => {
      captionBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    };
    const dur = loadedVideo.durationSec;
    if (dur > 600 && !confirm(`这段视频大约 ${Math.round(dur / 60)} 分钟，识别可能要较长时间。继续吗？`)) {
      captionBtn.disabled = false;
      captionProgress.classList.add('hidden');
      return;
    }
    try {
      captionStatus.textContent = '正在提取音频…';
      setBar(2);
      const audio = await extractAudioForWhisper(loadedVideo.file, (p) => {
        captionStatus.textContent = `正在提取音频：${Math.round(p)}%`;
        setBar(p * 0.1);
      });
      captionStatus.textContent = `正在加载识别模型（约 ${modelDownloadMb()} MB）…`;
      setBar(10);
      await loadWhisper((p) => {
        if (p.status === 'downloading') {
          captionStatus.textContent = `正在下载模型：${Math.round(p.percent ?? 0)}%`;
          setBar(10 + (p.percent ?? 0) * 0.2);
        } else if (p.status === 'ready') {
          captionStatus.textContent = '模型已就绪，开始识别…';
          setBar(30);
        } else if (p.status === 'error') {
          throw new Error(p.message ?? '模型加载失败');
        }
      });
      const lines = await transcribe(audio, ctlLanguage.value, (p) => {
        captionStatus.textContent = p.message ?? p.stage;
        if (p.percent != null) setBar(30 + p.percent * 0.65);
      });
      setBar(100);
      history.reset([]);
      setCaptions(lines, {
        selected: 0,
        status: `识别完成，共 ${lines.length} 条。认错了直接改文字或时间。`
      });
      setTimeout(() => captionProgress.classList.add('hidden'), 1200);
    } catch (e: any) {
      console.error('[SubtitleAdder] Auto-caption error:', e);
      alert('自动识别失败：' + (e?.message || '未知错误'));
      captionStatus.textContent = '识别失败';
      captionProgress.classList.add('hidden');
    } finally {
      captionBtn.disabled = false;
    }
  });

  addLineBtn.addEventListener('click', () => {
    const last = captions[captions.length - 1];
    const start = last ? last.end : hiddenVideo.currentTime || 0;
    const next = [...captions, { start, end: start + 2, text: '新字幕' }];
    setCaptions(next, { selected: next.length - 1, status: `共 ${next.length} 条` });
  });

  splitBtn.addEventListener('click', () => {
    const i = selectedIndex >= 0 ? selectedIndex : activeCaptionIndex(captions, hiddenVideo.currentTime);
    if (i < 0) {
      alert('先点选一条字幕，再在播放位置拆分。');
      return;
    }
    setCaptions(splitCaptionAt(captions, i, hiddenVideo.currentTime), { selected: i, status: '已拆成两句' });
  });
  mergeBtn.addEventListener('click', () => {
    const i = selectedIndex >= 0 ? selectedIndex : activeCaptionIndex(captions, hiddenVideo.currentTime);
    if (i < 0 || i >= captions.length - 1) {
      alert('请选中一条后面还有下一句的字幕。');
      return;
    }
    setCaptions(mergeCaptionWithNext(captions, i), { selected: i, status: '已与下一句合并' });
  });

  importSubsBtn.addEventListener('click', () => subsFileInput.click());
  subsFileInput.addEventListener('change', async () => {
    const file = subsFileInput.files?.[0];
    if (!file) return;
    subsFileInput.value = '';
    try {
      const result = await importSubtitleFile(file);
      if (captions.length > 0 && !confirm(`用 ${file.name} 里的 ${result.captions.length} 条替换当前 ${captions.length} 条？`)) return;
      history.reset([]);
      setCaptions(result.captions, { selected: 0, status: `已从 ${result.format.toUpperCase()} 导入 ${result.captions.length} 条` });
      if (result.warnings.length) alert(result.warnings.join('\n'));
    } catch (e: any) {
      alert('导入失败：' + (e?.message || '未知错误'));
    }
  });

  function exportName(ext: string) {
    return `${projectBasename(loadedVideo?.file.name || 'video')}.${ext}`;
  }

  exportSrtBtn.addEventListener('click', () => {
    if (captions.length === 0) {
      alert('还没有字幕。');
      return;
    }
    downloadFile(captionsToSrt(captions), exportName('srt'), 'application/x-subrip');
  });
  exportVttBtn.addEventListener('click', () => {
    if (captions.length === 0) {
      alert('还没有字幕。');
      return;
    }
    downloadFile(captionsToVtt(captions), exportName('vtt'), 'text/vtt');
  });

  saveProjectBtn.addEventListener('click', () => {
    if (!loadedVideo) return;
    const json = serializeProject({
      videoFileName: loadedVideo.file.name,
      videoDurationSec: loadedVideo.durationSec,
      language: ctlLanguage.value,
      captions,
      style
    });
    downloadFile(json, `${projectBasename(loadedVideo.file.name)}.project.json`, 'application/json');
  });
  loadProjectBtn.addEventListener('click', () => projectFileInput.click());
  projectFileInput.addEventListener('change', async () => {
    const file = projectFileInput.files?.[0];
    if (!file) return;
    projectFileInput.value = '';
    try {
      const project = parseProject(await file.text());
      if (!loadedVideo) {
        pendingProject = project;
        alert(`工程已读取（${project.captions.length} 条字幕）。请再选择对应的视频文件「${project.videoFileName || '原视频'}」。`);
        fileInput.click();
        return;
      }
      applyLoadedProject(project, loadedVideo.file.name);
    } catch (e: any) {
      alert(e?.message || '无法打开工程文件');
    }
  });

  undoBtn.addEventListener('click', () => {
    const prev = history.undo();
    if (!prev) return;
    captions = prev;
    renderCaptionsList();
    renderTimeline();
    syncBurnState();
    syncHistoryButtons();
  });
  redoBtn.addEventListener('click', () => {
    const next = history.redo();
    if (!next) return;
    captions = next;
    renderCaptionsList();
    renderTimeline();
    syncBurnState();
    syncHistoryButtons();
  });
  window.addEventListener('keydown', (ev) => {
    const meta = ev.metaKey || ev.ctrlKey;
    if (!meta) return;
    if (ev.key.toLowerCase() === 'z' && !ev.shiftKey) {
      ev.preventDefault();
      undoBtn.click();
    } else if ((ev.key.toLowerCase() === 'z' && ev.shiftKey) || ev.key.toLowerCase() === 'y') {
      ev.preventDefault();
      redoBtn.click();
    }
  });

  [ctlFont, ctlWeight, ctlSize, ctlTracking, ctlStrokeWidth, ctlBgOpacity, ctlPosition, ctlAlign, ctlOffsetY, ctlAnimation, ctlShadow]
    .forEach((el) => el.addEventListener('input', () => syncControlsToStyle()));
  [ctlUppercase, ctlItalic, ctlBgEnabled].forEach((el) => el.addEventListener('change', () => syncControlsToStyle()));
  ctlColor.addEventListener('input', () => {
    ctlColorText.value = ctlColor.value;
    syncControlsToStyle();
  });
  ctlColorText.addEventListener('change', () => {
    ctlColor.value = ctlColorText.value;
    syncControlsToStyle();
  });
  ctlStroke.addEventListener('input', () => {
    ctlStrokeText.value = ctlStroke.value;
    syncControlsToStyle();
  });
  ctlStrokeText.addEventListener('change', () => {
    ctlStroke.value = ctlStrokeText.value;
    syncControlsToStyle();
  });
  ctlBg.addEventListener('input', () => syncControlsToStyle());
  presetSelect.addEventListener('change', () => {
    if (presetSelect.value === 'custom') return;
    const preset = presetBySlug(presetSelect.value);
    if (!preset) return;
    style = { ...preset };
    applyStyleToControls();
  });
  applyStyleToControls();
  syncHistoryButtons();

  async function burnWithFastPath(bitrate: number | undefined, onP: (p: BurnProgress & { fast?: boolean }) => void): Promise<{ result: BurnResult; fast: boolean }> {
    const lv = loadedVideo!;
    if (fastPathAvailable(lv.file)) {
      try {
        const result = await fastBurnVideo({
          file: lv.file,
          width: lv.width,
          height: lv.height,
          durationSec: lv.durationSec,
          captions,
          style,
          bitrate
        }, (p) => onP({ ...p, fast: true }));
        return { result, fast: true };
      } catch (e) {
        console.warn('[SubtitleAdder] Fast path unavailable, falling back:', e);
        onP({ stage: 'preparing', percent: 0 });
      }
    }
    const result = await burnVideo({
      videoEl: hiddenVideo,
      width: lv.width,
      height: lv.height,
      durationSec: lv.durationSec,
      captions,
      style,
      bitrate
    }, onP);
    return { result, fast: false };
  }

  burnBtn.addEventListener('click', async () => {
    if (!loadedVideo || captions.length === 0) return;
    burnBtn.disabled = true;
    burnProgress.classList.remove('hidden');
    burnStage.textContent = '准备中…';
    burnPercent.textContent = '0%';
    burnBar.style.width = '0%';
    burnEta.textContent = '';
    try {
      const targetExt = extensionForMime(pickMimeType()).toUpperCase();
      const { result, fast } = await burnWithFastPath(undefined, (p) => {
        const prefix = p.fast ? '加速 · ' : '';
        const labels: Record<string, string> = {
          preparing: '准备',
          encoding: '编码',
          paused: '已暂停',
          finalizing: '收尾',
          done: '完成'
        };
        burnStage.textContent = prefix + (labels[p.stage] || p.stage);
        burnPercent.textContent = `${Math.round(p.percent)}%`;
        burnBar.style.width = `${p.percent}%`;
        if (p.stage === 'paused') {
          burnEta.textContent = '标签页在后台，烧录已暂停。切回来就会继续。';
        } else if (p.remainingSec && p.remainingSec > 1) {
          burnEta.textContent = `大约还要 ${Math.round(p.remainingSec)} 秒（输出 ${p.fast ? 'MP4' : targetExt}）`;
        }
      });
      const filename = `${projectBasename(loadedVideo.file.name)}_captioned.${result.extension}`;
      downloadBlob(result.blob, filename);
      burnStage.textContent = `完成 · ${result.extension.toUpperCase()}`;
      burnEta.textContent = `已保存 ${filename}（${(result.blob.size / 1024 / 1024).toFixed(1)} MB）`;
    } catch (e: any) {
      console.error('[SubtitleAdder] Burn error:', e);
      alert('烧录失败：' + (e?.message || '未知错误'));
      burnStage.textContent = '失败';
      burnEta.textContent = e?.message || '';
    } finally {
      syncBurnState();
    }
  });

  resetBtn.addEventListener('click', () => {
    if (loadedVideo) revokeLoaded(loadedVideo);
    loadedVideo = null;
    captions = [];
    selectedIndex = -1;
    pendingProject = null;
    history.reset([]);
    cancelAnimationFrame(rafId);
    hiddenVideo.src = '';
    fileInput.value = '';
    stageEditor.classList.add('hidden');
    stageDrop.classList.remove('hidden');
    const pw = document.getElementById('preview-wrap');
    if (pw) pw.style.aspectRatio = '16 / 9';
    captionStatus.textContent = '先自动识别，或手动加一行';
    burnProgress.classList.add('hidden');
    burnBar.style.width = '0%';
    renderCaptionsList();
    syncBurnState();
    syncHistoryButtons();
  });
}
