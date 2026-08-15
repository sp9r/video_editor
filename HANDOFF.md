# Spectra Video Studio 開発引き継ぎ

## 2026-08-15 Stage 7 Full-Correction Session / Whole Track Before-After Capture

- Auto Caption trackの字幕を選択して「全文修正」を開始し、通常のEditor操作で全trackを修正後、「修正完了」でbefore/after差分summaryを保存するworkflowを追加した。途中ratingは不要。
- beforeは`experimental.auto-caption-baseline.v1`から再構成し、afterはfinish時点の同じtrackから取得。`sourceJobId`、`sourceCaptionId`、raw word ID、editUnit IDでunchanged / split / merge / boundary_move / text_edit / delete / timing_edit / mixedを導出する。
- active sessionはuserDataの`experimental.full-correction.v1`へatomic保存し、crash/reload後にresume可能。artifactはpath/credential/media本体を含まない。
- 既存A/B/C/D Review Mode、`experimental.phase3.5b1`、`edit_project.v1`、caption algorithmは変更していない。
- 詳細: `docs/PHASE_7_FULL_CORRECTION_SESSION.md`
- Stage 7専用テストを追加。Stage 8、publish、mass Human Reviewは未着手。

## 2026-08-15 Stage 6 Caption Display Constraints / max_chars + max_lines

- Stage 1/2からworkerへ渡っていた`maxLines`が、video_editorのProject Model・Preview・ASSへ保存／伝播されていなかった欠落を修正した。`max_chars`はcaption block境界、`max_lines`は表示layout制約として分離した。
- 内部`.spectra`のSubtitleClipへoptional `maxLines`（1〜16）を追加。`edit_project.v1`は変更せず、旧Projectとcontract importは既定2行で動作する。
- canonical `SubtitleRenderSpec`が同じwrapped text、line count、diagnosticをCSS PreviewとFinal libassへ供給する。overflow時は本文を破壊せず`MAX_LINES_EXCEEDED`を出す。
- Auto Caption dialogへ最大行数（既定2）を追加し、worker request、baseline、generated captionへ伝播する。
- Accurate Preview overlayとFinal libass frameの実画像line-bandを比較するintegration testを追加。詳細は`docs/PHASE_6_MAX_LINES_READINESS.md`。
- Gateは全テスト・build・visual smoke完了後に確定する。

## 2026-08-15 Stage 5 Japanese Edit Boundary / Timing Readiness Gate

- 病理的な日本語raw word `皆さんこんばんはアルマジロウです` を4つのderived edit unitへ分解し、concat fidelity、parent source identity、単調時刻、`estimated` provenanceを専用回帰で固定した。内部境界は比例配分であり、acoustic alignmentとは扱わない。
- Razor split、merge、隣接caption ownership移動、Magnet snap、Alt bypass、Undo/Redoは既存shared operationと回帰テストで確認。raw word途中のsplitではraw wordを子captionへ二重所有させない。
- 実用分類は **B: 多少ズレるがmanual correction可能**。current-source GUI受入は既存`docs/PHASE_3_5A_5_VISIBLE_GUI_ACCEPTANCE.md`のPASS記録を参照し、今回新たな実音声GUIレビューを実施したとは扱わない。
- Gate: **EDIT BOUNDARY PRACTICAL: YES / FINE ALIGNMENT REQUIRED BEFORE HUMAN REVIEW: NO**。詳細は`docs/PHASE_5_JAPANESE_BOUNDARY_READINESS.md`。
- Stage 5専用テスト追加後の対象回帰は48 tests PASS。全体Gateはこの後に再実行する。

## 2026-08-15 Stage 4 Auto Caption UI / Atomic Subtitle Apply

- 自動字幕dialogを追加。対象clip、言語（日本語／自動判定）、最大文字数（既定32）、区切り（高品質／ルール）を指定でき、worker progressを音声準備・文字起こし・字幕区切り・字幕配置として表示する。生成中はcancel可能で、UI threadをblockしない。
- worker成功後にresultを全件検証してから、`自動字幕`、`自動字幕 2`…の新規subtitle trackへ全captionを一括適用する。既存字幕trackは変更せず、適用は一つのProject history changeなのでCtrl+Z一回／Redo一回でtrack全体を戻す／復元する。
- caption textとowned raw word textが完全一致し、正のtimingを持つ場合のみSubtitleWordとSubtitleEditUnitを生成。不一致やunsafe timingではword truthを付けず、caption textだけを保持する。worker caption ID/job IDとraw word IDでlineageを保持する。
- generated captionは既存のRazor、word boundary split、merge、boundary drag、playhead snap、Alt scrub、Inspector edit、Review Mode、Save/reloadへ既存Project Model経由で接続する。
- `clip_automation/spectra_caption_worker.py`は`language: "auto"`をfaster-whisperの`None`へ変換し、実際の言語自動判定を利用する。
- Stage 4 tests: atomic apply、one undo/redo、existing subtitle protection、rerun naming、word mismatch safety、lineage、edit units、worker auto languageを追加。video_editor check 41 files / 224 tests PASS、build/smokeは次のGateで再確認する。

