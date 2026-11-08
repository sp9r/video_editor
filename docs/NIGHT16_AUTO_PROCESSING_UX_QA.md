# NIGHT 16: Auto Processing Product UX Hardening

## 対象

Auto Processing dialogの失敗時表示、再実行可能性、進捗stage、成功summaryを確認・改善した。worker contract、ProjectFile、edit_project.v1、caption algorithmの責務は変更していない。

## UIの正本

設定は既存の一画面dialogに集約する。

- 自動字幕: ON / OFF
- 無音カット: OFF / 自然 / 強め
- 処理デバイス: 自動（推奨） / GPU優先 / CPU
- 言語: 日本語 / 自動判定
- 最大文字数 / 最大行数
- 字幕品質: 高品質 / ルール
- 字幕テンプレート

生成中だけ設定とProject変更を無効にする。自動字幕がOFF、未選択、オフライン、音声なしの場合だけ実行を無効にし、その理由をtitleで説明する。

## 進捗と失敗

progressの表示stageは次のいずれかである。

1. 音声準備
2. 文字起こし
3. 無音解析
4. 字幕区切り
5. 字幕配置

main processが付与したpath-freeなphase/errorCodeをrenderer storeが汎用文へ上書きしない。たとえば`silence_validation`は「無音解析で失敗しました」と表示される。worker起動前にterminal failureが届く競合経路も、status reconciliation時に同じ失敗表示へ反映する。

失敗・キャンセル時はProjectを変更せず、job IDを解放する。実行ボタンは`再試行`として再び有効になり、ダイアログを閉じて再度開いた場合も選択clipが有効なら再実行できる。

## 成功summary

成功時は次を表示する。

- 配置した字幕数
- raw word数
- Whisper backend（例: `CUDA / float16`。diagnosticがない場合は未確認と表示）
- 使用template ID
- 無音解析件数
- 実際に短縮した時間
- rule fallbackの有無

path、credential、workerの内部例外はsummaryへ出さない。

## 検証

- `tests/shared/auto-caption-ui.test.ts`
- `tests/renderer/auto-caption.test.ts`
- `tests/main/ai-auto-caption-service.test.ts`
- Electron startup smoke
- Electron interaction state smoke
- typecheck / build

実workerのSilence Analysis failureは既存main serviceのsafe phase diagnosticを利用し、今回のrenderer変更でstageを失わず表示できることを確認した。実mediaによるsilence品質の再評価はNIGHT 14/15のQA記録を正本とする。

## 制限

worker未設定、モデル未導入、GPU不可、外部FFmpeg失敗などの環境依存問題をこのUI変更で隠さない。原因はerrorCodeとstageで表示し、Projectを部分適用しない。
