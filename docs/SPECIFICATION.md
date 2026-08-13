# 機能仕様書

文書版: 0.1.0  
更新日: 2026-08-12

## 1. 製品定義

Spectra Video Studioは、一般的なYouTube動画を素材読み込みからH.264/AAC MP4書き出しまで一つのアプリで制作する、クロスプラットフォーム非線形動画編集ソフトである。プロ向けNLEに馴染みやすい編集概念を採るが、他社製品の視覚表現や固有資産は模倣しない。

0.1.xは実用アルファであり、Adobe Premiere Pro、DaVinci Resolve、Final Cut Proの全機能・全性能との同等性は保証しない。初期完成条件は「通常のYouTube動画制作を別編集ソフトへ移らず完遂できること」とする。

## 2. 対象環境

| 項目 | 仕様 |
|---|---|
| Windows | Windows 10/11 x64。AMD/Intel CPU、AMD/Intel/NVIDIA GPU |
| macOS | Intel / Apple Silicon。VideoToolbox対応はtarget OS buildで検査 |
| Linux | x64を基本。NVENC/QSV/VAAPIは実行環境で検査 |
| GPUなし | `libx264` CPUへ自動fallback |
| プロジェクト | UTF-8 JSON、拡張子`.spectra`、schema version付き |
| 作業色空間 | 0.1.xはSDR BT.709、8-bitを基本 |
| 標準音声 | 48 kHz stereo |

macOS/Linux成果物は各OSまたは対応CI runnerでビルドする。GPUベンダー差は実行時probeで吸収し、特定GPUをインストール要件にしない。

## 3. 機能要件

### 3.1 プロジェクト・安全性

| ID | 要件 | 受入条件 |
|---|---|---|
| PRJ-01 | 新規作成、名前変更、保存、別名保存、再読込 | 再起動後もトラック、clip、効果が復元される |
| PRJ-02 | 20秒以内のrecovery autosave | 異常終了後に最新recoveryを読み込める |
| PRJ-03 | Undo / Redo | split、trim、move、delete、effect、字幕編集を戻せる |
| PRJ-04 | 相対パスと絶対パスを保存 | project＋素材folderを別PCへ移して相対pathで復元できる |
| PRJ-05 | offline検出・再リンク | 素材不明でもprojectを壊さず開き、メディア棚の「再リンク」から別pathを指定して同じasset IDのmetadataを更新できる |
| PRJ-06 | 元素材を非破壊 | メディア棚やtimelineから削除しても元ファイルを削除しない |

### 3.2 メディア

| ID | 要件 | 受入条件 |
|---|---|---|
| MED-01 | 動画・音声・画像をdialog／drag & dropで読込 | ffprobe結果、duration、解像度、音声有無を取得 |
| MED-02 | program monitorでsequenceをpreview | playheadと表示clip、音声、字幕が同期 |
| MED-03 | offline、probe失敗を明示 | error理由と再リンク操作を表示 |
| MED-04 | source metadataを保持 | 元fps、duration、sizeをexport planで参照可能 |

### 3.3 Timeline編集

| ID | 要件 | 受入条件 |
|---|---|---|
| EDT-01 | 複数video/audio/subtitle track | trackごとにlock、mute、hideを持つ |
| EDT-02 | clip追加・移動・結合 | 複数clipを連続配置して1本へ書き出せる |
| EDT-03 | source先頭／末尾trim | 1 frame単位にsnapしsource対応を保持 |
| EDT-04 | playheadでsplit | 左右clipのduration合計とsource連続性が保たれる |
| EDT-05 | delete / ripple delete | 通常削除はgap保持、rippleは後続trackを同じ時間だけ詰める |
| EDT-06 | keyboard操作 | Space、Ctrl/Cmd+Z/Y、Delete、Shift+Delete、Ctrl/Cmd+Kを提供 |
| EDT-07 | zoom、snap、playhead seek | 長尺でも目的位置を選択できる |

### 3.4 映像・画像

| ID | 要件 | 受入条件 |
|---|---|---|
| VID-01 | Crop | 各辺0〜49%、負の有効sizeを作らない |
| VID-02 | Position / Scale / Rotation / Opacity | previewとexportへ同値を適用 |
| VID-03 | 画像clip | durationを変更し、video上へoverlay可能 |
| VID-04 | 背景・canvas | sequence size、fps、背景色へ正規化 |

### 3.5 音声

| ID | 要件 | 受入条件 |
|---|---|---|
| AUD-01 | 元動画音声と追加音声をmix | 48k stereo AACを生成 |
| AUD-02 | clip volume | dB指定を線形gainへ変換してpreview/export一致 |
| AUD-03 | fade in/out | clip durationを超えない範囲で適用 |
| AUD-04 | mute | track muteとclip enabledをexportへ反映 |
| AUD-05 | limiter | 複数音声mix後の過大peakを抑制 |

