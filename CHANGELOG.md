# 変更履歴

このプロジェクトはSemantic Versioningを目標とし、ユーザーから見える変更を記録します。

## [Unreleased]

### 2026-10-22 Added

- クリップの移動とトリムにスナップを付けた。他クリップの先頭・末尾、再生ヘッド、0秒に8pxで吸着し、吸着位置に縦線を出す。`S`で切り替え、`Alt`を押している間は無効。

### 2026-10-22 Fixed

- クリップの移動・トリム中、リンクした相方（映像と音声）がドラッグ中も同じ量だけ動くようにした。以前は離したときに初めて動いていた。表示は実際の確定処理を現在のプロジェクトに適用した結果で、離したときの結果と一致する。
- クリップをつかんだだけで再生ヘッドが動かなくなった。再生ヘッドの移動は、ドラッグせずにクリックして離したときだけ。以前はつかんだ時点で動くため、元の先頭位置にスナップして小さな移動が戻っていた。

### 2026-10-21 Changed / Fixed

- プレビューを1枚のcanvasによる合成に作り直した。再生中と停止中で描き方が同じになり、書き出しと同じ配置の数値（`src/shared/visual-layout.ts`）を使う。字幕はlibassの画像で、アニメーションは1フレームずつ描く。停止時にFFmpegの画像へ自動で切り替えるのはやめ、「書き出し画質で確認」をオンにしたときだけ表示する。
- 書き出しの合成順序をプレビューに合わせた。クロップは残りの部分を動かさない。回転しても縮めない。書き出し解像度がシーケンスと違うときは、シーケンスで合成してから縮小し、縦横比が違えば黒帯を入れる。
- 書き出しの色をBT.709で変換し、MP4に色のタグを付けた。入力の色空間とスマホ動画の回転情報を読むようにした。
- 正確プレビューは、目的のフレームの直前から合成する。長い動画の後半でも待たない。1フレーム早くずれる不具合も直した。
- 字幕の半透明の背景が、プレビュー用の画像でほぼ消えていた問題を直した。
- コマ送り（矢印キー・ボタン）がシーケンスのフレームレートに合わせて進む。以前は常に1/30秒だった。
- 編集機能の不具合を直した。
  - 分割ツール（C）が映像・音声・画像で効かなかった。何も選んでいないときのCtrl+Kは、再生ヘッド上のクリップをすべて分割する。
  - Ctrl+Cなど修飾キー付きの操作で、V/C/Sのツール切り替えが動いていた。
  - スライダーやチェックボックスを触った後、Ctrl+Z・Delete・Ctrl+Kが効かなかった。
  - 「自動詰め」がDeleteキーで効かなかった。ロック中のトラックが詰め削除で動いていた。
  - クリップをクリックすると再生ヘッドがクリップの先頭へ飛んでいた。
  - 素材を読み込み直すと、タイムライン上のクリップの参照が壊れていた。
  - 配置・貼り付け・字幕追加の時刻がフレームに乗っていなかった。トリムで開始時刻が負になる場合があった。
  - 何も変わらない操作でも取り消しの履歴が増えていた。削除や取り消しの後に、消えたクリップが選択されたままになっていた。
  - 未保存のまま別のプロジェクトを開くと、確認なしに破棄されていた。保存ダイアログ中の編集が消えていた。
  - Inspectorの数値欄で「1.5」のような小数を打てなかった。空欄にすると0になっていた。
  - SRT/VTTの読込で、既存の字幕が動いていた。ロック中のトラックを無視し、不正な時刻のキューを弾いていなかった。
  - Ctrl+Dで複製したクリップが元のクリップの真上に重なっていた。

### 2026-10-18 Fixed

- プレビューで音量を上げると例外になる問題を修正。音量・左右バランス・フェードをFinalと同じ設定で再生する。
- パン入力を百分率で表示し、保存時に正しい[-1,1]の値へ変換する。
- 素材のbyte-range配信とネイティブ再生時計への同期を修正し、AAC再生中の連続シークを防ぐ。
- 音声が途中停止した場合の再開、再読込後の正確プレビュー、字幕切替時の古い画像残留を修正する。
- デスクトップ起動時に架空素材のデモを読み込まず、空プロジェクトを開く。
- 読み込み中・シーク中の再生位置の連続更新を抑え、音声と映像のシーク完了後に最新位置へ同期する。
- MP4とSRTの書き出し失敗時に元ファイルを復元し、復元できない場合もエラーで知らせる。同じ出力先への二重保存を拒否する。
- 字幕が0件のSRT出力で古い字幕が残る問題を修正する。
- 自動検証の設定・復元データ・キャッシュを普段の利用環境から分離する。

