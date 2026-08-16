# Spectra Video Studio — Product Backlog

このファイルは、ユーザーから出た製品要望・UX改善・人間レビュー項目の **source of truth** とする。
`docs/EDITOR_BACKLOG.md` は低レベルの技術負債・実装メモとして残し、このファイルは「何を実現したいか」「今どの状態か」を管理する。

## 運用ルール

### Status

- `IDEA` — アイデア段階。設計・実装をまだ開始しない。
- `PLANNED` — 方針が固まり、今後の実装候補。
- `IN_PROGRESS` — Luna/Codexで作業中。
- `READY_FOR_HUMAN_REVIEW` — 自動テストは通ったが、GUI・聴感・操作感の人間確認が必要。
- `DONE` — 実装・回帰確認済み。主観評価が必要な項目は人間確認後のみDONEにする。
- `BLOCKED` — 外部依存または原因未確定で停止中。
- `VERIFY` — 過去に要望が出た、または条件依存で再現が必要な項目。

### ChatGPT / Luna workflow

1. ChatGPTはLunaへ新しい作業指示を出す前に、このファイルを参照する。
2. ユーザーの新要望は、原則としてまずこのファイルへ追記する。ユーザーが「今すぐ直して」と明示しない限り、勝手に実装開始しない。
3. ChatGPTが設計・優先順位・切り分けを行い、Lunaには一度に一つの単純な作業を順番に渡す。
4. Lunaは作業開始時に対象IDを`IN_PROGRESS`へ変更し、完了時にテスト結果・commit SHA・残課題を反映する。
5. Lunaは別項目をついでに実装しない。
6. `READY_FOR_HUMAN_REVIEW`の項目をLunaだけの判断で`DONE`にしない。
7. 大規模なarchitecture変更は、原因計測または設計判断を先に行う。
8. `clip_automation → edit_project.json → video_editor`の境界は維持し、repo間の直接import依存を作らない。

---

## Current priorities / active investigation

### AUD-001 — Preview再生してもスピーカーから音が出ない

**Status:** `READY_FOR_HUMAN_REVIEW`

**User feedback:** Timelineを再生しても、スピーカーから音声が正常に出力されない。

**Priority:** 高。通常編集の基本動作なので、次に実装へ進める場合は最優先でroot causeを切り分ける。

**Investigation direction:**

- source media自体にaudio streamが存在するか。
- Previewで使用している`HTMLMediaElement` / audio elementがmutedになっていないか、volumeが0になっていないか。
- video/audio clipのlinked状態、track mute/solo、asset mapping、sourceIn/sourceOut後もaudio sourceが正しいか。
- split / merge / trim後にaudio elementのsource/time mappingが壊れていないか。
- Electron/Chromiumのaudio output device問題か、Project model / Preview wiringの問題かを切り分ける。
- Final renderのaudioとは別問題として扱い、まずPreview playback pathだけを調査する。

**Implementation (Stage 28.2):**

- Previewの映像要素はmutedのまま維持し、独立したaudio contributionをOS標準出力へ再生する経路を修正。
- Timeline play/pause、seek、clip境界、split/trim後のsource time、mute、volumeを共通のPreview audio mapping helperで処理。
- Timelineのplayhead更新ごとに`audio.play()`を乱発せず、active clipの切替時だけ再生を開始する。
- targeted 31 tests、typecheck、build、Electron startup smokeをPASS。commit `0a54ce3`を含む通常mergeでorigin/mainへpush済み。

**Human acceptance:** Timeline再生で、映像と同期した音声が通常のOS出力デバイスから連続再生されること。

**Remaining:** 実ユーザーmediaを使ったOS出力の聴感確認と、split/trim/mute/volumeを含むGUI acceptance。

### PREV-001 — Fast Preview字幕が現在時刻へ追従せず古い1枚を表示する

**Status:** `IMPLEMENTED — HUMAN ACCEPTANCE PENDING`

**User feedback:** 高速Previewで字幕が正しく更新されず、数秒前に描画できた1枚の字幕overlayがそのまま残っているように見える。

**Implemented:**