## 2026-08-15 Stage 3 Auto Caption Worker Integration

- `src/main/ai/worker-discovery.ts`を追加。userDataの`auto-caption-worker.json`、環境変数、兄弟`clip_automation`の順でworker/Pythonを解決し、source codeやProjectFileへabsolute worker pathを埋め込まない。未発見時healthはpath-free unavailableを返す。
- `src/main/ai/auto-caption-service.ts`を追加。main processだけがselected clipのmedia path/source rangeを解決し、formal `spectra.auto-caption.request.v1`をshell:falseの外部workerへ渡す。progress、timeout、cancel、size/version/range/ownership validation、safe error、atomic baseline保存を一元管理する。
- `experimental.auto-caption-baseline.v1`をuserData配下へatomic保存し、malformed recordは安全にskipする。baselineはfingerprint、clip identity、mapping、rawWords、initial captions、settings、diagnostics/fallbackのみでpath/credentialを含めない。
- typed IPCをhealth/start/progress/cancel/baseline loadへ更新。rendererの自動字幕は旧`caption_bridge.v1`ではなく、selected video/audio clipのsource absolute resultをshared mappingでtimelineへ変換してUndo可能なsubtitle planへ適用する。
- source wordとdisplay textが異なるdisplay normalizationも、Project Modelのword metadataを失わないように扱う。旧bridge実装・testsは互換参考として残すがruntimeの正式経路から外した。
- Stage 3 tests: worker discovery、Japanese/space path、selection/audio validation、bounded range、progress、cancel、timeout、malformed/oversized/nonzero、baseline redaction、source→timeline mappingを追加。

## 2026-08-15 Human Review Readiness / Auto Caption Bridge

- video clip選択後の「自動字幕」を追加。main processがProjectFileのassetを検証し、外部`caption_bridge.py`をshellなしで実行する。video_editorはclip_automationをimportせず、bridge未設定でもstandalone editorとして動作する。
- clip_automationのfaster-whisperと既存caption algorithmの結果を、`spectra.caption_bridge.v1` transcript JSONとして受け取り、word timing付きsubtitle clipと内部`SubtitleEditUnit`へ一つのundo可能な変更として適用する。
- generated Japanese speech/videoで実Whisper large-v3 CUDA実行、caption 1件、word metadata、bridge schemaを受入確認した。ユーザー素材と既存runは未使用。
- `docs/AUTO_CAPTION_BRIDGE.md`に設定、信頼境界、失敗時挙動、非対象Phaseを記録した。
- readiness: **AUTO CAPTION READY / FULL CORRECTION READY / HUMAN REVIEW READY**。長尺のGPU memory・処理進捗、AI baselineの長期保存形式、mass Human Reviewは未着手。

## 2026-08-15 Stage 1 Auto Caption Worker Contract Draft

- `docs/AUTO_CAPTION_WORKER_CONTRACT_DRAFT.md`と`src/shared/auto-caption-contract.ts`を追加。現在の`caption_bridge.v1`は全sourceを処理する互換bridgeであり、正式worker contractのrequest range・jobId・baselineをまだ実行経路へ接続していないことを明記した。
- `spectra.auto-caption.request.v1`／`spectra.auto-caption.result.v1`、整数microseconds、captionの`sourceWordIds` ownership、path/credential禁止、selected clip range検証をvideo_editor側validatorへ固定した。
- source→timeline mappingは`clip.startUs + (sourceUs - clip.sourceInUs)`。`experimental.auto-caption-baseline.v1`はpath-free型とreader validatorまでで、Project Model、history、UI、IPC、worker実装のcutoverは未着手。

最終更新: 2026-08-13 17:00 JST
状態: **Phase 3 standalone `edit_project.v1`基盤を実装。実画面E2E、別PC受入、GitHub公開は未完了の実用アルファ0.1.0**
branch: `main`

## Phase 3.4 CLOSED / Step 3.5A checkpoint (2026-08-15)

