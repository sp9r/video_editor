# Luna Orchestration Workflow

この文書は、Spectra Video Studio開発でChatGPTがLuna/Codexへ作業指示を出すときの標準運用を定義する。

目的は以下の3点。

1. 並列化できる作業はsubagentでまとめて高速化する。
2. 依存関係がある作業だけを順序実行し、競合を避ける。
3. ユーザーが何度も監視・中継しなくても、長時間安全に作業を進められるようにする。

`docs/PRODUCT_BACKLOG.md`を製品要望・進捗のsource of truthとし、この文書は「Lunaへどう作業を渡すか」のsource of truthとする。

---

## 1. 役割分担

### ChatGPT

- 要望整理
- architecture / UX / trade-off判断
- backlogの優先順位付け
- 作業の依存関係分析
- Luna向けbatch設計
- 人間判断が必要なdecision gateの設定
- Luna結果のreviewと次batch決定

### Luna / Codex

- repository調査
- root cause特定
- 実装
- targeted tests
- typecheck / build / smoke
- regression
- backlog更新
- logical commit / push

### User

- LunaへChatGPTが作成した指示を送る
- GUIの操作感、見た目、聴感など自動判定できない項目を確認する
- decision gateでLuna結果をChatGPTへ返す

ChatGPTは毎回、回答の最後に「ユーザーが今やること」を明記する。

---

## 2. 基本ルール: 並列と順序の使い分け

### 2.1 1つの指示にまとめてsubagent並列化する条件

以下を満たす作業は、原則として1つのLuna指示にまとめる。

- 互いに独立している
- 同じfileを同時編集しない、またはisolated worktree/branchで分離できる
- 一方の結果が他方の仕様を変えない
- architecture判断を必要としない
- 失敗しても他作業を安全に継続できる

典型例:

- 別々のbugのread-only root cause調査
- 別moduleの独立した小規模修正
- test expectation修正とUI polish
- code path調査、test coverage調査、performance計測の並列実行

推奨構造:

```text
Main Agent
├─ Subagent A — task A
├─ Subagent B — task B
├─ Subagent C — task C
└─ Subagent D — task D
        ↓
Main Agent review / integration
```

### 2.2 別メッセージに分けて順序実行する条件

以下のいずれかに該当する場合、Lunaへの指示を複数メッセージへ分割し、queueで順番に実行する。

- 同じ主要file / componentを触る
- task Bがtask Aの実装を前提にする
- task Aのresultがtask Bの具体的仕様を決める
- migration / schema / data model変更を含む
- 先にbase implementation、その後visual enhancementのような積み上げ関係がある
- integration regressionを最後にまとめて行う必要がある

例:

```text
Stage N.2 base implementation
↓
Stage N.3 dependent UX addition
↓
Stage N.4 dependent polish
↓
Stage N.5 integration regression
```

---

## 3. subagentの安全ルール

### 3.1 編集を並列化できる場合

isolated worktree / branch等で変更が分離できる場合だけ、複数subagentがコード編集してよい。

Main agentは最終的に:

- diffをreview
- conflictを解消
- repository contractを確認
- testsを統合実行

してからmainへ反映する。

### 3.2 編集を安全に分離できない場合

subagentはread-onlyにする。

各subagentは:

- root cause
- files/functions
- patch方針
- test plan

のみ返す。

実際の変更はMain agentが順番に適用する。

同一fileを複数agentが同時編集することを避ける。

---

## 4. Lunaへの指示は小さく保つ

Lunaへ1つの巨大な万能promptを渡さない。

各指示は原則として1つの目的を持つ。

良い例:

- 3つの独立bugをsubagentで並列調査する
- Timeline visual polish + FFmpeg test fix + Silence Cutを独立subagentで実装する
- Video/Subtitle boundary guideだけを実装する
- その上にcandidate highlightだけを追加する

悪い例:

- Preview、Timeline、Silence Cut、architecture変更、performance rewrite、全回帰を一度に実装する

複数taskを1つへまとめる場合も「並列独立」という明確な理由が必要。

---

## 5. 調査 → 判断 → 実装の分離

不確実性が高い機能は次の順序を守る。

```text
read-only investigation
↓
ChatGPT architecture / UX decision
↓
implementation batch
↓
regression
↓
human acceptance
```

特に以下は、根拠なしで直接実装しない。

- performance architecture
- data model変更
- Timeline / subtitle relationship
- destructive editing behavior
- caching authority
- background automatic edits

---

## 6. ChatGPTへ戻すdecision gate

以下の場合はLunaだけで次へ進めず、そこでSTOPしてChatGPTへ結果を返す。

- 複数の妥当なUX案がある
- architecture trade-offがある
- schema / persistent identity追加が候補になる
- destructive behaviorの仕様判断が必要
- performanceの原因候補が複数残る
- human preferenceが必要
- 次taskの内容が調査結果で大きく変わる

Lunaの最終報告には、必要なら:

