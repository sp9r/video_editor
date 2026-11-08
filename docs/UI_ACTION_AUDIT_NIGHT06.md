# UI Action Audit — NIGHT 06

対象: Cutline（旧Spectra Video Studio）の current renderer UI。今回の対象は、表示中の操作が「有効な文脈で実行できる」「無効なら前提条件が分かる」「有効なのに無反応にならない」ことの確認。

## Inventory

| 領域 | 操作 | 状態 / 前提 | 対応 |
| --- | --- | --- | --- |
| ヘッダー | 新規、開く、保存、Undo、Redo | 保存中・履歴なし等で無効化 | 既存実装を確認。履歴ボタンは履歴の有無と一致 |
| ヘッダー | レビュー ON/OFF | 字幕未選択時は警告 | no-opにせず対象不足を通知 |
| ヘッダー | 自動処理 | 対象clipがない場合もdialogを開き、対象不足を表示 | 実行ボタンは対象clipが成立するまで無効 |
| ヘッダー | 書き出す | dialogを開く。実行中は開始を無効化 | 既存実装を確認 |
| メディア | 読込、検索、grid/list、素材選択、再リンク | オフライン素材は再リンクが必要 | 「その他」の未実装アイコンを削除。配置ボタンに理由をtitle表示 |
| メディア | タイムラインへ追加 | offline またはメディアtrackなしで不可 | disabled と理由表示を追加 |
| Preview | 完成映像 | source viewは未実装 | sourceタブを表示せず、完成映像を静的ラベル化 |
| Preview | 再生、前後フレーム、全画面 | 常時実行可能。Fullscreen API非対応時は通知 | 全画面ボタンを実装 |
| Timeline | V/C track追加、字幕追加、SRT/VTT読込 | desktop APIがない場合は既存notice | 既存実装を確認 |
| Timeline | 分割、削除 | selected clipが前提 | disabled状態を維持 |
| Timeline | track上下移動、削除 | 同種trackの隣接、空track、最後のtrack制約 | storeが無視するケースをdisabled化し、理由をtitle表示 |
| Timeline | zoom ±、slider | 28–220 px/sec | 端点でdisabled化 |
| Inspector | style/template、字幕編集、結合、word boundary split | selection・word metadata・隣接字幕が前提 | 既存disabled条件を確認 |
| Review / Full Correction | 評価、移動、開始、完了 | review対象・自動字幕trackが前提 | 既存warning/disabledを確認 |
| Export | encoder、保存先、SRT、開始、cancel | encoder probe・実行中状態 | 既存実装を確認 |

## Interaction / layering findings

- `.drop-overlay` と字幕overlayは `pointer-events: none`、操作用timeline要素はその下でクリック可能な構造。
- modal backdrop は高いz-indexで表示され、背景操作を遮断する。dialogのclose/cancel条件は実行中かどうかに従う。
- stale selection時のレビュー・自動処理は、操作を黙って無視せず warning を表示する。
- 今回、visibleなのにhandlerが無かった操作は、メディアの「その他」、Previewのsource/完成映像タブ、Previewの全画面ボタン。前二者は未実装表示をやめ、全画面はFullscreen APIへ接続した。

## Remaining intentionally unavailable actions

- source monitor / 「その他」メニューは今回のproduct scopeに未実装のため表示しない。
- browser demoでの実ファイル選択・SRT/VTT読込・自動字幕・template persistenceはdesktop API前提で、既存の説明noticeを残す。
- 無効化された操作は、選択・同種track・トラック数・offline等の前提をtitle/画面メッセージで説明する。