- Accepted baseline at checkpoint start: `30883f61c25903d5c26c138585e998dc71347988` (`main`).
- The `edit_project.v1` subtitle-words bridge is established. Caption `words[]` is optional; words-free captions remain valid.
- Zero-duration source-word handling, decimal-seconds validation, subtitle split/merge, Undo/Redo, Save/reload, FFmpeg render, and accurate preview are accepted end to end.
- `word_timing_overrides` parity is accepted: effective timing applies overrides, then `position_offset`.
- `video_editor` is the future manual subtitle editor authority. The legacy `clip_automation` editor is frozen/reference-only and is not imported or runtime-coupled.
- Latest regression baseline at the Step 3.5A-3 checkpoint: `npm.cmd run check` = **32 files / 185 tests PASS**; `npm.cmd run build` = PASS.
- Next scope: **Step 3.5A Timeline-first Subtitle Editing**. Step 3.5A-1 is read-only visualization of word timing inside subtitle clips; split, drag, ownership changes, Review Mode, and caption algorithm changes are out of scope.

## Step 3.5A-1 completion (2026-08-15)

- Added read-only `.subtitle-word-layer` / `.subtitle-word-unit` visuals inside words-bearing subtitle clips. Geometry uses the true absolute `word.startUs` / `word.endUs` ratio; gaps and very short words are not normalized or given a minimum timing width.
- Words-free captions retain the existing text-only rendering. Text-mismatch captions retain metadata visualization without adding split affordances. The outer `.timeline-clip` remains `position: absolute`; existing selection and pointer gesture semantics are unchanged.
- Added renderer geometry coverage for contiguous words, gaps, words undefined/empty, very short words, and text mismatch.
- `npm.cmd run check`: **32 files / 169 tests PASS**; `npm.cmd run build`: PASS; `npm.cmd run smoke:electron`: PASS with no console errors.
- `VISIBLE_TIMELINE_QA: NOT_RUN_TOOL_LIMIT` (the available packaged window was not the latest source build, and a source-build dev window could not be attached as a targetable window). Formal project and production artifacts were not modified.
- Implementation commit: `01a9985d6f79c5fba741a2cf0087849aaba5a39b` pushed to `origin/main`. Step 3.5A-2 and Step 3.5A-3 remain NOT STARTED.

## Step 3.5A-2 CLOSED (2026-08-15)

- Timeline subtitle split is word-boundary-only. `Razor`, `Ctrl+K`, and the context menu route through the shared nearest-boundary helper and the existing `splitSubtitleAtWordBoundary` operation; subtitle timestamps and word ownership remain unchanged.
- A gap is treated as one zero-distance boundary region, ties choose the lower boundary index, and frame snapping is not used for subtitle splits. Words-free, one-word, text-mismatch, outside-clip, and unsupported multi-selection cases are rejected atomically with a warning. Video/audio/image split behavior is unchanged.
- Added shared/store/renderer regression coverage for nearest boundary selection, gap/tie behavior, exact split timing, undo/redo, invalid-input atomicity, media regression, multi-selection rejection, and context-menu enablement.
- `npm.cmd run check`: **32 files / 178 tests PASS**; `npm.cmd run build`: PASS; `npm.cmd run smoke:electron`: PASS with `did-finish-load`, renderer alive, `#root`, `.app-shell`, preload API, and no console errors.
- `VISIBLE_SUBTITLE_SPLIT_QA: NOT_RUN_TOOL_LIMIT`. `subtitle:geometry` was not used as a gate because it is a known flaky environment check and this change does not touch preview/ASS/FFmpeg.
- Production render code, `edit_project.v1`, and `clip_automation` were not changed. Implementation commit: `e765227a68d2912399f8e340d8c6ea088eaca3e9` pushed to `origin/main`. Step 3.5A-3 followed in the next checkpoint.

## Step 3.5A-3 / 3.5A-4 CLOSED (2026-08-15)

