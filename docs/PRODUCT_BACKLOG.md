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

**Stage 31.1 correction:** 人間確認でFast Previewの字幕追従が再び失敗したため、旧acceptanceをFAILEDとして再オープンした。再生中は全active cueをCSSのcanonical render specから即時描画し、FFmpeg字幕overlayへ依存しない経路へ変更。stale bitmap / in-flight overlayの残留を廃止した。Accuracy/Finalは従来どおりpaused時のauthorityとする。実GUIでの再受入れ待ち。

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
- Stage 31.1では、再生中のFast subtitle FFmpeg overlay requestを停止し、連続silence-cut segment向けaudio preview DOMを「active contribution + source assetごとのnext prefetch」に限定した。これは長尺編集時の要素数・毎frame走査を抑える実装上の対策であり、実ユーザー環境での前後CPU計測はまだ必要。

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

**Implemented (Stage 31.1 / UX-TL-004C):**

- defaultの詳細OFFではsubtitle trackをTimeline rowから隠し、現在のsubtitle clipの時間的overlapをvideo clip内へ軽量な派生subtitle blockとして表示。
- blockのclickは実際のSubtitleClipを選択し、text tooltipとselected stateを持つ。詳細ONでは従来のsubtitle track、word editing、split/merge、boundary dragを復元する。
- data model、schema、`linkGroupId`、永続video/subtitle linkは変更しない。viewport近傍の表示clipだけを計算する。

**Human acceptance:** 実動画で詳細ON/OFF、inline blockの選択、split/trim後の再計算、字幕track編集の切替を確認する。

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

**Status:** `IMPLEMENTED — HUMAN ACCEPTANCE PENDING`

4–1000 px/secへ拡張し、長尺overviewとsub-second編集を両立する。既存default 72 px/secは維持する。

**Implemented:**

- slider、zoom in/out、Ctrl/Cmd+wheelを同じ4–1000 px/secのclampへ統一。
- zoom変更時はplayhead付近のscreen位置を維持するようhorizontal scrollを補正する。
- ruler tick生成は長尺でも最大約2,000件に抑え、clip・字幕inline strip・waveformの既存geometryは同じzoom値を使用する。

**Human acceptance:** 4 / 28 / 220 / 500 / 1000 px/secで、playhead、clip、字幕、waveform、ruler、follow/edge auto-scrollの操作性を実動画で確認する。

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

### QA-001 — Project QA Workspace v1

**Status:** `IMPLEMENTED — HUMAN ACCEPTANCE PENDING`

書き出し前にProjectの素材、Timeline、字幕、自動処理メタデータ、export前提をread-onlyで確認するQA panel。

**Implemented:**

- shared pure `runProjectQa()`がerror / warning / info、code、message、関連clip/media、timeline timeを返す。
- offline／未解決素材、source range、visual gap、linked A/V、字幕本文・word timing・maxLines/maxWidth・範囲外・fallback診断、silence metadata、encoder／output設定を確認する。
- QA panelの関連issueクリックでTimeline時刻へjumpし、clipまたはmediaをselectする。
- 明確なERRORがある場合だけExportDialogとmain export IPCをblockし、warning/infoではblockしない。
- QAはProject、history、edit_project contractを変更しない。

**Human acceptance:** 実Projectでissueの検出精度、関連位置へのjump、warningを残したexport、ERROR時のblockを確認する。

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
- Stage 31.3でsource-range operation metadata（Option B）のsafe baselineを実装。元source identity／keep・removed ranges／generated clip signatureを`.spectra`へ保存し、save/reload後も未変更segmentだけ復元する。mappingが曖昧ならfail closedでProject unchanged。edit_project.v1へはmetadataを漏らさない。実GUI受入は未確認のため、`RESTORE HUMAN ACCEPTANCE REQUIRED`を維持する。

### SIL-002 — YouTubeジャンプカットprofile

**Status:** `READY_FOR_HUMAN_REVIEW`

- min silence 150ms
- retained pause 0ms
- FFmpeg signal authority + raw Whisper speech protection
- filler removalなし
- generated fixtureでは実cut確認済み

