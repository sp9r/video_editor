# AI拡張ガイド

## 1. 目的と設計方針

このAI基盤は、文字起こし、編集案の生成、文章生成を、特定のモデルやサービスへ固定せず追加するための境界です。Whisper、ローカルLLM、OpenAI互換API、将来のCodex連携などは、すべて同じ `AiProvider` インターフェースで差し替えます。

最も重要な原則は、AIをプロジェクトの編集主体にしないことです。AIの出力は信頼できない外部データとして扱い、`ProjectFile` を直接書き換えさせません。AIは限定された編集commandを提案し、アプリが現在のプロジェクトに対して検証し、プレビューを作り、ユーザーの承認後にだけ適用します。適用結果にはundo用トークンが付属します。

```text
ProjectFile
  └─ createAutomationProjectContext()  ← ローカルpathを除外
       └─ AiJobRequest
            └─ validateAiJobRequest()
                 └─ AiProviderRegistry.run()
                      └─ provider.run() → unknown
                           └─ validateAiProviderOutput()
                                └─ createAutomationPlanFromOutput()
                                     └─ previewAutomationProposal()
                                          └─ ユーザー承認
                                               └─ applyAutomationPreview()
                                                    └─ undoAutomationChange()
```

関連ファイルは次のとおりです。

- `src/shared/automation.ts`: 共有型、入力・出力・commandの検証、プレビュー、適用、undo
- `src/main/ai/provider.ts`: providerインターフェース
- `src/main/ai/registry.ts`: provider登録、選択、health、job実行、キャンセル
- `src/main/ai/http-adapter.ts`: 安全なJSON HTTP境界
- `src/main/ai/openai-compatible.ts`: OpenAI互換Chat Completions provider
- `src/main/ai/mock-provider.ts`: テスト・開発用provider
- `src/main/ai/index.ts`: main側の公開エクスポート

## 2. 信頼境界

### 2.1 AIへ渡すのはpath-free contextだけ

`createAutomationProjectContext(project)` は、編集判断に必要な情報だけを `AutomationProjectContext` へ変換します。含まれるのはシーケンス設定、track、clip、asset ID、表示名、時間、種類、offline状態などです。

次の情報は含めません。

- メディアの絶対path・相対path
- プロジェクト保存path
- API key、トークン、cookie
- OSのユーザー名やホームディレクトリ
- `ProjectFile` 全体
- undo履歴、復旧データ、アプリ内部状態

```ts
import { createAutomationProjectContext } from '../shared/automation.js'

const context = createAutomationProjectContext(project)

const request = {
  jobId: 'job-edit-001',
  capability: 'edit-suggestion' as const,
  input: {
    instruction: '冒頭の無音部分を短くし、タイトル字幕を追加して',
    project: context,
    selection: { clipIds: ['clip-video-1'] }
  }
}
```

文字起こしproviderが実ファイルを必要とする場合も、jobには `assetId` だけを入れます。main processが、選択されたassetだけを `resolveMediaPath(assetId)` で解決します。providerへ `ProjectFile` やmedia一覧を渡してはいけません。

### 2.2 providerの戻り値は常に `unknown`

`AiProvider.run()` の戻り値は意図的に `Promise<unknown>` です。TypeScriptの型注釈だけでは、外部プロセスやHTTPレスポンスの実体を保証できないためです。

`AiProviderRegistry.run()` は、provider出力を `validateAiProviderOutput()` に通します。さらに、要求したcapabilityと出力種別が一致することも確認します。

- `transcription` → `transcript` のみ
- `edit-suggestion` → `edit-proposal` のみ
- `text-generation` → `text` のみ

provider実装内で `as AiProviderOutput` とキャストして検証を省略しないでください。

### 2.3 raw project書換えを許可しない

AIが返せる編集は、`AutomationEditCommand` の許可リストに限定されています。

- `insert-subtitle`
- `update-subtitle`
- `delete-clips`
- `move-clip`
- `trim-clip`
- `split-clip`
- `set-transform`
- `set-audio`

`replace-project`、任意JSON Patch、JavaScript、shell command、FFmpeg引数、ファイル操作命令は受理しません。commandには未定義フィールドも追加できません。

`validateAutomationProposal(project, proposal)` は、現在のprojectを参照して次も検証します。

- track・clip・assetが実在するか
- trackがlockedではないか
- track kindとclip kindが一致するか
- 時刻、duration、source rangeが安全な範囲か
- trimがsource mediaの長さを超えないか
- transform、crop、volume、pan、fadeが許容値内か
- clip IDが重複しないか
- commandを先頭から仮適用しても後続commandが成立するか