- Added the shared `moveSubtitleBoundary(project, leftClipId, rightClipId, boundaryIndex)` operation. It moves whole words between adjacent compatible captions, preserves caption IDs, word IDs, word timestamps, genuine gaps, left outer start, right outer end, and adjusts right `sourceInUs` by the exact timeline delta. Duplicate IDs, reversed/overlapping timing, invalid pairs, locked tracks, collisions, empty sides, and no-op boundaries are rejected atomically.
- Added a dedicated `.subtitle-boundary-handle`. Pointer movement is local UI state only; pointerup resolves the nearest combined word boundary and applies one store/history operation. 0–2px is a no-op and 3px or more evaluates the boundary. Generic trim handles and media behavior remain unchanged.
- Added subtitle context actions for word-boundary split, merge previous, merge next, and delete. Impossible or locked operations are disabled. Inspector split/merge operations remain the shared fallback.
- Formal bridge acceptance project (`20260814_200007_bridge_acceptance/edit_project.json`) passed automated split, ownership transfer, invalid words-none/text-mismatch rejection, JSON Save/reload validation, duplicate-ID/collision validation, and FFmpeg render acceptance. Render: H.264/AAC stereo, 25.54s, 640×360, 48kHz, non-silent audio (`mean -26.0dB`, `max -5.1dB`); burned subtitle frames were visually inspected.
- Latest `npm.cmd run check`: **32 files / 185 tests PASS**; `npm.cmd run build`: PASS; `npm.cmd run smoke:electron`: PASS with did-finish-load, renderer alive, root/app-shell, preload API, and no console errors.
- `npm.cmd run subtitle:geometry` was repeated three times. All three failed in the existing Fast/Accurate screenshot parity detector, with different fixtures (`jp123-bottom`, `jp123-middle`, `jp54-top`) and no change to thresholds/fixtures/skip logic. Classification remains `INCONCLUSIVE_ENVIRONMENT`, not a demonstrated Timeline regression.
- `VISIBLE_PHASE_35A_QA: NOT_RUN_TOOL_LIMIT`. Automated/formal acceptance passed; direct GUI drag/context-menu visual acceptance was not claimed.
- Phase 3.5A is **CLOSED for automated/formal gates** with visible QA limitation. Implementation commit: `a8086666797537e37bf351107aa37e967224a39f` pushed to `origin/main`. Permanent Review artifact/schema work, max_lines, and caption algorithm changes remain out of scope.

## Step 3.5A-5 / Phase 3.5B design checkpoint (2026-08-15)

- Current-source Electron GUIで15字幕を含むQA copyを実操作し、word visualization、words-none、text mismatch、Razor、Ctrl+K、context split、boundary drag right/left、jitter no-op、collision rejection、merge、delete、Undo/Redo、playback、Accurate Preview、Save As/reloadを確認した。
- QA copyのみを変更し、結果は別`.spectra`へ保存した。元のformal project、run、media、schema、render architecture、caption algorithm、clip_automation production codeは変更していない。
- Step 3.5A-5 visible/manual acceptance: **PASS**。再現性のあるP0/P1 UX不具合は確認できず、コード修正は行わなかった。受入詳細は`docs/PHASE_3_5A_5_VISIBLE_GUI_ACCEPTANCE.md`を参照。
- Phase 3.5Bは設計草案のみ作成し、実装・contract/schema変更は開始していない。推奨review unit、baseline/current差分、rating semantics、operation-derived correction、words-none/text mismatch policy、Undo/Redo、`caption_review.v1`再利用境界、separate artifact案、privacy、MVP、未決定事項を`docs/PHASE_3_5B_HUMAN_REVIEW_CORRECTION_CAPTURE_DESIGN_DRAFT.md`へ記載した。

## 0. 最初に行うこと

```powershell
cd C:\Users\谷本真幸\SynologyDrive\Storage\20_PC_Backup\C\Storage\30_Software\90_Self_Made\Apps\video_editor
git status --short
git log -3 --oneline
Get-Content .\HANDOFF.md -Encoding UTF8 -Raw
npm.cmd run check
```

実装・文書・testを同時に更新し、作業単位ごとにGit commitする。元素材、生成動画、API key、run dataはcommitしない。

## 1. 今回の要求

スペクトルの長期目標は次のとおり。

1. Adobe Premiere Pro、DaVinci Resolve、Final Cut Proに近い性能・操作感・主要機能を持つ独自動画編集ソフト。
2. Crop、trim、delete、join、subtitle、audio、image等を備え、一般的なYouTube動画をこれだけで制作できること。
3. NVIDIA／Intel／AMD／Apple／Linux GPUを自動判定し、失敗時にCPUで書き出せること。
4. 別PCへ移植可能で、利用者のPATHや既存FFmpegに依存しないこと。
5. 将来、Whisper、ローカルLLM、OpenAI互換API、Codex等で編集を自動化しやすいこと。
6. 字幕表現を継続的に高機能化できること。
7. 毎回、README、仕様書、利用者ガイド、HANDOFF、開発ログ、Git履歴を更新すること。

一度の実装で他社professional NLE全機能と同等になる規模ではない。現在は「YouTube制作を端から端まで成立させる縦切り」を構築した段階で、完成と誤認させないこと。

## 2. 完了した実装

### Project / timeline

- `ProjectFile` schema version 1。
- 時刻は整数microsecond、frame変換関数あり。
- media / video / image / audio / subtitle / track model。
- non-destructive move、trim、split、delete、ripple delete。
- relative path付き`.spectra`保存、atomic JSON write、recovery autosave。
- offline検出とrelink用Main API。
- Zustand historyによるUndo／Redo。

### Renderer UI

- 黒鉛＋mintの独自UI。
- media bin、OS D&D、program monitor、inspector、5 track timeline、export dialog。
- clip drag、edge trim、razor、normal/ripple delete、snap、zoom、track lock/mute/hide。
- transform、crop、audio、subtitle style/effect inspector。
- SRT/VTT import、subtitle add、keyboard shortcut、error/offline/empty state。
- Electron APIなしでもdemo projectで表示できるbrowser mode。