**Remaining:** 実人間音声で、詰まり具合・speech clipping・click/popの聴感確認。

### SIL-004 — Silence Cut custom minimum threshold

**Status:** `READY_FOR_HUMAN_REVIEW`

Auto Captionと明示Silence Reapplyで、profileの推奨値を初期値としつつ、最小無音時間を0.05〜2.00秒（0.05秒刻み）で一時指定できる。設定はshared profile semanticsから解決し、Project schemaには保存しない。初回bulk cut、speech protection、Undo/Redo、failure atomicityのtargeted testを追加済み。実人間音声での安全側調整は未確認。

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

### Stage 31.1 checkpoint — Human review failure fix batch

**Status:** `READY_FOR_HUMAN_REVIEW`

- PREV-001: 再生中字幕をCSS canonical specへ統一し、FFmpeg Fast overlay依存とstale bitmap残留を除去。paused Accurate Preview / Final authorityは維持。
- PERF-001: 連続silence-cut segmentのaudio preview要素をbounded pool化し、active mixとnext prefetchだけを保持。実ユーザーでの60秒以上の前後runtime計測は要確認。
- SIL-002 / SIL-004: YouTube 150ms / retain 0ms、custom minimum thresholdを初回Auto CaptionとReapplyへ伝播。
- UX-TL-004C: detailed OFF時のinline subtitle strip、detailed ON時の従来subtitle track編集を追加。model/schema/linkGroupId変更なし。
- clip_automationのworker contractへoptional `silenceMinUs`を追加し、既存v1の省略時互換を維持。

**自動確認:** video_editor targeted tests 30件、typecheck、build、accurate-preview smoke、clip_automation contract/silence/parallel worker targeted tests 19件、compileall PASS。実動画の聴感・Preview性能・inline strip操作は人間確認待ち。

### Stage 31.2 checkpoint — Caption segmentation fail-safe

**Status:** `IMPLEMENTED — HUMAN RETEST REQUIRED`

- clip_automationのcaption segmentationをLLM → heuristic → deterministic greedy failsafeの3段階へ拡張。raw Whisper wordsが有効な場合、LLM JSON不良・timeout・boundary optimizer/validation例外・品質post-processing例外でAuto Caption全体を失敗させない。
- Tier 3はraw wordをexactly once、時系列順に消費し、最後のwordまでcoverageする。単一wordが`maxChars`／hard durationを超えても分割・削除しない。
- `CAPTION_LLM_FALLBACK`、`CAPTION_HEURISTIC_FALLBACK`、`CAPTION_FAILSAFE_FALLBACK`をworker result diagnosticsへ伝播。raw words空、timing不正、source mapping不能、worker fatalはfail closed。
- video_editorのコード変更なし。実ユーザーfailed jobのraw artifactは取得できず、最小fixtureでfailure holeを再現・回帰化した。実GUIで元ケースを再実行するhuman retestが必要。

### Stage 31.3 checkpoint — Caption reliability + silence restore baseline

**Status:** `IMPLEMENTED — HUMAN RETEST REQUIRED`

- clip_automationで、実worker実行から`result.json`生成、`spectra.auto-caption.result.v1`の再parseまでをfailsafe回帰化した。LLM／heuristic failure時もraw word ownershipをexactly onceで保持し、diagnosticsを失わない。raw input invalidは従来どおりfail closed。
- video_editorの`.spectra`内部へversionedなsource-range silence operation metadataを追加。初回bulk cutの元source range、keep/removed range、linked A/Vのgenerated clip identity、変更検出signatureを保存し、save/reload後も利用できる。
- Inspectorの「無音カットを解除」は、generated familyが未変更で一意に照合できる場合だけ実行する。split／trim／delete／別clipの重なり等でmappingが曖昧ならProjectを変更せずreject。復元は1 history transactionでUndo/Redoできる。
- metadataはedit_project.v1書き出し時に除外し、`linkGroupId`は既存A/V関係にのみ使用する。実ユーザーcaption E2Eと実動画でのrestore操作感はhuman retest待ち。