- Fast Preview overlayはcue IDだけでなくsubtitle visual keyにも一致する場合だけ表示する。
- cue切替、cue終了、字幕なし区間、同一cueのtext/style変更で旧overlayを即時無効化する。
- staleなin-flight resultはsequenceと現在のactive subtitle identityの両方でcommitを拒否する。
- stale requestが残っていても、最新cueのrender requestを待たせない。
- prefetch keyはoverlay request lifecycleごとにリセットし、project/cue変更後のcache warm-upを抑止しない。

**Scope:** Stage 28.3ではFinal / Accurate Previewのauthorityとrender pathは変更していない。Stage 27.1Bでは字幕表示あり/hiddenでCPU差はなく、overlay自体のCPU高負荷は観測されていないため、今回の問題はperformanceではなくstale presentation / synchronization bugとして修正した。

**Human acceptance:** 再生中、字幕cue boundaryに合わせて字幕が切替・消失し、過去cueの画像が残留しないこと。

### PERF-001 — Previewの実ユーザー環境での高CPU・非リアルタイム再生

**Status:** `VERIFY`

**User need:** Preview再生がCPU 100%近くになり、リアルタイムに追いつかないケースを解消したい。

**Current evidence:**

- Stage 27.1: 自動再現ではTotal CPU約25〜27%。FFmpeg / Accurate Previewは再生中に未稼働。
- Stage 27.1B: 実字幕68件の表示あり/hiddenをA/B比較してもTotal CPU約17.8〜17.9%で差なし。
- 字幕overlay自体は主要因ではない可能性が高い。
- Stage 27.1C: 低オーバーヘッドのPreview Performance Diagnostic UIをローカル未commit状態で実装。targeted 14 tests、typecheck、build PASS。
- 診断では再生、rAF、React/store、字幕overlay/cache、waveform、Accurate Preview/FFmpeg、表示条件、JS heapを集計できる。
- 毎frame大量logは行わず、counter/aggregateのみで停止時にsummaryを出す。
- 最新の人間確認ではCPU/GPU使用率は問題ない状態だった。
- ユーザー推測として、clipの結合など複数編集を重ねた後に高負荷化する可能性がある。

**Next reproduction target:**

- 単純な字幕有無A/Bではなく、split / merge / trim / 結合など編集操作を複数回行ったProjectで再現するか確認する。
- 高負荷が再発した場合だけStage 27.1C diagnosticを取得する。
- 問題が出ていない通常状態ではperformance修正を進めない。

---

## Timeline UX

### UX-TL-001 — 再生ヘッド追従の自動スクロール

**Status:** `IMPLEMENTED — HUMAN ACCEPTANCE PENDING`

再生中、再生ヘッドがTimeline viewport右端へ達したら、再生を止めずに次の領域へ自動スクロールする。

**Acceptance direction:**

- playheadが画面外へ消えない。
- 自動追従で再生位置がジャンプしない。
- ユーザーが手動でTimelineを操作している最中の挙動は干渉しすぎないよう設計する。

**Implemented:**

- 再生中にplayheadがviewport右端へ到達した場合だけ、Timeline viewportを次の領域へ進める。
- scroll位置だけを変更し、playhead timeは変更しない。
- 右端到達前・overflowなし・Timeline末尾ではscrollせず、同じ位置での更新によるjitterを抑止する。

**Human acceptance:** 実動画の連続再生でplayhead追従が自然に見え、再生が停止・ジャンプしないこと。

### UX-TL-002 — 再生ヘッドdrag時のedge auto-scroll

**Status:** `IMPLEMENTED — HUMAN ACCEPTANCE PENDING`

再生ヘッドをdragしてTimeline viewport左端/右端へ近づけたとき、pointerを保持したままTimelineを連続スクロールする。

**Acceptance direction:**

- edge proximityに応じてscrollを開始。
- pointer captureを維持。
- playheadとtime mappingがずれない。
- zoom倍率に依存して操作不能にならない。

**Implemented:**

- playhead drag中、pointerがviewport左右48px以内にある間はRAFで連続scrollする。
- pointer captureをdrag終了まで維持し、scroll後も同じpointer座標を現在のscrollLeftで再計算する。
- edgeから離れた位置ではscrollせず、Timeline末尾・先頭ではclampして不要な更新を行わない。