### FFmpeg engine

- `ffmpeg-static` / `ffprobe-static`をPATH非依存で解決し、asar unpack pathへ対応。
- `shell:false`のargv実行、output limit、timeout、abort。
- ffprobe media import。
- RenderPlanへcrop、scale、rotation、opacity、overlay、trim、audio mix/fade/pan、subtitleを変換。
- ASS/SRT生成、SRT/VTT parser。
- H.264 encoder adapter: NVENC、QSV、AMF、VideoToolbox、VAAPI、libx264。
- encoder列挙だけでなく短い実encode probe。
- GPU runtime failure時の次GPU→CPU retry。
- progress、cancel、partial output、input overwrite拒否、ffprobe＋先頭／末尾decode、final replace。

### AI拡張基盤

- path-free `AutomationProjectContext`。
- provider interface / registry / capability / health / job / cancel。
- Whisper、local LLM、OpenAI-compatible、Codex、mock等のkind。
- HTTPS、localhost opt-in HTTP、same-origin、redirect禁止、size／timeout／JSON検証を行うHTTP adapter。
- AI出力を`unknown`として受け、allowlist edit commandへruntime validation。
- proposal preview、stale検出、承認後適用、Undo用inverse。
- mock providerと外部network不要のtest。

### 文書

- `README.md`
- `docs/USER_GUIDE.md`
- `docs/SPECIFICATION.md`
- `docs/UI_SPEC.md`
- `docs/ARCHITECTURE.md`
- `docs/ENCODING.md`
- `docs/AI_EXTENSION_GUIDE.md`
- `CHANGELOG.md`
- `HANDOFF.md`

## 3. 最後に成功した検証

### 型検査＋全test

2026-08-12 21:53 JST:

```text
npm.cmd run check
TypeScript: success
Test Files: 12 passed
Tests: 54 passed
```

`tests/main/ffmpeg-integration.test.ts`は同梱FFmpegを実際に起動し、次を行う。

1. FFV1＋PCMのlossless動画と画像fixtureを生成。
2. crop、画像overlay、audio、ASS日本語字幕を合成。
3. CPU libx264＋AACのMP4を書き出す。
4. ffprobeでsize、duration、audioを検査。
5. 先頭と末尾frameをdecode。

### AMD AMF / CPU 実出力

同梱FFmpeg 6.1.1で生成した4秒fixtureを用い、次を実行した。

- `h264_amf`でH.264/AAC MP4を4.011秒出力し、ffprobe、先頭／末尾frame decode成功。
- `libx264`でH.264/AAC MP4を4.011秒出力し、ffprobe成功。

出力はGit管理外の`fixtures/generated/`。これはFFmpeg serviceを直接使った実出力検証であり、Electron UIを経由したE2Eではない。

### Production build / Windows package

`npm.cmd run dist:win`が成功。renderer 1821 modules、main 68.2 kB、preload 2.4 kB。

- `release/Spectra Video Studio-0.1.0-win-x64-setup.exe`（NSIS）
- `release/Spectra Video Studio-0.1.0-win-x64-portable.exe`（portable）

unpacked版の`app.asar.unpacked`内でffmpeg 6.1.1／ffprobe 4.0.2を実行でき、unpacked版とportable版の起動プロセスもこのPCで確認した。NSISの対話導入・アンインストール、別PC移植は未確認。

Codex sandbox内ではesbuildがworkspace上位のpath解決を拒否されるため、build commandに通常権限の承認が必要だった。一般のlocal terminalではCodex sandboxの制約ではない。

### このPCのencoder実probe

2026-08-12、同梱FFmpeg 6.1.1で128×128 1 frameを実encode。

| Encoder | 結果 |
|---|---|
| AMD AMF (`h264_amf`) | 成功 |
| Intel QSV (`h264_qsv`) | 失敗。MFX session `-9` |
| NVIDIA NVENC (`h264_nvenc`) | 失敗。`nvcuda.dll`なし |
| CPU (`libx264`) | 成功 |

したがってこのAMD PCではAMFを選び、AMFがruntime failureした時はlibx264へfallbackする想定。AMFを使った完成動画のUI経由E2Eはまだ未実施。

## 4. 未完了・既知の問題

### Phase 3: standalone video_editor基盤（今回完了）