### REV-001 / Stage 32.3 — Mass Subtitle Review Workspace v1

**Status:** `IMPLEMENTED — HUMAN ACCEPTANCE PENDING`

- 既存の`useReviewStore`、`ExperimentalReviewRecord`、`review-service`のatomic review logを再利用した字幕レビューWorkspaceを追加。
- 一覧、未確認／修正済み／fallbackフィルター、進捗、1〜4評価、J/K・矢印移動、字幕選択からTimeline／Inspectorへの同期を提供する。
- review状態はProjectFileへ追加せず、既存review logへ保存・再起動時hydrateする。Preview字幕を一覧件数分DOM生成しない。
- 自動テスト・Electron interaction smokeは完了後に確認する。実字幕1000件での操作感、キーボード、表示密度は人間確認待ち。

### LEARN-001 / Stage 32.4 — Editing Learning Dataset v1

**Status:** `IMPLEMENTED — HUMAN ACCEPTANCE PENDING`

- `ExperimentalReviewRecord`から`experimental.learning-dataset.v1`へ変換するshared neutral formatを追加。baseline/final、word ownership、timing、split/merge・text・style correction、rating、eligibilityを含む。
- project identityは匿名hashへ変換し、media本体、absolute path、credential、review provenanceの不要な個人metadataは出力しない。
- stable sample keyでdedupeし、malformed recordは個別skipしてdiagnosticへ記録する。eligible sampleだけをuserDataのlocal aggregated JSONLへ保存し、ユーザー操作でJSONL exportできる。
- model training、network、clip_automationへのdirect importは未実施。dataset formatの実運用・人間受入は保留。

### THUMB-001 / Stage 32.5 — Thumbnail Workspace v1

**Status:** `IMPLEMENTED — HUMAN ACCEPTANCE PENDING`

- 選択したvideo clipのsource rangeから、FFmpegで6候補フレームをuserData配下のcacheへ抽出する。near-black判定で明らかな黒フレームを候補から除外し、元mediaは変更しない。
- 1280x720 canvasでframe、title、任意subtitle、font、size、position、outline、background opacity、shadowを編集・プレビューできる。PNG/JPEGを同じ1280x720でexportする。
- rendererはtyped IPC経由でcandidate抽出・exportを依頼し、candidate cacheは`thumbnail-cache`として管理する。ProjectFile、subtitle template、edit_project contractへthumbnail設定を追加していない。
- AI画像生成、network、repo内への生成物保存は未実施。実動画での視覚品質・候補の意味性・exportファイル選択は人間受入待ち。

### Stage 32.9 checkpoint — Overnight integration regression

**Status:** `AUTOMATED REGRESSION PASS — READY FOR HUMAN REVIEW`

- Caption failsafe E2E、silence restore/reapply、timeline zoom、Project QA、Mass Review Workspace、Learning Dataset、Thumbnail Workspace、Stage 31 Preview、Silence Cut、Auto Caption、NVENC exportの既存実装を統合回帰した。
- video_editorはfull 374 tests、targeted 129 tests、typecheck、build、Electron startup／interaction／accurate-preview／subtitle geometry／subtitle parity smokeがPASS。clip_automationはfull 320 tests、compileallがPASSした。
- 自動検証での未解決regressionはない。実動画の見た目・聴感、Review／Thumbnailの操作感、候補フレームの意味性、NVENC実機結果は自動DONEにせずHuman Review Queueへ残す。

### Stage 33 checkpoint — Memory / Preview / Caption Rail / Tight Cut

**Status:** `IMPLEMENTED — HUMAN ACCEPTANCE PENDING`