## 3. Providerを実装する

### 3.1 最小インターフェース

providerは、descriptor、health check、job実行の3点を実装します。

```ts
import type {
  AiProvider,
  AiProviderExecutionContext
} from './provider.js'
import type {
  AiJobRequest,
  AiProviderHealth
} from '../../shared/automation.js'

export class ExampleProvider implements AiProvider {
  readonly descriptor = {
    id: 'example-provider',
    displayName: 'Example Provider',
    kind: 'custom' as const,
    capabilities: ['text-generation'] as const,
    local: true
  }

  async health(_signal?: AbortSignal): Promise<AiProviderHealth> {
    return {
      providerId: this.descriptor.id,
      status: 'healthy',
      checkedAt: new Date().toISOString()
    }
  }

  async run(
    request: AiJobRequest,
    context: AiProviderExecutionContext
  ): Promise<unknown> {
    if (context.signal.aborted) {
      throw new DOMException('AI job was cancelled', 'AbortError')
    }
    if (request.capability !== 'text-generation') {
      throw new Error('Unsupported capability')
    }
    return { kind: 'text', text: '生成結果' }
  }
}
```

### 3.2 実装手順

1. 永続的かつ一意なprovider IDを決めます。IDは英数字で始め、英数字、`.`, `_`, `:`, `-`だけを使います。
2. `kind` を選びます。現在は `whisper`、`local-llm`、`openai-compatible`、`codex`、`mock`、`custom` が使用できます。
3. 実際に処理できるcapabilityだけを宣言します。
4. `health()` はモデル、ローカルプロセス、APIなどの利用可否を短時間で確認し、秘密情報をmessageへ含めず返します。
5. `run()` は `AbortSignal` を下流処理へ伝播し、キャンセル後に処理を続けないようにします。
6. mediaが必要な場合だけ `resolveMediaPath(assetId)` を呼びます。
7. 戻り値は共有スキーマに合うplain dataにします。コードを返したり実行したりしません。
8. `AiProviderRegistry.register()` へ登録し、mockを使ったunit testを追加します。

```ts
import { createAiProviderRegistry } from './registry.js'
import { ExampleProvider } from './example-provider.js'

const registry = createAiProviderRegistry([
  new ExampleProvider()
])
```

同じIDを誤って二重登録すると例外になります。設定変更などで意図的に置換する場合だけ `registry.register(provider, { replace: true })` を使います。実行中jobを持つproviderはunregisterできません。

## 4. Provider別の実装例

### 4.1 Whisper文字起こし

Whisper providerは `transcription` だけを宣言し、`assetId` をmain processで実pathへ解決します。外部プロセスの起動引数はアプリ側で固定的に組み立て、AIレスポンスやrenderer入力をshell文字列として実行してはいけません。

```ts
import type { AiProvider } from './provider.js'

export const whisperProvider: AiProvider = {
  descriptor: {
    id: 'whisper-local',
    displayName: 'Local Whisper',
    kind: 'whisper',
    capabilities: ['transcription'],
    local: true
  },

  async health() {
    // 実装ではbinary/modelの存在と短いself-testを確認する。
    return {
      providerId: 'whisper-local',
      status: 'healthy',
      checkedAt: new Date().toISOString()
    }
  },

  async run(request, context) {
    if (request.capability !== 'transcription') {
      throw new Error('Unsupported capability')
    }
    if (!context.resolveMediaPath) {
      throw new Error('Media resolver is unavailable')
    }

    const mediaPath = await context.resolveMediaPath(request.input.assetId)
    // runWhisperは shell:false 相当で、実行ファイルと引数配列を分ける。
    const result = await runWhisper({
      mediaPath,
      language: request.input.language,
      range: request.input.range,
      signal: context.signal,
      onProgress: (ratio) => context.reportProgress?.({
        jobId: request.jobId,
        ratio,
        message: '文字起こし中'
      })
    })

    return {
      kind: 'transcript',
      language: result.language,
      text: result.text,
      segments: result.segments.map((segment) => ({
        startUs: segment.startUs,
        endUs: segment.endUs,
        text: segment.text,
        confidence: segment.confidence
      }))
    }
  }
}
```

この例の `runWhisper` は説明用の抽象関数です。実装時は次を守ります。

- `spawn(executable, args, { shell: false })` のように実行ファイルと引数を分離する
- 任意のbinary pathをrendererから受け取らない
- 出力JSONのサイズと構造を制限する
- jobのrange指定を変換する際も整数microsecondsを維持する
- 一時ファイルをjob専用ディレクトリへ置き、終了・失敗・キャンセル時に回収する
- モデルファイルのhashや配布元を検証する

