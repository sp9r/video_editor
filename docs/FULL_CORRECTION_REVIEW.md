# Full Correction Review

## Purpose

既存のA/B/C/D個別Review Modeとは別に、AI字幕track全体を通常のEditorで修正し、最後にbefore/after差分を保存するworkflowです。

## Workflow

1. Auto Caption trackを選択する。
2. 「全文修正」を開始する。
3. ratingなしでsplit、merge、boundary move、text edit、delete、Undo/Redoを行う。
4. 「修正完了」を押す。
5. baselineとcurrent trackのsummaryを確認する。

## Before truth

beforeは生成時の`experimental.auto-caption-baseline.v1`です。current ProjectFileをbeforeとして再利用しません。baselineはpath、credential、media本体を含みません。

## Diff

sourceJobId、sourceCaptionId、raw word ID、editUnit IDを優先して、`unchanged`、`split`、`merge`、`boundary_move`、`text_edit`、`delete`、`timing_edit`、`mixed`を導出します。words-noneやtext mismatchは無理にownership学習可能と扱いません。

## Persistence

active sessionは`experimental.full-correction.v1`へatomic保存され、crash/reloadやSave/reopen後もfinish可能です。Review ModeのA/B/C/D logとは別artifactです。

## Current acceptance

生成QA mediaで34件のtrackを修正し、本文変更1件・未変更33件のsummaryを確認しました。大量Human Reviewやcaption algorithm learningはまだ開始していません。
