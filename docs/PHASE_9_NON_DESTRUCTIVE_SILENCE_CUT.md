# Phase 9: Non-Destructive Silence Cut Apply

## 適用境界

`clip_automation` の `silenceAnalysis.keepRanges` は、動画／音声ファイルを変更せずに、選択中の単一media clipへ適用する。video_editorはworker内部をimportせず、Stage 8の検証済みprogress artifactだけを受け取る。

## 適用ルール

- keep rangeはsource absolute integer microsecondsで、選択clipの`sourceInUs`から`sourceInUs + durationUs`の範囲内である必要がある。
- selected clipは同じassetを参照する複数segmentへ置換される。各segmentの`sourceInUs`と`durationUs`はkeep rangeそのもの、timelineは元clipの開始位置からgaplessに再配置する。
- linked video/audioは同じkeep plan、同じtimeline segment境界で分割する。segmentごとに新しいlink groupを維持する。
- original media assetとmedia fileは読み取り専用で、FFmpegによる上書きは行わない。
- target intervalの途中にある非対象clipは安全なrippleを保証できないためrejectする。target終了時刻以降のclipだけを削除時間分だけ左へ移動する。reject時はProjectFileとhistoryを変更しない。

## Auto Captionとのtransaction

parallel auto-processingの完了resultにkeep rangesがある場合、silence cutと新規自動字幕trackを1回の`applyProject`へ合成する。したがってCtrl+Z一回で、無音短縮と生成字幕を同時に元へ戻し、Redo一回で同じ状態を復元する。source-absolute caption/word timingはkeep rangesで圧縮後のtimelineへ写像する。

既存字幕などがtarget intervalと重なる場合は、既存trackを暗黙に壊さず全適用をrejectする。silence analysisが存在しない従来worker経路では字幕だけを従来どおり適用する。

## 検証

`tests/shared/silence-cut.test.ts`でlinked A/V、source/timeline範囲、gapless ripple、media非変更、安全reject、source time mappingを確認し、`tests/renderer/auto-caption.test.ts`で字幕とkeep rangeの一括Undo/Redoを確認する。