- **MEM-001:** Accurate Previewのframe cacheを最大64件に制限し、evicted PNGの後処理削除、project plan変更時のcache clear、明示的project切替時のworkspace cleanupを追加。PNGファイルサイズをdecoded RGBAメモリ量とは扱わず、実機の10/25/50 frameメモリ計測は人間確認へ残す。
- **PREV-002:** render plan更新中に旧planのclip IDで新project映像を隠さないよう一時的にplanを無効化。Accurate frameは共有project fingerprintとplayhead許容frame幅を満たす場合だけ表示し、別project・別時刻のstale frameをcurrent stateへ重ねない。Fast/Accurateの全style parityは既存のlibass/CSS制約を含め人間確認へ残す。
- **UX-TL-009:** defaultの字幕詳細OFFでは、現在のSubtitleClip/editUnitsから派生するattached Caption Railをvideo clip内に表示する。専用surface、caption segment、word/edit-unit tick、選択、tooltip、既存ownership boundary handleを提供し、詳細ONでは正式subtitle trackを表示する。永続link・schema・data modelは変更しない。
- **SIL-005:** `silenceMinUs=0`をvideo_editor／clip_automation contractで受理し、silence operation metadataへprofileと実使用thresholdを保存。未変更のsilence familyだけ、元source範囲をrestoreしてから閾値を再解析する「無音カットを更新」を1 history transactionで適用する。短いcaption gapは既存textを増やさず隣接captionの表示範囲を決定的に延長する。

**Automated evidence:** Stage 33 targeted video tests、typecheck、clip contract/silence/worker targeted testsは実行済み。実動画でのAccurate Preview memory、Fast/Accurate visual、Caption Rail操作、tight-cutの聴感はHuman Review Queueへ残す。

### Stage 35 — Current Product Path Reliability Hardening

**Status:** `IMPLEMENTED — HUMAN ACCEPTANCE PENDING`

- **F02 DONE:** review logの保存を直列化し、最新内容を再読込してupsert、unique temporary file＋atomic rename、失敗時のtemporary cleanupを行う。並列save／同一destination置換／失敗後回復を回帰化。
- **F05 DONE:** Auto Captionのcaption boundary collapseを無言dropせずatomic failureにする。生成subtitle clipへworkerのexact `sourceWordIds`を保持し、point-only timingでもownershipを失わない。
- **F08 DONE:** silence reapply／threshold update／Auto Caption applyのasync mutation前にopen transactionをcommitする。markSaved中のopen transactionもhistoryとclean stateを矛盾させない。
- **F10 DONE:** ThumbnailWorkspaceの非同期画像ロードをrequest sequence＋candidate IDでguardし、古いonloadがcanvasを上書きしない。
- **F11 DONE:** Accurate Preview cache invalidationはgenerationを進め、in-flight FFmpeg完了後のstale PNG公開を防ぐ。clearはin-flight完了後にcache directoryを掃除する。
- **F12 DONE:** viewer quality表示をplaying／accurate match／stale更新中／errorの状態機械に合わせ、高速表示と正確表示を誤表示しない。
- **F13 DONE:** thumbnail cacheをkey単位でcoalesceし、manifest＋frame存在検証、temporary PNGのatomic rename、LRU最大64件、invalidation cleanupを追加。
- **F14 DONE:** Project QAはsilence metadataの破損をerror、restore不能なgenerated familyをwarningとして分類する。書き出し可能性と復元可能性を混同しない。
- **F15 DONE:** standalone edit_project importのproducer metadataはopaque metadataとして`.spectra`内部へ保持する。`edit_project.v1` contractには追加せず、未知キーを権威情報として解釈しない。
- **F16 DONE:** recovery fileへ元Project directoryのprovenanceを保存し、recovery file自身の場所へ移動しても相対media pathを元Project基準で解決する。旧provenanceなしrecoveryは安全側でoffline扱い。
- E2E補助: rendererのE2E project listenerを非同期app-info取得より先に登録し、accurate-preview smokeの起動raceを解消。

**Legacy audit / current-path classification:**