文字起こし結果は、`createAutomationPlanFromOutput()` に渡すと、利用可能な字幕track向けの `insert-subtitle` commandへ変換されます。

### 4.2 Local LLM

Ollamaなど、OpenAI互換のloopback APIを持つlocal LLMには `createLocalLlmProvider()` を使えます。

```ts
import { createLocalLlmProvider } from './openai-compatible.js'

const localLlm = createLocalLlmProvider({
  id: 'ollama-editor',
  displayName: 'Ollama Editor',
  baseUrl: 'http://127.0.0.1:11434/v1/',
  model: 'local-edit-model',
  capabilities: ['edit-suggestion', 'text-generation']
})
```

local factoryは `kind: 'local-llm'`、`local: true`、loopback HTTP許可を設定します。HTTPが許されるのは、明示的に有効化された `localhost`、`*.localhost`、`127.0.0.0/8`、`::1` だけです。LAN内IPや外部hostを「local」としてHTTP接続することはできません。

OpenAI互換でないlocal serviceは独自providerを実装できますが、同じ入力・出力検証を通し、URLやプロセス起動の安全制約を弱めないでください。

### 4.3 OpenAI互換API

remote serviceには `OpenAiCompatibleProvider` を使います。

```ts
import { OpenAiCompatibleProvider } from './openai-compatible.js'

const provider = new OpenAiCompatibleProvider({
  id: 'remote-editor',
  displayName: 'Remote Editor',
  kind: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1/',
  model: 'editing-model',
  apiKey: await credentialStore.get('remote-editor'),
  capabilities: ['edit-suggestion', 'text-generation']
})
```

実装済みの `SafeHttpAdapter` は次を強制します。

- remote endpointはHTTPSのみ
- URLへのusername/password埋め込みを禁止
- base URLのquery、fragmentを禁止
- request pathから別originやbase path外へ移動することを禁止
- redirectを禁止
- API keyは `Authorization: Bearer ...` headerにだけ付与
- 呼び出し側によるAuthorization headerの上書きを禁止
- request/responseのbyte数を制限
- timeoutとAbortSignalを伝播
- plain JSONだけを許可し、getter、function、cycle、危険なprototype keyを拒否
- エラーへ混ざったAPI keyをredact

`chatCompletionsPath` と `modelsPath` は、必要な場合だけbase URL配下の相対pathに変更します。絶対URLを渡して別hostへ抜けることはできません。

### 4.4 将来のCodex provider

Codex連携も `AiProvider` を実装します。Codex専用の機能を追加するときも、動画編集アプリ側の最終出力は `AiProviderOutput` と許可済みcommandに正規化します。

```ts
import type { AiProvider } from './provider.js'

export class CodexEditingProvider implements AiProvider {
  readonly descriptor = {
    id: 'codex-editor',
    displayName: 'Codex Editing Assistant',
    kind: 'codex' as const,
    capabilities: ['edit-suggestion', 'text-generation'] as const,
    local: false
  }

  async health(signal?: AbortSignal) {
    // 公式clientの認証・到達性を確認し、key自体は返さない。
    return checkCodexHealth(signal)
  }

  async run(request, context) {
    if (request.capability === 'transcription') {
      throw new Error('Unsupported capability')
    }

    const response = await callCodexWithStructuredOutput({
      request,
      signal: context.signal
    })

    // responseはunknownのまま返す。registryが共有validatorを実行する。
    return response
  }
}
```

上記の `checkCodexHealth` と `callCodexWithStructuredOutput` は将来実装する抽象関数です。Codexにツール実行能力がある場合も、この用途では任意shell、ローカルファイル読取、Git操作、project保存を許可しません。必要な編集情報はpath-free contextとして明示的に渡し、返却値は構造化proposalに限定します。

## 5. API keyと設定の扱い

API keyは絶対に `ProjectFile` へ保存しません。project JSONは共有、バックアップ、Git追加、クラウド同期の対象になり得るためです。

推奨する保存先は、OSのcredential storeです。

- Windows: Credential Manager / DPAPIを利用する安全なkey store
- macOS: Keychain
- Linux: Secret Service互換keyring

開発・CIでは、processの環境変数やsecret managerからmain process起動時に注入できます。ただし、値をconsole、health message、例外、テレメトリ、クラッシュレポートへ出してはいけません。

設定を永続化する場合、保存できるのは次のような非秘密情報だけです。

