import { parseProject, serializeProject } from '../src/lib/editor/project.ts';
import { DEFAULT_STYLE } from '../src/lib/style.ts';
import { joinCaptionText, mergeCaptionWithNext, splitCaptionAt, splitTextAtRatio } from '../src/lib/editor/captions.ts';
import { captionsToSrt } from '../src/lib/editor/srtExport.ts';

const json = serializeProject({
  videoFileName: 'lesson.mp4',
  videoDurationSec: 12.5,
  language: 'en',
  captions: [
    { start: 1, end: 3, text: 'hello world' },
    { start: 3.2, end: 5, text: 'second line' }
  ],
  style: DEFAULT_STYLE
});

const loaded = parseProject(json);
if (loaded.captions.length !== 2) throw new Error('caption count');
if (loaded.captions[0].text !== 'hello world') throw new Error('caption text');
if (loaded.videoFileName !== 'lesson.mp4') throw new Error('filename');
if (loaded.style.color !== DEFAULT_STYLE.color) throw new Error('style');

let failed = false;
try {
  parseProject('{"hello":1}');
} catch {
  failed = true;
}
if (!failed) throw new Error('invalid project should throw');

const skippedEmpty = parseProject(JSON.stringify({
  format: 'subtitle-adder-project-v1',
  captions: [
    { start: 0, end: 1, text: '' },
    { start: 1, end: 2, text: 'ok' }
  ]
}));
if (skippedEmpty.captions.length !== 1) throw new Error('empty captions should be skipped');

const [left, right] = splitTextAtRatio('我今天去了图书馆', 0.5);
if (!left || !right || left === right) throw new Error('cjk split');
if (left + right !== '我今天去了图书馆') throw new Error('cjk split join');

const split = splitCaptionAt([{ start: 0, end: 4, text: '识别错了可以直接改' }], 0, 2);
if (split.length !== 2) throw new Error('split count');
if (split[0].text + split[1].text !== '识别错了可以直接改') throw new Error('split text');

const merged = mergeCaptionWithNext(split, 0);
if (merged.length !== 1) throw new Error('merge count');
if (merged[0].text !== '识别错了可以直接改') throw new Error('cjk merge space: ' + merged[0].text);
if (joinCaptionText('hello', 'world') !== 'hello world') throw new Error('latin join');

const srt = captionsToSrt([{ start: 1, end: 2.5, text: 'hello' }]);
if (!srt.includes('hello') || !srt.includes('00:00:01,000')) throw new Error('srt');

console.log('project / split / merge / srt ok');