- `src/main/standalone/edit-project.ts`にclip_automation非依存の`edit_project.v1` validator / loader / adapterを追加。
- `source_media[].path`はcontract parent基準で解決し、missing sourceとSHA-256不一致をtyped errorで返す。
- 既存Project Modelへ変換した後、PreviewとFinalの両方が既存FFmpeg Render Plan生成を共有する。
- `validate`、`probe`、`plan`、`preview`、`render`のheadless CLIを追加。partial output、ffprobe／decode validation、atomic promoteは既存FFmpeg serviceを利用する。
- 既存`.spectra` editor、Timeline、Undo / Redoは削除・変更せず、Phase 3のfallback／互換資産として保持する。
- standalone契約テストと実FFmpeg headless render testを追加した。生成メディアは一時directoryのみで作成し、Git管理しない。

このPhaseでは手動編集機能、旧pipeline統合、clip_automationへの変更、video_editorへのAI／job manager実装を行わない。

### P0: 次担当が最初に扱う

1. **Electron実画面QAが未完了**
   - buildは通ったが、起動、button操作、console、screenshot、実file dialogをこの統合後の状態で確認していない。
   - Browser connectorに接続browserがなく、visual QAを完了できなかった。
2. **program monitorは仮実装**
   - active visualのうち1本を主に表示し、複数V trackの完全合成ではない。
   - `<video>`のseek/play同期は初期段階。videoはmuteで、全A trackのreal-time mixはない。
   - transform previewはCSS近似で、FFmpeg完成frameとの一致比較が未実施。
3. **offline素材relinkの実画面受入がない**
   - MediaBinに「再リンク」buttonを実装し、同じasset IDを保ってmetadata/pathを置換する。native dialogを含む実操作は未確認。
4. **書き出しUI表記は修正済み、実画面確認が未完了**
   - 「ハードウェア優先」およびGPU失敗時CPU fallbackの説明へ統一した。native dialogを含む確認が必要。
5. **実app E2Eがない**
   - 実fixtureをUIでimport→timeline→subtitle→save→reopen→AMF export→forced CPU exportするtest／手動受入が必要。
6. **Windows配布物の外部受入が未完了**
   - `npm.cmd run dist:win`でportable／installerを別名生成済み。unpacked／portable起動プロセス、同梱FFmpeg path、asar unpackをこのPCで確認。installerの対話導入・アンインストール、他PC受入を確認する。
7. **配布license作業**
   - `ffmpeg-static` binaryはGPL構成。公開前にexact build config、license、source offerを配布物へ揃える。

### P1

- proxy生成、thumbnail cache、実音声波形、長尺timeline virtualization。
- source monitor、In/Out、insert/overwrite、linked A/V編集。
- transition、speed、keyframe、basic color、LUT、audio ducking/noise reduction。
- subtitle template保存、文字単位animation、karaoke highlight、background boxの高度化。
- AI registryのIPC／UI統合、OS credential store、Whisper実provider、local LLM設定。
- crash recoveryの正式な選択画面と複数autosave generation。

### P2以降

- HDR color management、multicam、tracking、stabilize。
- node compositing、motion graphics、plugin SDK、collaboration。

## 5. 注意する設計判断

- cropは入力寸法に対する0.0〜0.49の比率。UIはpercent表示。
- position X/Yは出力中心からのpixel offset。scaleは倍率。
- working color spaceは当面SDR BT.709 / 8-bit。
- software decode/filter＋hardware final encode。安易に`-hwaccel auto`を付けない。
- AI providerへabsolute path／API key／raw ProjectFileを渡さない。
- AIはProjectを直接書き換えず、validation→preview→user承認→通常historyへ適用。
- rendererへNode／raw ipcRenderer／raw commandを公開しない。
- FFmpeg pathとfilter textをshell stringへ連結しない。
- 元素材を削除・上書きしない。

## 6. 次の実装プラン

### Phase A: 現在の縦切りを実用状態へする

1. `npm.cmd run check`を再確認。
2. Electronを起動し、console error 0、layout、button、shortcutをvisual QA。
3. fixtureでimport→V1/A2/C1→trim/split/delete/crop/volume/subtitle→save/reopen（未実画面）。
4. AMF exportとCPU exportを実行し、ffprobe・再生・A/V sync・字幕を検証（FFmpeg直接出力は完了、UI経由は未実施）。
5. relink UI、export labelを修正済み。preview同期のP0 bugと実画面受入を継続。
6. screenshotと受入結果を`docs`、`CHANGELOG`、本HANDOFFへ記録。

### Phase B: 配布と移植性

1. Windows portable／NSISを生成。
2. unpack後のFFmpeg/ffprobe path、起動、import/exportを確認。
3. AMD PC、Intel PC、NVIDIA PCまたは対応runnerで同じ受入matrixを実施。
4. GPUなし／driver不適合を再現し、CPU fallbackを確認。
5. macOS／Linux buildは各target OS runnerで生成し、VideoToolbox／VAAPIを検査。
6. FFmpeg license、checksum、source offer、署名方針を確定。