- **F01:** `LEGACY — KEEP TEMPORARILY`。`clip_automation/caption_commands.py`はlegacy `editor_api.py`／`editor_frontend`からのみ到達し、現行Spectra Video Studioのworker→`edit_project`→`video_editor`経路では未使用。
- **F03:** `CURRENT — KEEP / DEFER`。現行worker discoveryがoptional `spectra_auto_processing_worker.py`を優先し、不在時にcaption workerへfallbackする。Stage 35では修正しない。
- **F04:** `LEGACY — KEEP TEMPORARILY`。legacy editorのDelete/RestoreとASS/FFmpeg export経路を対象とし、現行video_editorのlinked edit／silence restoreとは別経路。
- **F06:** `LEGACY — KEEP TEMPORARILY`。legacy `editor_frontend`の`splitTextForCaption`に限定され、現行adapterのcaption segmentationとは別実装。
- **F09:** `UNKNOWN — no concrete active implementation found`。legacy autosaveという記述はあるが、現行sourceの実装到達性を確認できなかったため推測で分類しない。

**F07 evidence (read-only):** playing中は`Preview.tsx`のCSS subtitle fallbackで、cueごとのFFmpeg overlayではない。paused Accurate Previewは`preview:accurate-frame`→FFmpeg＋ASS→PNG、別のstatic overlay APIはanimation none時だけ使用する。accurate-preview smoke実測はcold `187.46ms`、cache hit `0.12ms`、cue switch `7.96ms`。CPU使用率とFFmpeg process countは現行smokeでは **NOT MEASURED**。

**Automated evidence:**

- `npm.cmd run typecheck`: PASS
- `npm.cmd run build`: PASS
- `npm.cmd test -- --maxWorkers=1`: 69 files / 393 tests PASS
- targeted reliability tests: PASS。`npm.cmd run check`の通常並列実行はWindows resource contentionでFFmpeg／thumbnail stressとparent renameがtimeoutするため、single-worker全件を最終判定とした。
- Electron startup / interaction / accurate-preview / subtitle geometry / subtitle parity: PASS
- thumbnail／recovery専用Electron smoke script: package scriptsには未提供。
- `clip_automation`: Stage 35のコード変更なし。既存untracked user filesは保持。

**Human acceptance:** 実動画でreview concurrent save、silence reapply／restore、thumbnail cache再利用、recovery移動、Fast／Accurate切替、字幕の見た目・聴感を確認する。

### Stage 37 — Preview Authority + Async Mutation Contract

**Status:** `IMPLEMENTED — HUMAN ACCEPTANCE PENDING`

- **F07 DONE:** playing中のstatic字幕はCSS文字を使わず、既存libass／FFmpegのtransparent PNG overlayをFast／Accurate／Finalの共通layout authorityとした。animated字幕もlibass base imageを使い、Fastの近似はimage transform／opacity層に限定。cold missは無字幕、request sequence／project fingerprint／visual keyでstale DOM commitを拒否する。
- Fast overlay schedulerはcurrent優先、in-flight 1、prefetch最大2、6秒先まで。overlay cacheはmetadata最大24件、disk最大128MiB、memory／disk LRU、同一key coalesce。seek／edit／load／Undo／Redoでdisplay eligibilityを無効化する。
- **F08 DONE:** renderer-memory-only `PendingAsyncMutation` coordinatorを追加。Auto Caption／Silence Reapply／Threshold Updateは同時に1件だけ実行し、manual mutation／Undo／Redo／loadでconflict＋best-effort cancel、late resultは指定noticeで破棄。valid resultのみopen transaction後に独立1 history entry、no-op／failure／cancel／staleはhistory変更なし。saveはworkerとconflictせず、後続applyでdirtyへ戻る。
- **F03 FALSIFIED AS CURRENT-PATH BUG:** unique mkdtemp、worker exit後のartifact validation、service terminal completion、cleanup、sequential／concurrent job identity isolationをfault-injection testで確認。`CURRENT WORKER CODE`だが`NOT REPRODUCIBLE AS CURRENT PRODUCT CONSISTENCY BUG`としてmanifest／generation persistence redesignを延期した。

**Automated evidence:**

