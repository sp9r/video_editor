# Existing video_editor audit

監査日: 2026-08-13 JST  
対象: `C:\Storage\30_Software\90_Self_Made\Apps\video_editor`

## 発見したproject

`Apps/video_editor`に既存のSpectra Video Studio projectが存在した。`clip_automation`内へ新projectを作成せず、このdirectoryをPhase 3の実装対象として採用する。

- directory: Electron main/preload、React renderer、shared TypeScript、FFmpeg service、tests、docs、fixtures、build output
- Git: 監査時点では`.git`なし。履歴・branch・remoteなし。新規`git init`が必要
- GitHub: `gh` CLI未導入のためCLI認証と`sp9r/video_editor`存在確認は未実施。実装commit後にpush可否を再確認する
- package: Electron 43、React 19、TypeScript、Vite、Vitest、`ffmpeg-static`、`ffprobe-static`
- baseline: `npm.cmd run check`は依存不完全で`@types/node`不足。`npm.cmd install`はネットワーク待ちで完了せず、既存ファイルの削除・上書きは行っていない

## KEEP

`KEEP`は完成資産の認定ではなく、再利用候補の分類である。既存挙動は自動test、E2E、必要なmanual acceptanceで確認された範囲だけを信頼する。

- `src/shared/types.ts`の内部Project Model、microsecond timebase、track/clipモデル
- `src/main/ffmpeg/render-plan.ts`のFFmpeg filter graph生成。既存UIのFinal RenderとPhase 3のheadless renderで共有する
- `src/main/ffmpeg/service.ts`のargv実行、encoder probe、partial output、ffprobe/decode validation、atomic promote
- `src/main/ffmpeg/probe.ts`、`subtitles.ts`、`process.ts`、`binaries.ts`
- Electron preload/contextBridge、trusted IPC、既存Preview/Timeline UIの骨格
- 既存Vitest、deterministic FFmpeg fixture生成スクリプト、architecture/encoding/user guide docs

## REFACTOR

- `src/shared/project.ts`の既存内部schemaと、正式な`edit_project.v1`をadapterで分離する。既存`.spectra`保存形式をcontractへ置換しない
- `src/main/project-service.ts`のopen導線を拡張し、`.spectra`と`edit_project.json`を明示的に判別する。contractを開いた後の保存でcontractを上書きしない
- `src/main/ffmpeg/render-plan.ts`へ渡す前に、contract parent基準のsource resolverとsha256 verificationを通す
- Previewはcontractから生成したProject Model/Render Planの情報を使い、Final Renderとclip順・source範囲・字幕時刻を共有する
- Electron mainとは別に、UIを起動しないCLIから同じloader/model/render serviceを呼べる入口を追加する

## REPLACE

- Phase 3では`edit_project.json`を開けない`.spectra`専用open導線を、contract対応のstandalone open導線で置換する。ただし`.spectra`の既存互換は残す
- CWDや任意のabsolute path fallbackに依存するmedia解決が見つかった場合は、contract resolverに置換する

## DEFER

- Undo/Redo、drag/trim/razor/split/merge、manual correction、高度Inspector
- transition、effect graph、keyframe、color correction、tracking、BGM/SE workflow
- AI provider実装、`clip_automation`旧pipeline/job manager統合
- 完成版Electron packaging、別PC/別OS/実動画の長時間manual acceptance

## Phase 3実装境界

```text
edit_project.json
  -> independent validator/loader
  -> project-relative source resolver + sha256 verification
  -> existing Project Model adapter
  -> shared Render Plan
     -> minimal preview plan/UI
     -> headless/final FFmpeg render
  -> ffprobe/decode validation
  -> partial -> atomic promote
```

この監査後も`clip_automation`のsource run、旧editor、旧pipeline、既存生成mediaは変更しない。

## 開発前提の更新

