# Performance Checkpoint: Stage 1 Runtime Audit

更新日: 2026-08-15  
対象: Accurate Preview / final renderの実行時確認

## QA fixture

clip_automationのStage 1 runtime auditで生成したQA mediaを使い、repo外の一時`edit_project.v1`へ34字幕を載せてheadless renderした。実run、個人動画、production projectは変更していない。

## Measurements

| Stage | Result |
|---|---:|
| Accurate Preview smoke wall time | 13,979 ms（build含む） |
| Accurate subtitle overlay cold render | 118.289 ms |
| Accurate subtitle overlay cache hit | 0.119 ms |
| Accurate cue switch | 172.568 ms |
| Final render wall time | 34,648 ms |

Final renderは`libx264`を選択した。出力はH.264/AAC、1920x1080、30fps、103.241000秒で、headless CLI exit 0およびffprobeを確認した。利用可能なNVENC等の一覧は存在するが、今回のrenderで選択されたbackendはCPU `libx264`である。

Accurate Preview smokeは既存のgenerated fixtureを使うため、103秒動画全体のdecode時間ではない。停止中の字幕overlayはFinalと同じlibass/Render Plan経路を通り、cache miss後にatomicに表示されることを確認した。

## Regression

- `npm.cmd run check`: 45 files / 245 tests PASS
- `npm.cmd run build`: PASS
- `npm.cmd run smoke:electron`: PASS（file-relative assets 2件、did-finish-load、renderer alive、root child 1、app-shell、preload API、playhead、console/load/process diagnostics clean）
- `npm.cmd run smoke:accurate-preview`: PASS（上記geometry/timing metricsを含む）

Stage 1ではvideo_editorのproduction code、render backend設定、preview architectureを変更していない。
