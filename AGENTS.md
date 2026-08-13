# video_editor 開発ルール

このrepositoryは`clip_automation`と独立したstandalone video editorである。

## 必須境界

- 正式入力は`edit_project.v1`とsource media。`clip_automation`のPython module、FastAPI、job manager、`data/runs`へ依存しない。
- `edit_project.v1` contractを破壊しない。変更が必要ならschema versionと移行方針を明示する。
- `source_media[].path`は`edit_project.json`のparent directory基準でresolveする。CWDや`run_dir`を暗黙の基準にしない。
- PreviewとFinal Renderは同じProject ModelとRender Planを共有する。別々のtimeline解釈を作らない。
- `edit_project.v1`ではvideo clipは映像のみ、audio clipは音声のみ。video sourceのaudioは`sourceAudioEnabled`で明示し、contract importでは`false`、legacyの未指定値は有効扱いとする。
- FFmpeg出力は`partial → validation → atomic promote`の順で公開する。

## 開発前提

- このrepositoryはPhase 3以前、作りかけで実用機能が完成していない試作品だった。既存コードを完成資産として信頼しない。
- `KEEP`は「そのまま信頼して使う」という意味ではなく、再利用候補として監査・test・E2E・必要なmanual acceptanceで確認する対象を意味する。
- 自動test、E2E、manual acceptanceで確認されていない既存挙動は保証しない。
- 既存architectureはcontract、Project Model、Render Planの境界とcorrectness・保守性を優先して変更してよい。既存だから残すとは限らない。
- ただし理由なく全削除・ゼロからの全面rewriteはせず、変更理由と代替範囲を文書化する。
- Phase 4以降も、既存資産の継続はcorrectnessと保守性で判断する。

## 安全な変更

- user data、実動画、contract、generated media/cacheをテストで直接変更しない。
- fixtureまたは一時ディレクトリを使い、generated media/cacheをGitへ入れない。
- 既存資産を削除・全面rewriteせず、KEEP/REFACTOR/REPLACE/DEFERの分類と理由を確認する。
- Phase 3の範囲を越えてUndo/Redo、高度な手動編集、AI、旧`clip_automation` pipeline統合へ進まない。
- 変更前後で`npm.cmd run check`と必要なbuild/E2Eを実行する。
- 変更は小さいcommitへ分け、test PASS後にpushする。
- force push、history rewrite、既存remoteの無断変更を禁止する。