### 2026-08-16 Night 24 verification

- 実人間日本語QA AでAuto Processingから手動字幕編集、Save/reopen、final renderまでの最終GUI smokeを確認した（666 raw words、85 captions、Natural silence 3件）。
- user subtitle templateのlast-used復元をSave/reopen後に確認した。高品質字幕区切りはLLM timeout時に既存rule fallbackを使用した。
- GUIの実encoder probeがCPU/libx264を選択したため、今回の最終出力はCPU fallbackとして記録した。NVENC成功とは混同しない。

### Fixed

- Integrated Auto Editの成功／失敗／キャンセル境界を整理し、worker、無音cut、字幕template、baseline、Project適用を成功時の1 history operationとして扱う回帰を追加した。Full Correction beforeは自動編集後のcompressed timelineを保持する。
- offline素材をメディア棚から再リンクし、既存timeline clipのasset IDを保ったままpath／metadataを更新できるようにした。
- 書き出し画面の「ハードウェア」を「ハードウェア優先」へ改め、GPU失敗時にCPUへfallbackする実装と説明を一致させた。
- Windows NSIS installerとportableが同一ファイル名で上書きされる設定を修正し、`-setup.exe`と`-portable.exe`を別々に生成するようにした。

### Verified

- 12 test files／54 tests、AMD AMFとCPU `libx264` の実H.264/AAC MP4出力・ffprobe・先頭／末尾decode、Windows x64 package buildを確認した。
- Subtitle template modelのbuilt-in immutable catalog、userData atomic CRUD、malformed record isolation、contract safe-ID validationを確認した。
- Subtitle Inspectorのtemplate manager、defaultTemplateIdのmigration-safe persistence、sample preview、built-in保護を確認した。
- Auto Caption template selectionのstyle/maxChars/maxLines初期適用と、既存subtitle trackへの一括style適用（one-step Undo）を確認した。
- built-in subtitle templateを標準・白文字黒縁・大きめ強調の3種類へ整理し、1920×1080 libass実レンダリングQAを追加した。
- Integrated Auto Editのselected template適用、Undo/Redo、worker failure、started-job cancellation、Full Correction baseline timingを検証した。

### Planned

- Electron実画面E2Eと別PC受入試験（未完了）
- 実program monitorの複数映像・音声同期、proxy、波形
- native dialogを含むoffline素材再リンクの実画面受入
- Windows installerの対話導入・アンインストールと別PC移植
- Whisper／ローカルLLM／OpenAI互換providerのUI統合
- より高度な字幕animation、transition、color、keyframe

## [0.1.0] - 2026-08-12

### Added

- Electron / React / TypeScriptのデスクトップ動画編集基盤
- 独自の黒鉛＋ミント編集ワークスペース
- メディア棚、program monitor、inspector、5 track timeline
- 移動、trim、split、delete、ripple delete、Undo / Redo
- crop、position、scale、rotation、opacity
- volume、pan、fade、track mute
- 字幕編集、style、5種類のeffect preset、SRT/VTT import、SRT export、ASS burn-in
- `.spectra`project、relative path、offline検出、recovery autosave
- 同梱FFmpeg / ffprobeの解決と安全なargv実行
- NVENC、QSV、AMF、VideoToolbox、VAAPI、libx264 adapter
- GPU実encode probe、CPU fallback、progress、cancel、partial output、完成検証
- path-free AI provider registry、mock、local LLM／OpenAI互換HTTP adapter、検証済み編集command
- 12 test files／53 testsとbundled FFmpeg integration test

### Known limitations

- 実用アルファ。program monitorの合成・音声再生、proxy／波形は未完成。
- Windows配布物と他PCでの受入試験は未完了。
- 高度なprofessional NLE機能と実AI providerはロードマップ段階。
# 2026-08-15 — Stage 9 Human Review readiness handoff

- 実生成QA動画で、import → real Whisper auto-caption → manual correction → Save/reopen → Full Correction diff → Review Mode → burned-subtitle renderを受入。
- Inspector本文編集でraw word/editUnitと本文が不一致になった場合、derived timing metadataを削除して偽のword truthを残さないよう修正。
- worker contract、vertical slice、Full Correction Reviewの利用者向け文書を追加。
- self-contained portable auto-captionとfine acoustic alignmentは未達として明記。