**Human acceptance:** 実動画でplayheadを左右端へ保持してdragし、連続scroll・pointer capture・time mappingが自然に維持されること。

### UX-TL-003 — Timeline clip labelの可読性改善

**Status:** `IMPLEMENTED — HUMAN ACCEPTANCE PENDING`

**User feedback:** clip内の文字が小さく、見づらい。

**Design goals:**

- clip名・主要情報のfont size / weight / contrastを改善。
- 狭いclipでの省略表示を整理。
- 選択状態、video/audio/subtitle種別、linked状態を視覚的に判別しやすくする。
- 情報量を増やしすぎてTimelineを窮屈にしない。

**Implemented:**

- labelを10px・weight 700へ調整し、種別ごとの色とコントラストを改善。
- selected state、linked state、video/audio/subtitle種別を明示。
- 狭いclipではlabelを隠し、種別iconを優先するresponsive表示を追加。
- clip DOMの大規模再設計、ResizeObserver、data model変更は行わない。

**Human acceptance:** 実動画・複数zoomでlabel、種別、selected/linked表示の可読性を確認する。

### UX-TL-004 — Video / Subtitle対応関係の可視化

**Status:** `IMPLEMENTED — HUMAN ACCEPTANCE PENDING`

**User idea:** video clipとsubtitle clipを密に連携させ、字幕の区切れ位置と映像の編集位置の対応をTimeline上で分かりやすくしたい。字幕を映像clip上へ重ねて見せる案も含む。

**Design questions:**

- data model上のlinked relationshipと、Timeline上のvisual overlayを分離して考える。
- SubtitleWord / SubtitleClipのsource/timeline mappingを使い、字幕boundaryをvideo clip上へguideとして表示できるか検討する。
- subtitle track自体を物理的にvideo trackへ統合するかは未決定。既存track modelや編集性を壊さない設計を優先する。
- linked video/audio/subtitleを選択・split・trimした際の対応関係を視覚的に示す。

**Implemented (Stage 29.3):**

- subtitle trackを正式な編集場所として維持。
- 現在のsubtitle clipのstart/endが重なるvideo clip内に、派生boundary guideを表示。
- video clip外のboundaryは表示しない。
- split / trim後もProject Modelの現在のtimeline timingから再計算。
- 長尺Timelineではviewport近傍のvideo clipだけguideを生成。
- data model、`linkGroupId`、永続video/subtitle linkは変更しない。

**Human acceptance:** 実動画で字幕境界guideの位置と、subtitle split / trim後の追従を確認する。

**Implemented (Stage 29.4 / UX-TL-004B):**

- hoverまたはselectしたvideo/subtitle clipを起点に、現在のTimeline上で正の時間的overlapを持つ相手候補を相互highlight。
- 複数のvideo候補がある場合はすべて表示し、単一の正解linkを推定しない。
- 通常時に追加DOMを生成せず、hover/select中だけ候補表示。
- candidate relationは表示時の派生情報であり、data model、`linkGroupId`、永続video/subtitle linkは変更しない。

**Human acceptance:** 複数video候補を含む実動画で、hover/select時の候補highlightが意図どおり表示され、subtitle trackの編集操作を妨げないこと。

**Correction (Stage 29.4.1):** candidateはvideo↔subtitleのcross-type overlapだけを対象とし、video↔videoおよびsubtitle↔subtitleは候補に含めない。

### UX-TL-005 — Ruler drag scrubbing

**Status:** `IMPLEMENTED — HUMAN ACCEPTANCE PENDING`

既存`EDITOR_BACKLOG.md`由来。rulerの空白位置からpointerdownして、そのままdragでplayheadを連続scrubできるようにする。

**Implemented:**

- rulerのpointerdownで即時seekし、pointer capture中のpointermoveで連続scrubする。
- pointerup / pointercancelでlistenerとcaptureを終了する。
- rulerの現在位置とhorizontal scrollを含むmappingを共通関数で計算し、clip dragのイベント経路には干渉しない。

