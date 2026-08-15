# Stage 12 — Subtitle Template Model

## 目的

字幕の見た目と表示制約を、再利用可能なユーザーtemplateとして管理する。templateはEditorのローカル設定であり、`edit_project.v1`の新しい必須フィールドや絶対pathを追加しない。

## versioned model

ユーザーtemplateは次のversionを持つ。

```json
{
  "version": "spectra.subtitle-template.v1",
  "id": "user-template-id",
  "name": "読みやすい字幕",
  "style": {
    "fontFamily": "Noto Sans JP",
    "fontSize": 64,
    "color": "#ffffff",
    "outlineColor": "#111318",
    "outlineWidth": 4,
    "shadowColor": "#000000",
    "shadowBlur": 4,
    "backgroundColor": "#000000",
    "backgroundOpacity": 0,
    "bold": true,
    "italic": false,
    "letterSpacing": 0,
    "lineHeight": 1.2,
    "alignment": "bottom",
    "positionX": 50,
    "positionY": 86,
    "maxWidthPercent": 80,
    "animation": "none",
    "animationDurationUs": 0
  },
  "maxChars": 32,
  "maxLines": 2,
  "createdAt": "2026-08-16T00:00:00.000Z",
  "updatedAt": "2026-08-16T00:00:00.000Z"
}
```

現在の`SubtitleStyle`をそのままstyleの正本として利用する。数値、色、animation、`maxChars`、`maxLines`はmain processで検証し、未知のキーやpath-likeなID/nameは受け付けない。

## 保存と境界

- 保存先はElectron `userData`配下の`subtitle-templates.v1.json`。
- 保存は一時ファイルへのwrite後にrenameするatomic write。
- built-in templateはコード内のimmutable catalogであり、保存・更新・削除の対象外。
- user templateはIPC経由でcreate/update/delete/duplicateできる。
- Rendererは任意のcommandや保存pathを受け取らない。
- ProjectFileにはtemplate絶対pathを保存しない。自動字幕適用時は選択したstyle、文字数、行数を字幕clipへmaterializeする。
- worker request/baselineに渡るtemplate識別子はsafeなIDだけで、userData pathやmedia pathは含めない。

## 互換性と障害時の扱い

保存ファイル全体が壊れている場合は空のuser catalogとして起動し、個別recordが壊れている場合はそのrecordだけを無視する。読み込み結果には`malformedCount`を返すが、Editorの起動・既存ProjectFile・built-in templateは継続する。

旧ProjectFileや既存自動字幕設定にtemplate IDがない場合は`default`を使う。旧built-in IDはそのまま解決でき、任意のsafe user IDもworker contractで受け入れる。edit_project.v1のschema変更は行わない。

## UI利用

Unified Auto Processing dialogでbuilt-inとuser templateを選択できる。built-inは変更不可と表示し、user templateだけ新規保存、複製、更新、削除を提供する。template選択時は`maxChars`/`maxLines`も同じtemplateの値へ切り替わる。

## 検証

- `tests/shared/subtitle-templates.test.ts`: built-in immutable、style clone、ID解決
- `tests/main/subtitle-template-service.test.ts`: missing/malformed、CRUD、atomic path-free store
- `tests/shared/auto-caption-contract.test.ts`: safe user IDとpath-like ID
- `npm.cmd run check`: TypeScriptと全unit test

