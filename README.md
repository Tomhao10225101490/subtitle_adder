# 字幕加加

把视频拖进来 → 本地 Whisper 自动识别 → 在时间轴里改文字和时间 → 导出已经烧进字幕的 MP4。

全程在浏览器里完成，视频不会上传。内部数据始终是可编辑的工程 JSON，只有点「烧录并下载」才会把字幕压进画面。

## 能做什么

1. 导入 MP4 / MOV / WebM
2. 本地 Whisper 自动识别（也可导入已有 SRT / VTT）
3. 改错字、调起止时间、拆分 / 合并句子
4. 点某一行或时间轴色块，视频跳到对应位置
5. 撤销 / 重做，保存 / 打开 `*.project.json`
6. 调字体、颜色、描边、位置、逐词高亮
7. 导出 SRT / VTT，或导出 `{原名}_captioned.mp4`

## 本地运行

需要 Node.js 18+（推荐 22）。推荐 Chrome 或 Edge。Safari 可能走更慢的导出路径。

```sh
npm install
npm run dev
```

打开 http://localhost:4321

第一次点「自动识别」会下载 Whisper 模型（大约 286–463 MB），之后缓存在浏览器 IndexedDB。没有 GPU 时会走 CPU，速度明显更慢。

## 工程文件

`*.project.json` 只保存字幕、样式和原视频文件名，不包含视频本身。再次打开时先载入工程，再选一次原来的视频。

## 许可

MIT。识别与烧录引擎改编自 [BurnSub](https://github.com/Xley9/burnsub)（MIT）。详见 [NOTICE](NOTICE) 与 [LICENSE](LICENSE)。