**Human acceptance:** rulerの空白位置からdragして、pointerを保持したままplayheadが連続移動すること。

### UX-TL-006 — Timeline zoom range拡張

**Status:** `PLANNED`

既存28–220 px/secより広い範囲を検討。長尺overviewとsub-second編集を両立する。

### UX-TL-007 — Shift不要の横スクロール

**Status:** `DONE`

過去のユーザー要望: Timelineを左右移動する際、Shift+wheel必須ではなく通常のpointer/wheel操作で自然に横スクロールできるようにしたい。現在実装状態を再確認する。

**Verified:**

- `.timeline-viewport`の通常wheel handlerが`shiftKey`を要求せず、`deltaX + deltaY`を`scrollLeft`へ反映している。
- Shiftなしの通常wheelでも横scrollでき、Ctrl/Cmd wheelだけは既存のzoom操作として分岐する。
- 追加コード変更なし。既存Timeline interaction 13 testsをPASS。

### UX-TL-008 — 右クリックcontext menu / Split discoverability

**Status:** `DONE`

過去のユーザー要望: clip右クリックからSplit、Delete等の主要編集を呼び出せるようにし、分割方法がUI上で分かりやすい状態にする。現在実装状態を再確認する。

**Verified:**

- clip右クリックで対象clipを選択し、Split、Delete、Ripple Delete、Copy、Paste、Duplicateをcontext menuから実行できる。
- subtitle clipでは、単語境界情報がある場合に「ここで字幕を分割（単語境界）」、不足時は理由付きdisabled表示になる。
- locked trackではSplit/Delete/Ripple Deleteをdisabledにし、ロック理由を表示する。
- context menu外のpointerdown、Escape、window blurでmenuを閉じる既存挙動を確認した。
- 大規模UI変更なし。既存Timeline interaction 13 testsをPASS。

---

## Silence Cut / linked editing

### SIL-001 — Timeline編集に追従する動的Silence Cut

**Status:** `IMPLEMENTED — HUMAN ACCEPTANCE PENDING`

**User need:** 手動で新しいcut / trim / splitを行ったあと、その現在の編集状態を基準に、残っている無音区間も適切に除去できるようにしたい。

**Architecture direction:**

- 原音声signalをsilence authority、raw Whisper word timingをspeech protection authorityとする原則は維持する。
- Silence analysis結果を一度だけTimelineへ焼き付けて終わりにせず、現在のsource→timeline mappingへ再適用できる構造を検討する。
- 手動cut後に既に削除済みのsource rangeを再処理しない。
- clip split / trim後もsource identityを失わない。
- subtitle derived timingをspeech protection authorityにはしない。
- filler removalは行わない。

**Decision (Stage 29.2):**

- ユーザー明示の「無音カットを再適用」を採用する。
- 編集操作ごとの自動再解析は行わない。
- 既存analysis cacheは正当性を確認できる場合だけ補助利用し、現在実装では現在clip範囲をFFmpegで再解析する。
- split / trim / deletion後は現在の`sourceInUs` / `durationUs`を入力とする。
- linked A/Vは同一cut planで処理し、original mediaは変更しない。
- FFmpeg audio signalをsilence authority、raw Whisper wordsをspeech protection authorityとする。
- `SubtitleEditUnit`とsubtitle boundaryはspeech authorityにしない。
- 成功時は一回のhistory transaction、no-op・failure・cancel時はProject unchangedとする。

**Implemented:**

- Inspectorに「無音カットを再適用」とキャンセル操作を追加。
- 現在のmedia clip範囲を対象にした独立Silence Analysis serviceとIPCを追加。
- targeted testsでsplit、trim、deletion、already-cut source gap、linked A/V、speech protection、no-op、Undo/Redo、failure/cancelを確認。

**Human acceptance:** 実動画で再適用を実行し、speechを保護したまま無音だけが短縮されることを確認する。

**Resolved / remaining:**