```text
DECISION REQUIRED FROM CHATGPT:
- ...
```

を含める。

---

## 7. 人間確認が必要な項目

以下は自動testだけで`DONE`にしない。

- 音が自然に聞こえるか
- speech clipping / click / pop
- Timelineの操作感
- scroll挙動
- subtitle切替の見た目
- font / contrast / clip readability
- UIの分かりやすさ

実装と自動testが完了した段階では:

`IMPLEMENTED — HUMAN ACCEPTANCE PENDING`

または

`READY_FOR_HUMAN_REVIEW`

を使う。

---

## 8. Git / worktree safety

各implementation batchの開始時に原則確認する。

```powershell
git status --short --branch
git diff --check
git diff --stat
```

ルール:

- 未知のユーザー変更を勝手に消さない
- `git add .`を安易に使わない
- task関連fileだけstageする
- 既存untracked fileを削除しない
- branchを決めつけず必要なら確認する
- logical commitに分ける
- push後にremote HEADを確認する

既知のWIPを退避する場合は専用branchを使う。

---

## 9. PRODUCT_BACKLOGとの連携

Lunaは作業開始前に対象IDを確認する。

通常の流れ:

```text
PLANNED / IDEA / VERIFY
↓
IN_PROGRESS
↓
IMPLEMENTED — HUMAN ACCEPTANCE PENDING
または READY_FOR_HUMAN_REVIEW
↓
人間確認
↓
DONE
```

調査のみのStageでは、必要がなければbacklogを変更しない。

architecture decisionが確定したら、実装時にdecision rationaleをbacklogへ記録する。

---

## 10. 推奨Stage設計

### Parallel investigation stage

```text
Stage N.1
Subagent A — investigation A
Subagent B — investigation B
Subagent C — investigation C
Main — results aggregation
STOP for ChatGPT decision
```

### Parallel independent implementation stage

```text
Stage N.2
Subagent A — independent implementation A
Subagent B — independent implementation B
Subagent C — independent implementation C
Main — review / integrate / targeted tests
push
```

### Sequential dependent stages

```text
Stage N.3 — base
Stage N.4 — enhancement depending on N.3
Stage N.5 — final polish depending on N.4
```

### Final regression stage

```text
Stage N.9
- full tests
- typecheck
- build
- required smokes
- representative prior-stage regressions
- backlog checkpoint
- final push
```

---

## 11. どこまで自動で進めてよいか

### 自動継続してよい

- root causeが明確なbug fix
- targeted test failureの修正
- type error / build error
- 明確なacceptance criteriaを満たす小機能
- semantic test expectation修正
- regression確認
- docs/backlog更新
- logical commit / push

### STOPする

- 未知のユーザー変更
- architectureを選ぶ必要がある
- data model / schema変更
- destructive migration
- user preference依存
- 人間の聴感/見た目/操作感なしに仕様確定できない
- unrelated failureで原因不明

---

## 12. Luna指示の標準フォーマット

必要な項目だけ使用する。

```text
STAGE N.X
<short title>

SOURCE OF TRUTH:
docs/PRODUCT_BACKLOG.md
docs/LUNA_WORKFLOW.md

GOAL:
...

PARALLELIZATION:
- Subagent A: ...
- Subagent B: ...
- Subagent C: ...

CONSTRAINTS:
- ...

TESTS:
- ...

BACKLOG:
- ...

GIT:
- logical commit
- push origin/main

FINAL REPORT:
...

STOP.
```

依存作業では`PARALLELIZATION`を使わず、1つの目的だけ記述する。

---

## 13. ChatGPT回答の標準

Luna作業結果を受けたChatGPTは:

1. resultを短く評価
2. architecture/UX判断が必要ならまとめて判断
3. 次のLuna指示を、並列可能性に応じて1〜数通作成
4. queueへ入れる順番を明記
5. **最後に「ユーザーが今やること」を必ず書く**

ユーザーに不要な管理をさせない。

悪い例:

> 次はこれを検討しましょう。

良い例:

> 今やること: 下の3通を29.2 → 29.3 → 29.4の順でLunaのqueueへ入れてください。29.4が終わったら結果をそのままChatGPTへ貼ってください。

---

## 14. 現在のプロジェクト固有原則

- `clip_automation → edit_project.json → video_editor`境界を維持する。
- repo間の直接Python/TypeScript import依存を作らない。
- Silence authorityはFFmpeg audio signal。
- speech protection authorityはraw Whisper word timing。
- SubtitleEditUnitをspeech authorityにしない。
- original mediaはnon-destructive。
- subtitle trackは正式な字幕編集場所として維持する。
- `linkGroupId`は現状A/V用。video/subtitleの曖昧な候補対応を永続linkとして扱わない。
- performance問題は計測前にproxy/WebGL/GPU rewriteへ進まない。

---

## 15. ChatGPT / Luna の使用量を意識した役割分担

目的は、Luna/Codexのagentic usageを、ローカルrepositoryでしか価値を出せない作業へ集中させること。

