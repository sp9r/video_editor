# Phase 8: Parallel Auto Processing

## Boundary

video_editorは`clip_automation`をimportせず、local processのversioned JSON boundaryだけを使う。worker discoveryで`spectra_auto_processing_worker.py`が利用できる場合にparallel pathを選び、存在しない場合は既存`spectra_caption_worker.py`へfallbackする。

parallel pathは、選択clipのsource rangeをmain processで直接全体decodeせず、worker側で一度だけbounded audio rangeへ抽出する。その同じtemporary WAVを、Whisper transcriptionとFFmpeg `silencedetect`へ渡す。silence resultはcaption resultへ無理に拡張せず、別artifactとして検証する。

## Runtime flow

```text
selected clip
  → one bounded range audio preparation
      ├─ GPU-first Whisper transcription
      └─ CPU FFmpeg signal silence analysis
  → raw-word speech protection
  → caption segmentation
  → result validation
  → one atomic subtitle-track apply
```

`edit_project.v1`、baseline schema、caption result schemaは破壊していない。progress stateへ`silence_analyzing`を追加し、rendererには「無音解析」を表示する。worker完了後は「字幕をTimelineへ適用中」を表示してから既存の一括history transactionを実行する。

## Safety

- main processはworker commandを固定argvで起動し、rendererから任意commandを受けない。
- requestには必要なlocal media pathだけを渡すが、result、silence artifact、baselineへpathを保存しない。
- silence artifactはinteger microseconds、`fillerRemoval=false`、signal authority、word protection diagnosticsを持ち、main processでsize・schema・path-free diagnosticsを検証する。
- cancelはcaption/silenceへ共通Abortとして伝播する。成功前はProjectFileを変更しない。
- parallel workerが無い場合はserial caption workerへ安全にfallbackする。

## Acceptance evidence

生成QA media `stage8-ja.mp4`の10秒範囲、rule segmentation、GPU `large-v3`で実測した。

- serial（range preparationを含む）: 9,430.9ms
- parallel（range preparation 1回、Whisper ∥ silence）: 8,081.4ms
- wall time短縮: 約14.3%
- raw words: 32
- silence artifact: 生成成功

parallel pathは実測で短縮したため採用する。GPU/CPU backendの詳細は既存runtime diagnosticsをauthorityとし、parallel化だけでGPU利用成功とは判定しない。