### Phase C: 編集体験

1. proxy／thumbnail／waveform cache。
2. 実program monitorの複数track映像・音声同期。
3. linked A/V、source monitor、insert/overwrite、transition、keyframe。
4. subtitle template／advanced animationをrendererとFFmpegで共通token化。
5. performance、keyboard customization、accessibility、crash recoveryを強化。

### Phase D: AI自動編集

1. provider list／health／run／cancelの型付きIPC。
2. API keyをOS credential storeへ保存。project／rendererへ返さない。
3. local Whisper providerでword timestampを生成。
4. subtitle proposalをdiff previewし、承認後に一括Undo可能なcommandとして適用。
5. local LLM／OpenAI-compatible／将来Codexへ無音cut、highlight、chapter、BGM提案を追加。
6. AI停止・timeout・malformed outputでも手動編集を継続できる受入test。

## 7. 次のAIへ渡すコピペ指示

```text
C:\Users\谷本真幸\SynologyDrive\Storage\20_PC_Backup\C\Storage\30_Software\90_Self_Made\Apps\video_editor の開発を継続してください。

最初に、このrepoの AGENTS.md 指示、README.md、HANDOFF.md、docs/SPECIFICATION.md、docs/ARCHITECTURE.md、docs/ENCODING.md、docs/AI_EXTENSION_GUIDE.md を読み、git status --short と git log -3 --oneline を確認してください。HANDOFF.mdが現在状態の正本です。sub agentを使ってください。

今回の最優先は新機能を広げることではなく、HANDOFF.mdのP0とPhase Aを完了して、現在の縦切りを実際に使える状態にすることです。

必須作業:
1. npm.cmd run checkを維持する。
2. Electron実画面を起動してvisual/interactive QAし、console error、layout、button、shortcutを確認する。
3. 同梱FFmpegで作った短いfixtureをUIからimportし、timeline配置、trim、split、delete/ripple、crop、画像、BGM、字幕、save/reopenを実操作する。
4. このAMD PCではh264_amf、強制softwareではlibx264でMP4を書き出し、ffprobe、先頭/末尾decode、映像/音声/字幕同期を検証する。
5. offline素材のrelink UI、書き出し画面の「ハードウェア優先」表記、program monitorの実素材同期をP0として修正する。
6. npm.cmd run dist:winでportableとinstallerを作り、asar unpackされたFFmpeg/ffprobeで起動・書き出しできるか確認する。未検証なら成功と書かない。
7. README、docs/USER_GUIDE.md、docs/SPECIFICATION.md、CHANGELOG.md、HANDOFF.md、Obsidianのdevelopment_log.mdを実結果に合わせて更新し、変更対象だけをGit commitする。

制約:
- Premiere/Resolve/FCP完全同等と誇張しない。未実装を明示する。
- 元素材を削除・上書きしない。
- FFmpegはargv配列＋shell:falseを維持する。
- GPU名の列挙だけで利用可とせず、実encode probeを維持する。
- GPU失敗時はCPUへfallbackする。
- AIへraw local path、API key、ProjectFileを渡さず、検証済みcommand→preview→承認→Undo可能な適用を守る。
- API key、生成動画、fixture、node_modules、run dataをGitへ追加しない。

Phase Aが完了するまで、multicamや高度なAI機能へ先に進まないでください。完了時は実行したcommand、test数、GPU/CPU encoder、成果物path、未完了を具体的に報告してください。
```

## 8. Git状態について

この文書を含む中断記録をcommitし、最終的に`git status --short`を空にする。最新commit IDは次の担当が`git log -1 --oneline`で確認すること。

## 9. Phase 3.5B-1 implementation checkpoint

字幕human review MVPを実装した。Review Mode、baseline/final snapshot、correction summary、learning eligibility、local experimental review log、typed IPC、ReviewPanelを追加している。ProjectFile schema、`edit_project.v1`、`caption_review.v1`、字幕生成アルゴリズムは変更していない。詳細は [`docs/PHASE_3_5B_1_IMPLEMENTATION.md`](docs/PHASE_3_5B_1_IMPLEMENTATION.md) を参照すること。

自動検証は `npm.cmd run check`（34 files / 193 tests）、`npm.cmd run build`、`npm.cmd run smoke:electron` がPASS。QA用16字幕projectでGUI reviewを10件実施し、Good 3 / Acceptable 3 / Corrected 3 / Skip 1を確認した。review provenanceからraw local pathを除去する回帰も追加した。split/merge/boundary moveの実操作を含む長時間human acceptanceは未完了である。
# 2026-08-15 Stage 9 Final Human Review Readiness Handoff

## 結論