### 15.1 ChatGPT側へ寄せる作業

標準ChatGPT conversationで完結できる作業は、原則としてLunaへ投げない。

ChatGPTが担当する:

- architecture / UX / trade-off判断
- PRODUCT_BACKLOG / LUNA_WORKFLOW等のGitHub文書更新
- GitHub上のdiff / commit / PR / sourceのstatic review
- acceptance criteria作成
- test strategy / regression scope設計
- Luna promptの設計と圧縮
- Luna結果の比較・判断・優先順位付け
- production codeを変更しないsemantic test expectationの設計判断

ChatGPTは接続済みGitHubを直接読んだり文書を変更できるため、docs更新をLunaへ依頼しないことを優先する。

### 15.2 ChatGPTで実行できるテストの境界

ChatGPT自身の実行環境に対象file・dependency・fixtureが揃っている場合は、isolated scriptや小規模testを実行できる。

ただし、通常のSpectra開発では以下をChatGPTのテスト結果で代替しない:

- ユーザーPC上のlocal repositoryのfull test suite
- Windows / Electron固有挙動
- npm build / Electron startup smoke
- 実media / GPU / audio deviceを使う確認
- userData、local worker、FFmpeg、Whisper等の実機統合

ChatGPTはGitHub上の既存CI結果やlogをreviewできる場合があるが、それを「ユーザーのlocal環境で実行した」と扱わない。

### 15.3 Lunaへ残す作業

Luna/Codexは、local repositoryとshell accessが必要な作業へ集中させる。

- repo-local grep / code trace
- production code編集
- targeted tests実行
- typecheck / build
- Electron smoke
- FFmpeg / media fixtureを使う統合test
- git status / diff / commit / push
- 実装由来regressionの修正

ChatGPTが仕様を確定できる場合、Lunaへarchitectureを再検討させない。

### 15.4 Luna token / credit節約ルール

OpenAIの現行Codex料金はtoken-based agentic usageであるため、Lunaへの長い入力と長い出力の両方を無駄に増やさない。

原則:

1. ChatGPTで仕様と判断を先に確定し、Lunaの探索範囲を狭める。
2. Lunaへ過去会話全文を渡さない。`PRODUCT_BACKLOG.md`とこの文書を参照させる。
3. 1 taskの目的・constraints・acceptanceだけを書く。
4. targeted testsを各taskで実行し、full suiteはcheckpointでまとめる。
5. Lunaのfinal reportは短くし、巨大なdiff説明や既知仕様の再掲を要求しない。
6. static review・docs更新・設計比較は可能な限りChatGPT側で行う。
7. 同じ情報を複数subagentへ重複投入しない。
8. subagentは「速いから常に使う」のではなく、総token消費が増える点も考慮する。

### 15.5 subagentを使う費用判断

subagentはwall-clock短縮には有効だが、複数agentがそれぞれcontextを読み、出力するため、総token消費は増えることがある。

したがって以下の場合だけ優先:

- 3〜4件の独立したread-only調査を同時に行う価値が高い
- 別moduleの実装をisolated worktreeで安全に並列化できる
- serial実行すると長時間になり、重複調査が少ない

以下では使わない:

- 1〜2個の小さな修正
- 同じcomponent/fileを触る作業
- main agentが数回のgrepで判断できる調査
- subagentごとに同じ巨大contextを読む必要がある場合

「最速」ではなく「wall-clock短縮 / token消費 / merge risk」の3つで判断する。

### 15.6 モデル選択

通常の実装・test実行はGPT-5.6 Lunaを第一候補とする。

Lunaで不十分な場合だけ段階的に上げる:

```text
Luna
↓ 明確なreasoning不足
Terra
↓ architecture級のrepo-local判断がどうしても必要
Sol
```

ただしarchitecture級判断は可能な限り標準ChatGPT側へ戻す。

2026-08時点のOpenAI Codex token-based rateでは、LunaはGPT-5.6 familyで最も低いcredit rateである。料金体系は変更されうるため、将来のmodel cost比較では最新のOpenAI公式rate cardを再確認する。

### 15.7 標準ChatGPTとCodex usageの扱い

標準ChatGPT conversationのGPT-5.6 SolはChatGPT側のmodel usage allowanceで管理される。

一方、Codex、ChatGPT Work、ChatGPT for Excel、Workspace Agentsは、利用可能なplanではagentic usage / credit poolを共有する。

したがってCodex枠節約が目的の場合:

- architecture / review / prompt設計は標準ChatGPT conversationを優先
- repo-local executionだけCodex/Lunaへ渡す
- Codex枠節約のためにChatGPT側の回答tokenを過度に短くする必要はない

ただし標準ChatGPTにもplan/modelごとのusage limitは存在するため「無制限」ではない。ChatGPT側の利用上限とCodex側のagentic usageは別の制約として扱う。

---

この文書は運用改善に応じて更新する。