# video_editor 開発ルール

このrepositoryは`clip_automation`と独立したstandalone video editorである。

## 必須境界

- 正式入力は`edit_project.v1`とsource media。`clip_automation`のPython module、FastAPI、job manager、`data/runs`へ依存しない。
- `edit_project.v1` contractを破壊しない。変更が必要ならschema versionと移行方針を明示する。
- `source_media[].path`は`edit_project.json`のparent directory基準でresolveする。CWDや`run_dir`を暗黙の基準にしない。
- PreviewとFinal Renderは同じProject ModelとRender Planを共有する。別々のtimeline解釈を作らない。
- FFmpeg出力は`partial → validation → atomic promote`の順で公開する。

## 安全な変更

- user data、実動画、contract、generated media/cacheをテストで直接変更しない。
- fixtureまたは一時ディレクトリを使い、generated media/cacheをGitへ入れない。
- 既存資産を削除・全面rewriteせず、KEEP/REFACTOR/REPLACE/DEFERの分類と理由を確認する。
- Phase 3の範囲を越えてUndo/Redo、高度な手動編集、AI、旧`clip_automation` pipeline統合へ進まない。
- 変更前後で`npm.cmd run check`と必要なbuild/E2Eを実行する。
- 変更は小さいcommitへ分け、test PASS後にpushする。
- force push、history rewrite、既存remoteの無断変更を禁止する。