```json
{
  "providerId": "remote-editor",
  "baseUrl": "https://api.example.com/v1/",
  "model": "editing-model",
  "credentialRef": "remote-editor"
}
```

`credentialRef` はOS credential store内のkeyを識別する名前であり、API key本体ではありません。API keyはmain process内でproviderを構築するときだけ取得し、rendererへ返しません。

## 6. 出力から編集を適用する標準フロー

### 6.1 Jobを実行する

```ts
const result = await registry.run(request, {
  providerId: selectedProviderId,
  signal: abortController.signal,
  resolveMediaPath: async (assetId) => {
    return trustedProjectService.resolveAssetPath(assetId)
  },
  onProgress: (progress) => publishProgress(progress)
})
```

`registry.run()` はjob requestを `validateAiJobRequest()` で再検証し、providerのcapabilityを確認してから実行します。同じjob IDの同時実行は拒否されます。キャンセルには `registry.cancel(jobId)` または呼び出し側のAbortSignalを使います。

### 6.2 AI出力をplanへ変換する

```ts
import {
  createAutomationPlanFromOutput,
  previewAutomationProposal,
  applyAutomationPreview,
  undoAutomationChange
} from '../shared/automation.js'

const plan = createAutomationPlanFromOutput(currentProject, result.output, {
  subtitleTrackId: selectedSubtitleTrackId,
  title: 'AI文字起こし'
})
```

- `transcript` は字幕挿入commandへ変換されます。
- `edit-proposal` は現在のprojectに対して全commandが再検証されます。
- `text` はprojectへ適用できないため、文章として表示する用途に限定します。

### 6.3 プレビューする

```ts
const preview = previewAutomationProposal(currentProject, plan)

showAutomationPreview({
  title: preview.plan.title,
  summaries: preview.summaries,
  before: currentProject,
  after: preview.project
})
```

プレビューの `project` はcloneへ仮適用した結果です。現在のprojectは変更されません。UIでは少なくとも次を表示します。

- 変更件数と種類
- 影響を受けるtrack・clip
- 字幕textと時間範囲
- delete、trim、moveなど破壊的に見える変更
- before/afterのタイムライン差分

### 6.4 ユーザー承認後に適用する

```ts
const applied = applyAutomationPreview(currentProject, preview)
projectStore.replace(applied.project)
automationUndoStack.push(applied.undo)
```

プレビュー作成後にprojectが変更されていた場合、`project.id` と `updatedAt` の比較により適用は拒否されます。古いプレビューを無理に適用せず、現在のprojectから再度proposalを検証・プレビューしてください。

### 6.5 Undoする

```ts
const token = automationUndoStack.pop()
if (token) {
  projectStore.replace(
    undoAutomationChange(projectStore.current(), token)
  )
}
```

undo tokenは、直前に適用したAI変更と同じproject revisionにだけ使用できます。AI変更後に別の編集が入った場合は、既存のアプリ全体のundo/redo履歴へ統合して順番に戻す必要があります。token内の `previousProject` をproviderやrenderer外部通信へ渡してはいけません。

## 7. Mock providerによるテスト

外部APIや実モデルをunit testの必須条件にしません。`createMockAiProvider()` で決定的な出力を返し、registryとautomation pipelineを検証します。

```ts
import { createMockAiProvider } from '../../src/main/ai/mock-provider.js'
import { AiProviderRegistry } from '../../src/main/ai/registry.js'

const registry = new AiProviderRegistry()
registry.register(createMockAiProvider({
  id: 'whisper-mock',
  capabilities: ['transcription'],
  output: {
    kind: 'transcript',
    language: 'ja',
    segments: [
      { startUs: 0, endUs: 1_000_000, text: 'テスト字幕' }
    ]
  }
}))

const result = await registry.run({
  jobId: 'job-test-1',
  capability: 'transcription',
  input: { assetId: 'asset-1', language: 'ja' }
})
```

少なくとも次のケースをテストします。

- capabilityに一致するproviderが選ばれる
- capabilityと出力kindの不一致が拒否される
- 未知command、余分なfield、不正range、不正patchが拒否される
- local pathが `AutomationProjectContext` に含まれない
- previewでは元projectが変化しない
- 承認後にだけapplyされる
- stale previewが拒否される
- apply後にundoできる
- cancelでproviderへAbortSignalが届く
- API keyがURL、body、errorへ漏れない
- getter、functionなど実行可能なpayloadをHTTP adapterが拒否する

現在の関連テストは次のコマンドで実行できます。