- Stage 29.2でユーザー明示の再適用を実装済み。
- Stage 29.10で再適用profileを「自然 / 強め / YouTubeジャンプカット」から選択可能にし、defaultをYouTubeジャンプカットへ統一。Auto Captionの初期silenceCutも同じdefaultに変更。
- profile設定（min silence、retain pause、noise threshold、speech protection、filler removal）はshared resolverで一箇所に集約し、IPCでは`off`を受け付けない。
- 将来のanalysis cache再利用と、subtitleを保持したまま複数media segmentへ再適用する実動画受入は保留。

### SIL-002 — YouTubeジャンプカットprofile

**Status:** `READY_FOR_HUMAN_REVIEW`

- min silence 300ms
- retained pause 80ms
- FFmpeg signal authority + raw Whisper speech protection
- filler removalなし
- generated fixtureでは実cut確認済み

**Remaining:** 実人間音声で、詰まり具合・speech clipping・click/popの聴感確認。

### SIL-003 — Silence Cut実行結果の可視化

**Status:** `DONE`

Auto Processing summaryでprofile、候補数、実cut数、削除時間、元/編集後duration、OFF/no-op/skipを表示。

---

## Subtitle Template / Caption UX

### SUB-001 — Full Template Editor + custom preview text

**Status:** `DONE`

Stage 25でSubtitleStyle全項目、maxChars/maxLines、quality/layout constraints、multiline custom previewを実装。built-in immutable。

### SUB-002 — Font family dropdown

**Status:** `DONE`

Stage 26。`window.spectra.listFontFamilies()`を再利用し、Windows registry由来font、日本語font名、fallback、保存/Preview反映を実装。

**Evidence:** video_editor Stage 26 commit `f1c72318759d9596abb09e201985a915bd43eb8a`。

### SUB-003 — maxWidthPercent 100% semantics

**Status:** `DONE`

Stage 26。outer max-width line boxとinner text/background boxを分離し、50%=960px、80%=1536px、100%=1920pxを共有geometryとしてPreview/Accurate/Finalで確認。

**Evidence:** video_editor Stage 26 commit `f1c72318759d9596abb09e201985a915bd43eb8a`。

### SUB-004 — Subtitle text correction UX

**Status:** `DONE`

現行Inspector本文編集・split/merge/boundary操作は人間レビューで概ね良好。全面rewriteは不要。

---

## Auto Processing reliability / UX

### AUTO-001 — Progress UIが70%付近で停止して見える問題

**Status:** `DONE`

Stage 26で、実測可能なWhisper progressのみdeterminate化。音声準備・無音解析・字幕区切り・Timeline適用はindeterminate + spinner、stage名と経過時間を表示。parallel worker progress forwardingも修正。

**Evidence:** video_editor `f1c72318759d9596abb09e201985a915bd43eb8a` / clip_automation `7e32a945cf0d26348c08403034b7123823ac6b50`。

### AUTO-002 — AUTO_CAPTION_FAILEDの原因隠蔽 / stale transcript sentinel

**Status:** `DONE`

Stage 26で`NO_SPEECH` / `CAPTION_SEGMENTATION_FAILED`等のdiagnostic保持、品質系failureのrule fallback、raw word ownership保持、true silence fail-closedを実装。

実GUIで発生した0-word問題のroot causeは、処理中断時に先行作成された`transcript.json=[]`を正規結果と誤認したこと。空sentinel先行作成を廃止し、Whisper成功後のみatomic writeへ変更。

**Real-video evidence:** 約155.5秒、546 raw words、68 captions、正常publish。5秒無音fixtureは`NO_SPEECH` fail-closed。

**Evidence:** video_editor `f1c72318759d9596abb09e201985a915bd43eb8a` / clip_automation `7e32a945cf0d26348c08403034b7123823ac6b50`。

---

## Performance / Rendering technical backlog

### ENC-001 — GUI renderでのNVENC利用確認

**Status:** `DONE`

Stage 30.1で、RTX 3060 / FFmpeg 6.1.1のdirect NVENCは成功する一方、`probeEncoder()`の既定128x128がNVENC最小寸法を下回るためfalse-negativeになることを確定。Stage 30.2で既定probeを256x256へ修正し、明示サイズと既存偶数化を維持した。