- `npm.cmd test -- --run --maxWorkers=1`: 70 files / 403 tests PASS
- `npm.cmd run typecheck`: PASS
- `npm.cmd run build`: PASS
- Electron startup／interaction／accurate-preview／subtitle parity／subtitle geometry: PASS
- Short production-like accurate-preview: CSS fallback 0、Fast／Accurate glyph geometry parity PASS。実測 cold p50/p95 141.0/143.6ms、cache-hit 0.26/0.31ms、cue-switch 178.7/183.4ms、CPU 1.59%、FFmpeg最大2、dropped video frames N/A（PNG image fixture、video elementなし）、cache 4 entries / 161,901 bytes。
- 120秒 production-like playback with repeated 2秒 cue switches: playback 120,002ms / 119.92fps、cold p50/p95 187.0/189.4ms、cache-hit 0.36/0.46ms、cue-switch 280.1/290.0ms、CPU 0.47%、FFmpeg最大2、dropped video frames N/A、cache 24 entries / 850,707 bytes、renderer working set peak約438MB。これらは現環境のfixture実測であり、optimal limitの主張ではない。

**Human acceptance:** 実動画／720p・1080p・可能なら4Kで、字幕のline break・font fallback・stroke・shadow・background、cue boundary／subtitle-less interval、seek／edit／Undo／Redo中のstale表示なし、Fast animated近似、Auto Caption／silence系race、save while pendingを確認する。長時間計測fixtureはimage sourceのためdropped video framesは未測定。video sourceでの再測定を残す。

### Stage 38 — Final Pre-Reset Fix

**Status:** `IMPLEMENTED — REAL VIDEO E2E PASS / HUMAN ACCEPTANCE PENDING`

- Fast animated字幕はlibass base PNGを唯一の字幕visualとし、再生ヘッドからopacity／scale／slide transformだけを画像へ適用する。独立CSSタイマーやCSS glyph rendererは追加していない。
- schedulerは実行中prefetchがcurrentへ昇格した場合に同じ結果をcurrent commitへ転用する。open manual transaction内の最初の実Project mutationもpending async mutationを即時conflict／cancelする。
- production metricsはElectron起動PIDの子孫だけをmain／renderer／GPU／utility／other／FFmpegへ分類し、無関係なFFmpegを除外するprocess-tree helperと単体テストを追加した。
- Real video smoke fixtureは1280x720 H.264/libx264、30fps、8秒でHTML `<video>`を連続再生する。fixture 346ms、Electron起動約0.3秒、再生8.5秒、report emission成功。dropped 0 / total 4、CSS fallback 0、stale cue 0、subtitle-less gap overlay 0、wrong cue after seek 0、animated transform/opacity observable YES。

**Automated evidence:**

- targeted Stage 38 tests: 4 files / 47 tests PASS
- `npm run typecheck`: PASS
- `npm run build`: PASS
- normal accurate-preview smoke: PASS（CSS fallback 0、Fast／Accurate parity PASS、cold p50/p95 153.97/188.30ms、cache-hit 0.31/0.33ms、cache 4 entries / 161,901 bytes）
- full Vitest: 70 files / 407 tests中、既存 `tests/main/thumbnail-service.test.ts` がWindows resource/cache cleanup timeoutでFAIL（Stage 38変更箇所のtargeted testsはPASS）。
- real video smoke: PASS。CPU total 7.196%、main 0.457%、renderer 4.641%、GPU 2.098%、utility/other 0%、ffmpeg 0%。working set total 814,411,776 bytes、private total 727,162,880 bytes。owned FFmpeg max 0、overlay cache 6 entries / 197,702 bytes。

**Optional P2:** prefetch promotion and immediate transaction conflict implemented; 128MiB direct-cap test not added.

**Human acceptance:** H.264実動画での見た目・聴感、pause/resume、GPU memoryのhuman retestを残す。

---

## Notes for future Luna tasks

- 一度に複数の大きな要求を渡さない。
- まず計測・root cause、次に最小修正、次にtargeted test、最後に統合回帰とcommit/pushを分離する。
- GUIの見た目・操作感・聴感は自動テストだけでDONEにしない。
- ユーザーが単にアイデアを出した場合、このファイルへ記録するだけに留め、実装指示は出さない。