```powershell
npm.cmd test -- --run tests/shared/automation.test.ts tests/main/ai-registry.test.ts tests/main/ai-http.test.ts tests/main/ai-openai.test.ts
```

実serviceを使うintegration testは、unit testとは分離し、secretが明示的に設定された環境だけで実行します。通常の `npm test` がnetworkや有料APIへ接続してはいけません。

## 8. 将来のIPC統合例

現時点のAI基盤はmain/sharedの内部APIです。Electron IPCへ統合する場合も、rendererからproviderへ直接接続しません。

推奨channel例:

```ts
export const AI_IPC = {
  providersList: 'ai:providers:list',
  providerHealth: 'ai:provider:health',
  jobRun: 'ai:job:run',
  jobCancel: 'ai:job:cancel',
  jobProgress: 'ai:job:progress'
} as const
```

main handlerは、renderer由来の入力を型キャストだけで信用せず、共有validatorへ通します。

```ts
ipcMain.handle(AI_IPC.jobRun, async (event, rawRequest: unknown) => {
  assertTrustedWindow(event.sender)
  const request = validateAiJobRequest(rawRequest)

  return registry.run(request, {
    providerId: request.providerId,
    resolveMediaPath: async (assetId) => {
      // 現在開いているprojectのassetだけを解決する。
      return projectService.resolveAssetPath(assetId)
    },
    onProgress: (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(AI_IPC.jobProgress, progress)
      }
    }
  })
})
```

この例の `assertTrustedWindow`、`projectService.resolveAssetPath`、channel定義は将来実装が必要です。統合時は次も実施します。

- `contextIsolation: true` を維持する
- preloadで必要最小限の関数だけを公開する
- provider listにはdescriptorだけを返し、provider instanceやkeyを返さない
- health responseにsecretや内部pathを含めない
- job IDとsender windowを対応付け、別windowからcancelできないようにする
- window破棄時に、そのwindowが開始したjobをcancelする
- progress eventの送信頻度を制限する
- IPC payloadとresultのbyte数を制限する
- apply時には最新のauthoritative projectへproposalを再検証する

renderer側の正しい役割は、provider選択、job開始、progress表示、planのプレビュー、ユーザー承認です。API key管理、media path解決、外部HTTP、ローカルprocess起動はmain process側へ隔離します。

## 9. 禁止事項

次の実装は禁止します。

- AIへ `ProjectFile` 全体を渡す
- AIへローカルpath、project path、API keyを渡す
- API keyをproject、autosave、recovery、localStorage、renderer stateへ保存する
- rendererから外部AI APIへ直接fetchする
- provider出力を型キャストだけで信用する
- provider出力をproject storeへ直接mergeする
- `eval`、`new Function`、動的importでAI出力を実行する
- AI出力をshell command、PowerShell、cmd、bashとして実行する
- AIが作った任意FFmpeg引数やbinary pathを無検証で実行する
- `child_process.exec()` へ文字列連結したcommandを渡す
- 任意URL、redirect、HTTP LAN endpointを許可する
- Authorization headerをrendererやprovider応答から上書きさせる
- validation error、health message、logへAPI keyを含める
- プレビューや明示的なユーザー承認を省略する
- stale previewを強制適用する
- locked trackや存在しないclipへの変更を黙って補正する
- networkや有料APIがないと通常のunit testが失敗する構成にする

新しい編集commandを追加するときは、型だけを増やして終わらせず、parse/validation、仮適用、summary、preview、apply、undo、正常系・拒否系テストを同時に追加してください。commandの表現力を広げるほどAIの権限も広がるため、用途を限定し、値域と参照整合性を明示的に定義します。

## 10. 実装チェックリスト

- [ ] provider ID、kind、capabilityが正しい
- [ ] `health()` が短時間で終わり、秘密を返さない
- [ ] AbortSignalとprogressを処理する
- [ ] media pathはmain processのresolverから対象assetだけ取得する
- [ ] providerの戻り値を `unknown` のままregistryへ返す
- [ ] API keyをOS credential storeで管理し、projectへ保存しない
- [ ] remote URLはHTTPS、local HTTPはloopbackだけに限定する
- [ ] AI出力を許可済みcommandへ変換する
- [ ] 最新projectに対してproposalを再検証する
- [ ] previewで元projectが変化しないことを確認する
- [ ] ユーザー承認後だけapplyする
- [ ] undoとstale revision拒否を確認する
- [ ] mock providerで正常系、異常系、cancelをテストする
- [ ] log、error、telemetryにsecret・pathがないことを確認する