実機force detectionは`h264_nvenc available=true`、`selectedId=h264_nvenc`、reasonなし。Electron preload→main IPCのproduction-like exportで、1920x1080のauto/hardwareはh264_nvenc、softwareはlibx264、4K autoもh264_nvencで完了。全出力はH.264/AAC、3秒、non-zero。`ExportDialog`の再検出時に、ユーザーが明示選択していない場合だけ新しい`selectedId`へ同期する回帰も追加した。

### PORT-001 — Self-contained portable Auto Caption

**Status:** `PLANNED`

現状はdev/external worker方式で、Python、faster-whisper、Whisper model、FFmpeg等へ依存。将来的にはneutral `spectra_caption_engine`等への分離/配布方法を検討する。

Stage 30.1 decision: Product directionはengine bundled + model first-run download/cache、Developmentはexternal Python workerを維持。Ollamaはoptionalでrule fallbackあり。コード変更は未実施。

### PERF-001 checkpoint — Stage 30.2

`VERIFY`を維持。NVENC detection修正とは分離し、Previewの専用long-run instrumentationは追加しない。2〜3分再生と25/50編集後の高CPU再発runtime evidenceが揃うまで、原因確定・最適化へ進まない。

---

## Completed checkpoint

### Stage 26

**Status:** `DONE`

- video_editor: `f1c72318759d9596abb09e201985a915bd43eb8a`
- clip_automation: `7e32a945cf0d26348c08403034b7123823ac6b50`
- video_editor: 54 files / 313 tests PASS
- clip_automation: 307 tests + compileall PASS
- typecheck / build / Electron startup / interaction / accurate-preview / subtitle geometry / parity PASS

### Stage 28 checkpoint — Preview / Timeline UX integration regression

**Status:** `CHECKPOINT COMPLETE — ONE PRE-EXISTING TEST FOLLOW-UP`

- 対象: Stage 28.2〜28.8（Preview audio、PREV-001、Timeline follow scroll、drag edge scroll、ruler scrub、shift-free horizontal scroll、context menu）。
- `npm.cmd run build`: PASS
- Electron startup smoke: PASS
- interaction smoke: PASS
- accurate-preview smoke: PASS
- subtitle parity: PASS
- subtitle geometry: PASS
- Timeline interaction regression: 13 tests PASS
- Stage 26 representative regression（Auto Caption / Template / Font dropdown / maxWidth）: 6 files / 49 tests PASS
- full test suite: 56 files / 325 tests中324 PASS。残る1件は`tests/main/ffmpeg-integration.test.ts`のoverlay cache metadata（初回`cacheHit=false`と2回目`cacheHit=true`を完全一致比較）で、Stage 28変更とは無関係の既存期待値不一致。今回のscope外のため修正していない。

### Stage 29 checkpoint — Timeline readability / subtitle candidates / silence reapply

**Status:** `CHECKPOINT COMPLETE — HUMAN ACCEPTANCE PENDING`

- UX-TL-003 clip label readability、UX-TL-004A subtitle boundary guides、UX-TL-004B cross-type candidate highlightを統合回帰。
- SIL-001 explicit silence reapply（split / trim / deletion / already-removed range / speech protection / linked A/V / no-op / cancel-failure atomicity / Undo-Redo）を確認。
- Stage 29.2のFFmpeg overlay cache semantic assertion（cold `cacheHit=false`、warm `cacheHit=true`）を含む回帰を確認。
- `npm.cmd run check`: 58 test files / 340 tests PASS。
- targeted regression: 10 test files / 90 tests PASS。
- typecheck / build / Electron startup / interaction / accurate-preview / subtitle geometry / subtitle parity smoke PASS。
- data model、`linkGroupId`、永続video/subtitle linkは変更なし。

**Human acceptance:** 実動画でclip labelの可読性、subtitle boundary guideの位置、cross-type候補highlight、silence reapplyの操作感を確認する。

---

## Notes for future Luna tasks

- 一度に複数の大きな要求を渡さない。
- まず計測・root cause、次に最小修正、次にtargeted test、最後に統合回帰とcommit/pushを分離する。
- GUIの見た目・操作感・聴感は自動テストだけでDONEにしない。
- ユーザーが単にアイデアを出した場合、このファイルへ記録するだけに留め、実装指示は出さない。
