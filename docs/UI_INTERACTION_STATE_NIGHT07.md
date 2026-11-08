# UI Interaction State Audit — NIGHT 07

対象: current Electron renderer の状態遷移と visible primary action。静的なbutton inventoryに加え、rendererを起動したinteraction smokeで状態を切り替えて確認する。

## 確認した状態

| 状態 | 確認内容 |
| --- | --- |
| empty project | 自動処理dialogは開ける。対象clipがないため実行はdisabledで理由を表示 |
| media imported / selected | 素材を読み込んだ状態と素材選択状態を通過 |
| clip on timeline | clipがあっても未選択なら実行disabled |
| clip selected | 音声付きonline video clipで実行がenabled |
| processing running | 自動処理、dialogの実行操作がdisabled。busy状態を維持 |
| processing completed | 自動処理と実行操作が再enabled |
| processing failed | 実行操作が再enabledとなり、retry可能。stuck状態なし |
| modal closed / reopened | close後に再openでき、操作状態が復帰 |
| subtitle selected | 自動字幕trackの字幕選択で全文修正がenabled |
| Review Mode | レビューOFF→ONのclickでactiveへ遷移 |
| saved project | project load後の保存済み表示を確認 |
| offline media | 実行disabled、再リンクが必要な理由をtitleで表示 |

## 修正

- 自動字幕の実行ボタンが、offlineまたは音声なしassetでenabledになる不整合を修正した。main processの前提とrendererのdisabled条件を共通の`autoCaptionControlState`で揃え、store側でも同じ条件を早期拒否する。
- smoke-onlyのproject/selection/processingイベントを追加し、実Electronでload・selection・busy解除・modal close・Review Modeを検証できるようにした。production UIにはtest APIを公開していない。
- pointer editの`pointercancel`/window `blur`でmove/trim listenerとdrag stateを必ず解除するようにした。中断後に古いpointer listenerが残る状態を防止する。

## Regression gate

`npm.cmd run smoke:interaction` は `did-finish-load`、renderer alive、root、app shell、preload API、console errorを確認したうえで上記の状態を自動検証する。既存のstore/timeline testsは別途維持する。

未実施のmanual QA（実ユーザーmediaを用いた長時間編集、実workerを使うprocessing完走）はこのstate smokeの合格条件には含めず、既存のauto-caption/E2E gateで扱う。
