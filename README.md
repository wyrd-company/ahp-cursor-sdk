# AHP Cursor SDK Provider

TypeScript provider adapter that lets an AHP server run local Cursor SDK agent sessions.

Package target: `@wyrd-company/ahp-cursor-sdk`.

This package is intentionally separate from `@wyrd-company/ahp-server` because `@cursor/sdk` brings native optional packages. Consumers explicitly import this adapter and register it with an AHP server.

## Current Status

Cursor's cloud model listing endpoint can return `plan_required` for free accounts. This adapter does not need to call that endpoint: hosts can advertise an explicit local model list through provider options or a YAML file.

The adapter still requests local agents with `Agent.create({ apiKey, local: { cwd, store, customTools } })`. If Cursor SDK itself validates a selected model through the cloud endpoint during local agent creation, that remains an upstream Cursor SDK issue.

Reference: https://forum.cursor.com/t/agent-create-local-apikey-model-fails-for-free-users-because-local-model-validation-calls-cloud-v1-models/160839/10

## Behavior

- Creates one local Cursor SDK agent per AHP session.
- Advertises configured models from `models`, `modelListFile`, or `CURSOR_MODEL_LIST_FILE`; otherwise advertises `composer-2.5`.
- Uses the AHP session working directory as Cursor local `cwd`.
- Optionally passes an injected Cursor SDK `LocalAgentStore` as local `store` on create and resume.
- Sends each AHP user turn with `agent.send(...)`.
- Maps streamed Cursor assistant text blocks to AHP markdown response parts and deltas.
- Maps Cursor run completion to `session/turnComplete`.
- Cancels active runs with `run.cancel()` when Cursor reports support for cancellation.
- Disposes agents with `agent[Symbol.asyncDispose]()`.

## Active-Client Tools

The provider maps AHP active-client tools to Cursor local `customTools`.

- Tools present at session creation are passed to `Agent.create({ local: { customTools } })`.
- The latest active-client tool set is also passed on every `agent.send(..., { local: { customTools } })`, so `session/activeClientToolsChanged` is reflected on the next Cursor run.
- Cursor invokes a custom tool in-process; the adapter routes that call through `ActiveClientToolSink.reportInvocation(...)`.
- AHP owns session URI, turn id, tool call id, tool name, and active-client identity. Tool input is passed through as display/input data only.
- Only the active client that owns the tool call can complete it through normal AHP `session/toolCallComplete`.

## Session Resume

The provider implements `ResumableAgentProvider`. When `ahp-server` reloads a
persisted AHP session, the adapter recreates the local Cursor SDK agent runtime
from the stored AHP working directory, model, config, and active-client tools.
After Cursor returns an `agentId`, the adapter stores it through
`AgentSession.getResumeState()` and calls Cursor SDK `Agent.resume(agentId, ...)`
after an AHP server restart.

This preserves the Cursor local agent identity for future turns. The adapter
does not attempt to replay or continue a half-streamed Cursor run.

## Usage

```ts
import { AhpServer } from '@wyrd-company/ahp-server';
import { createCursorSdkProvider } from '@wyrd-company/ahp-cursor-sdk';
import type { CursorSdkLocalAgentStore } from '@wyrd-company/ahp-cursor-sdk';

const store: CursorSdkLocalAgentStore | undefined = undefined;

const server = new AhpServer({
  providers: [
    createCursorSdkProvider({
      apiKey: process.env.CURSOR_API_KEY,
      defaultModel: process.env.CURSOR_MODEL ?? 'composer-2',
      store,
      modelListFile: process.env.CURSOR_MODEL_LIST_FILE,
    }),
  ],
});
```

Model lists can also be supplied directly:

```ts
createCursorSdkProvider({
  models: [
    'composer-2.5',
    {
      id: 'composer-fast',
      name: 'Composer Fast',
      maxContextWindow: 120_000,
    },
  ],
});
```

Or as YAML:

```yaml
defaultModel: composer-2.5
models:
  - composer-2.5
  - id: composer-fast
    name: Composer Fast
    maxContextWindow: 120000
    supportsVision: false
    _meta:
      source: local-file
```

When `defaultModel` is omitted, the first configured model becomes the default. If no model list is configured, the provider falls back to `composer-2.5`.

## Development

```bash
npm install
npm run verify
```

Live validation requires a real Cursor API key:

```bash
CURSOR_API_KEY=crsr_... npm run test:live
```