- Phase 3以前の`video_editor`は、実用機能が完成していない作りかけの試作品として扱う。
- 既存architecture、Project Model、Render Plan、FFmpeg service、UIは再利用候補であり、未検証の挙動を保証しない。
- contract、Project Model、Render Planの境界、correctness、保守性を優先し、必要なら大幅なREFACTOR/REPLACEを行う。
- 理由のない全削除・ゼロからの全面rewriteは避け、既存資産を再利用候補として検証した上で変更範囲を決める。
- Phase 4以降も「既存だから残す」ではなく、test・E2E・manual acceptanceに基づくcorrectnessと保守性で継続利用を判断する。

## Phase 3実装結果

- independent validator / loader / adapter: `src/main/standalone/edit-project.ts`
- shared Preview Plan: `src/main/ffmpeg/render-plan.ts`、`src/shared/types.ts`
- standalone CLI: `src/main/standalone/cli.ts`、`scripts/video-editor.mjs`
- contract open compatibility: `src/main/project-service.ts`
- Phase 3 tests: `tests/main/standalone/edit-project.test.ts`、`tests/main/standalone/headless-render.test.ts`

## Phase 3.5 contract compliance

- Transform validatorを`finite`、`positive`、`non-negative`、`opacity 0..1`の意味別helperへ分離。x/y/rotation/anchorは負数を許可し、scaleは`> 0`、volumeは`>= 0`とする。
- strict `edit_project.v1` loaderでは`source_media[].path`をportable relative path（JSON内`/` separator）のみに限定。Windows drive、UNC、Unix absolute path、backslash pathは拒否し、resolutionは常に`path.resolve(dirname(edit_project.json), contractPath)`で行う。
- legacy `.spectra` path handlingとcontract loaderのpath policyを混同しない。absolute pathをcontractの互換性として復活させない。
- 既存実装は完成品ではなく再利用候補として扱う方針をAGENTSと本監査文書へ明記した。未検証挙動は保証せず、contract／Project Model／Render Planの境界、correctness、保守性を優先する。

2026-08-13 Phase 3.5の実行結果: `npm.cmd run check`成功（14 files / 62 tests）、`npm.cmd run build`成功。GitHub `sp9r/video_editor`の`main`へpush済み。

## Phase 3.6 audio semantics

- 原因: 旧Render Planが`asset.hasAudio`だけでvideo clipのsource audioを有効化し、contractのV1 video + A1 audioを二重mixし得た。
- `VideoClip.sourceAudioEnabled?: boolean`を追加。legacy/internal `.spectra`の未指定値は従来互換で有効、明示`false`は無効とする。
- `edit_project.v1` adapterはvideo clipへ`sourceAudioEnabled: false`を設定。audio clipは独立audio contributionとしてのみRender Planへ入る。
- PreviewはFinalと同じRender Planのinputsからaudio clipを列挙するため、Preview専用の回避処理はない。
- V1+A1、V1のみ、disabled A1、volume=0、legacy default/disabled、Preview/Final input、実FFmpeg sourceの回帰を追加した。

2026-08-13 Phase 3.6の実行結果: `npm.cmd run check`成功（14 files / 64 tests）、`npm.cmd run build`成功、generated video+sine audioのheadless E2Eとffprobe検証成功。

契約の入力形状は`clip_automation` Phase 2.5時点の`edit_project.v1`（監査時点のsource commit: `569bfbf`）を正本として扱った。`caption_project.v2.json`や`transcript_words.json`をvideo_editorへimportする処理は追加せず、loaderは`edit_project.v1`だけを受け取る。

2026-08-13の実行結果: `npm.cmd run typecheck`成功、`npm.cmd test`成功（14 files / 60 tests）、`npm.cmd run build`成功、contract sourceを同梱FFmpegでMP4へheadless renderしffprobe検証成功。GitHub `sp9r/video_editor`の`main`へpush済み。実Electron画面の手動受入と別PC受入は未完了。
