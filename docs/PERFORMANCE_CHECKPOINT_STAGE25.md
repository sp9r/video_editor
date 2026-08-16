# Stage 25 Performance Checkpoint

2026-08-16時点のPreview調査結果を記録する。

## 観測

- `smoke:accurate-preview` は再生中にFast Previewを使用し、停止時だけAccurate Previewを生成する。
- Accurate Previewは180msのdebounceとsequence guardを持ち、古い結果で新しいframeを上書きしない。
- subtitle overlayはstate fingerprint付きのmemory cacheを持つ。
- 同一overlayのfixtureではcold生成約125ms、cache hit約0.08msを観測した。
- 再生中のsubtitle overlayはauthoritative overlay pathを使用し、再生のたびにFFmpeg Accurate Previewを起動しない。
- `smoke:accurate-preview` の `fastDuringPlay`、`overlayImmediatelyAfterPause`、`accurateAfterResume` はすべてPASSした。

## 分類

現時点で100% CPUの単一原因を断定できる連続profiling traceは未取得。候補は、通常の動画デコード・縮小表示、subtitle overlay、停止時のFFmpeg生成、波形、React/timeline再描画である。

Stage 25では、Preview/WebGL/全体デコードの大規模変更は行わず、既存の低リスク対策（再生中Accurate抑制、debounce、stale request保護、overlay cache）を維持・smokeで再確認した。同一overlayのcache hitがcold生成より大幅に短いことも確認した。

長尺素材での継続CPU計測と、デコード・波形・overlay・React再描画を分離したprofileは次の性能調査課題とする。