生成QAメディアを用いた現行Electronのvertical sliceは受入済みです。動画import、単一clip選択、実Whisper自動字幕、字幕編集、Undo/Redo、Save/reopen、Full Correction差分、Review Mode、字幕焼き込みrenderまで確認しました。次はユーザー本人が実動画でレビューを開始する段階です。

## 正確な制限

- 自動字幕はself-contained portableではありません。`clip_automation` worker、Python依存、faster-whisper、Whisper modelを設定／環境変数／兄弟repo discoveryで解決できる必要があります。
- 実Whisper経路は`faster-whisper+caption.py`、modelは受入時`large-v3`です。
- `caption.py`の既存segmentationをworkerから再利用しています。利用不能時のrule fallbackはresult diagnosticsへ記録されます。
- raw Whisper wordsはsource truthとして保持します。日本語raw word内のSubtitleEditUnitは編集用derived boundaryで、fine acoustic alignmentではありません。
- fine acoustic alignmentは未実装ですが、現時点の境界操作はmanual correction可能と分類し、Human Review blockerとは判定していません。
- 今回のComputer UseではAltキー保持によるfree scrubを直接再現できず、shared regressionと既存実装を根拠にしています。

## QA evidence

- generated QA media: 約103.24秒、生成映像＋生成音声、日本語発話
- baseline: 34 captions / 311 raw words / `NO_FINE_ACOUSTIC_ALIGNMENT` / fallback false
- Full Correction: 34→34、本文変更1、未変更33
- final render: H.264/AAC、1920×1080、103.241秒、焼き込み字幕frame確認
- video_editor: 245 tests、build、Electron startup、Accurate Preview、subtitle parity/geometry PASS
- clip_automation同梱`.venv`: unittest 252、compileall PASS

詳細: `docs/AUTO_CAPTION_WORKER_CONTRACT.md`、`docs/AUTO_CAPTION_VERTICAL_SLICE.md`、`docs/FULL_CORRECTION_REVIEW.md`。

## 次の利用者操作

Phase 5、planning、highlight、publishing、mass Human Review、caption algorithm learningは開始しない。ユーザーが実動画を選び、同じvertical sliceでレビューを開始する。

---

## 2026-08-16 Phase 8 Parallel Auto Processing

- parallel-capable local worker discoveryを追加。bounded range audioを一度だけ準備し、WhisperとCPU signal silence analysisを並列実行。既存caption result、baseline、edit_project.v1、atomic subtitle applyは維持。
- progress state `silence_analyzing`とTimeline適用表示を追加。silence artifactはsize/schema/path-free diagnosticsをmainで検証し、cancel/failure時はProjectFileとpartial resultを公開しない。parallel workerがない場合はlegacy caption workerへfallback。
- 実生成QA media先頭10秒でserial 9,430.9ms / parallel 8,081.4ms、約14.3%短縮を確認。`npm.cmd run check` 246 tests、build PASS。詳細: `docs/PHASE_8_PARALLEL_AUTO_PROCESSING.md`。

## 2026-08-16 Stage 9 Non-Destructive Silence Cut Apply

- `silenceAnalysis.keepRanges`をsource absolute integerµsとして検証し、media fileを変更せずselected clipをgaplessな複数segmentへ置換する`src/shared/silence-cut.ts`を追加した。
- linked video/audioは同一cut planとsegmentごとのlink groupで分割し、target終了後の全track clipだけを削除時間分rippleする。target intervalと重なる非対象clip、locked target、範囲不整合は安全側でrejectし、ProjectFile/historyを変更しない。
- Auto Captionではsilence cutと生成subtitle trackを1回のhistory transactionへ合成し、Ctrl+Z/Redo一回で両方を復元できる。caption/word source timeは圧縮後timelineへ写像する。silence artifactがないlegacy workerでは従来の字幕のみ適用する。
- `tests/shared/silence-cut.test.ts`と`tests/renderer/auto-caption.test.ts`でA/V、ripple、source mapping、failure safety、one-step Undo/Redoを追加した。

## 2026-08-16 Stage 10 Silence Cut + Caption Time Mapping

- `createSilenceCutTimeMapper`をsource absolute integerµsの共有pure mapperとして追加。keep/removed ranges、point/interval mappingを同一objectで扱う。
- Auto Captionのraw Whisper words、caption start/end、SubtitleWord、SubtitleEditUnitは同一mapperを使用する。raw wordがremoved rangeへ重なる場合は`CUT PLAN INVALID`で全体rejectし、発話wordを削除して続行しない。
- `tests/shared/silence-cut.test.ts`、`tests/shared/auto-caption-adapter.test.ts`へsource 0–5 / remove 5–8 / keep 8–15、raw speech rejection、word/edit unit parityを追加した。
