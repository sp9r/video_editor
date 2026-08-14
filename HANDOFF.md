# Spectra Video Studio 開発引き継ぎ

最終更新: 2026-08-13 17:00 JST
状態: **Phase 3 standalone `edit_project.v1`基盤を実装。実画面E2E、別PC受入、GitHub公開は未完了の実用アルファ0.1.0**
branch: `main`

## Phase 3.4 CLOSED / Step 3.5A checkpoint (2026-08-15)

- Accepted baseline at checkpoint start: `30883f61c25903d5c26c138585e998dc71347988` (`main`).
- The `edit_project.v1` subtitle-words bridge is established. Caption `words[]` is optional; words-free captions remain valid.
- Zero-duration source-word handling, decimal-seconds validation, subtitle split/merge, Undo/Redo, Save/reload, FFmpeg render, and accurate preview are accepted end to end.
- `word_timing_overrides` parity is accepted: effective timing applies overrides, then `position_offset`.
- `video_editor` is the future manual subtitle editor authority. The legacy `clip_automation` editor is frozen/reference-only and is not imported or runtime-coupled.
- Current regression baseline: `npm.cmd run check` = **31 files / 164 tests PASS**; `npm.cmd run build` = PASS.
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
- Production render code, `edit_project.v1`, and `clip_automation` were not changed. Implementation commit: `e765227a68d2912399f8e340d8c6ea088eaca3e9` pushed to `origin/main`. Next: Step 3.5A-3; boundary drag and ownership editing remain NOT STARTED.

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
