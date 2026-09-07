import { parseProject, serializeProject } from '../src/lib/editor/project.ts';
import { DEFAULT_STYLE } from '../src/lib/style.ts';

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

console.log('project roundtrip ok');