### 3.6 字幕

| ID | 要件 | 受入条件 |
|---|---|---|
| SUB-01 | 字幕clip作成・本文・開始・終了編集 | timelineとpreviewへ反映 |
| SUB-02 | SRT / WebVTT読込、SRT出力 | BOM、CRLF、複数行を扱う |
| SUB-03 | style | font、size、色、outline、shadow、背景、位置、太字、斜体 |
| SUB-04 | effect preset | none、fade、pop、slide-up、typewriterの設定値を保持 |
| SUB-05 | burn-in | ASS/libass経路で最終videoへ合成 |
| SUB-06 | sidecar | YouTube用SRTをvideoと別に保存可能 |

0.1.xでは、effectによってpreviewとFFmpeg/ASSの表現能力に差がある場合、近似presetへ明示的にfallbackする。文字単位の高度なkeyframe editorは次期機能とする。

### 3.7 書き出し

| ID | 要件 | 受入条件 |
|---|---|---|
| EXP-01 | YouTube 1080p / 4K / 縦video preset | width、height、fps、bitrateを確認可能 |
| EXP-02 | GPU auto detect | encoder列挙ではなく1-frame実encodeに成功した候補だけ利用 |
| EXP-03 | 複数vendor | NVENC、QSV、AMF、VideoToolbox、VAAPI adapterを分離 |
| EXP-04 | CPU fallback | hardware failure後もlibx264で同じprojectを完走 |
| EXP-05 | progress / cancel | `out_time_us`から単調progressを表示し、cancelでpartialを完成物にしない |
| EXP-06 | output validation | ffprobeで映像・音声・durationを検査し、decode不能物を成功扱いにしない |
| EXP-07 | safe replace | 入力pathへの上書きを拒否し、成功時だけfinalへ置換 |

## 4. 非機能要件

| ID | 要件 |
|---|---|
| NFR-01 | Rendererはsandbox＋context isolation、Node integration無効 |
| NFR-02 | FFmpegは`argv`配列、`shell:false`。user textをfilter expressionとして実行しない |
| NFR-03 | 1280×720をminimum window、1440×900を標準targetとする |
| NFR-04 | 色だけで状態を示さず、label・icon・outlineを併用する |
| NFR-05 | UI操作中にFFmpeg jobでrendererをblockしない |
| NFR-06 | project migrationなしに未知schemaを推測読込しない |
| NFR-07 | API keyをproject、log、renderer応答へ保存・返却しない |

## 5. AI拡張要件

- Provider capabilityはtranscription、edit suggestion、text generationに分離する。
- Whisper、local LLM、OpenAI互換、将来Codex providerを同じinterfaceで登録可能にする。
- AIへはpath-free project contextだけを渡す。
- 戻り値は許可されたcommandへvalidationし、previewとuser承認後に適用する。
- AI提案も通常編集と同じUndo単位にする。
- 外部provider障害はproject編集とexportを停止させない。

## 6. 対象外・ロードマップ

### 次期候補

- proxy／波形／thumbnail cache
- keyframe curve editor、速度変更、transition
- 自動文字起こしproviderの実体と話者分離
- 基本color correction、LUT、audio ducking、noise reduction
- 文字単位字幕animation、karaoke highlight、template共有

### 長期候補

- HDR color management、multicam、tracking、stabilize
- node合成、motion graphics、plugin SDK、共同編集
- professional control surface、background render farm

## 7. リリース合格基準

1. 生成fixtureと実素材で動画2本、PNG、WAVを読み込む。
2. trim、split、通常delete、ripple delete、位置・scale・cropを操作する。
3. 字幕作成、style/effect変更、SRT入出力を行う。
4. BGM音量とfadeを設定する。
5. 保存→終了→再読込で状態を復元する。
6. H.264/AAC MP4をauto encoderで書き出す。
7. GPU利用不能を再現し、CPU fallback結果をffprobeする。
8. Unit、typecheck、production build、package build、local UI操作確認を全て記録する。UI操作が実行環境の制約で未確認なら、完了扱いにせず未確認項目を明記する。

## 8. 2026-08-12 検証記録

- `npm.cmd run check`: 12 test files / 54 tests成功。
- 同梱FFmpegによるAMD AMFおよびCPU `libx264` のH.264/AAC MP4書き出し、ffprobe、先頭・末尾frame decodeに成功。
- `npm.cmd run dist:win`: Windows x64 NSIS installerとportableを別名で生成。unpacked版で同梱FFmpeg/ffprobeの起動、unpacked／portableのアプリ起動プロセスを確認。
- Electron実画面の目視、native dialogを含むimport→編集→保存→再読込→書き出しUI E2E、NSISの対話インストール、別PC・Intel・NVIDIA実機受入は未確認。
