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

