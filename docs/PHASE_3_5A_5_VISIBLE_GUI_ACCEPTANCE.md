# Step 3.5A-5 Visible GUI Acceptance

状態: **完了（manual acceptance）**  
実施日: 2026-08-15 JST  
対象branch: `main`  
対象commit: `b54bdf0091eeeb9e7704f8588752d09408b88881`

## 実施条件

- `npm.cmd run build` を現行sourceから実行し、Electron source buildを起動した。
- 元のformal projectは開かず、次のQAコピーを使用した。
  `C:\Storage\30_Software\90_Self_Made\Apps\clip_automation\data\runs\20260814_200007_bridge_acceptance_qa_20260815\edit_project.json`
- 操作結果は別ファイルへSave Asした。元のrun、元の`edit_project.json`、元動画は変更していない。
- 15字幕を含む30秒・640x360 projectをGUIで確認した。words付き、wordsなし、短いword、gap、本文とword情報の不一致を含む。

## 操作結果

| 項目 | 結果 | 観察 |
|---|---|---|
| source build / Electron window | PASS | 現行source buildの`Spectra Video Studio`が表示された |
| 15 captionsのtimeline表示 | PASS | 10件以上を連続して目視確認 |
| word visualization | PASS | word単位の区切りと所有境界ハンドルを確認 |
| gap / short word | PASS | gapと短いwordがtimeline内で可視化された。過度な正規化は見られない |
| words-none | PASS | wordsなし字幕が通常の字幕として表示された |
| text mismatch | PASS | mismatch字幕は表示され、単語分割対象からは除外された |
| Razor | PASS | 現行字幕を単語境界で2つへ分割できた |
| Ctrl+K | PASS | nearest word boundaryで分割できた |
| context split | PASS | 右クリックメニューの分割項目を確認した |
| boundary drag right | PASS | 左字幕が拡張し、Inspectorのduration/endも更新された |
| boundary drag left | PASS | 元の所有境界へ戻り、左右の字幕が復元された |
| jitter / 1px move | PASS | project内容とdirty状態が変わらないno-opだった |
| collision rejection | PASS | 同一字幕track上の重複警告を表示し、移動を拒否した |
| merge | PASS | 前後字幕を結合し、本文とdurationを復元した |
| delete | PASS | 選択字幕を削除できた |
| delete Undo | PASS | 削除前の字幕を復元した |
| merge Undo / Redo | PASS | 結合前の分割状態と結合後の状態を往復できた |
| playback | PASS | 再生位置が進み、停止表示へ切り替わった |
| pause | PASS | 停止後に`正確プレビュー更新中…`を表示し、Fastへ自動降格しなかった |
| Accurate Preview | PASS | 生成完了後に`正確プレビュー`表示と字幕付きframeを確認した |
| Save As | PASS | QA directoryへ`phase35a5_gui_saved.spectra`を書き出した |
| reload | PASS | 保存済み`.spectra`を再読込し、保存済み状態・字幕・timelineを確認した |
| video / subtitle sync | PASS | playhead変更に応じて映像と字幕表示が更新された |
| original data protection | PASS | original project/run/mediaへの保存操作なし |

## 注意点

QA JSONを最初に開いた直後、一時的に「15件の素材がオフラインです。」という通知が表示されたが、映像は再生・表示でき、別QA `.spectra`への保存後再読込では同通知を再現しなかった。再現性のある明確なP0/P1不具合とは判定せず、コード変更は行わない。再現する場合はopen diagnosticsの別課題として調査する。

## 判定

- Step 3.5A-5 visible/manual acceptance: **PASS**
- 今回のP0/P1 UX修正: **なし**
- Phase 3.5B実装: **未着手**
- contract/schema、render architecture、caption algorithm、clip_automation production code: **変更なし**
