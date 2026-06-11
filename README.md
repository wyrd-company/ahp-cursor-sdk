# AHP Cursor SDK Provider

TypeScript provider adapter that lets an AHP server run local Cursor SDK agent sessions.

Package target: `@wyrd-company/ahp-cursor-sdk`.

This package is intentionally separate from `@wyrd-company/ahp-server` because `@cursor/sdk` brings native optional packages. Consumers explicitly import this adapter and register it with an AHP server.

## Current Status

Implementation is on hold pending an upstream Cursor SDK issue. The adapter requests local agents with `Agent.create({ apiKey, local: { cwd, customTools } })`, but Cursor SDK local agent creation currently fails for free users because local model validation calls a cloud models endpoint and returns `plan_required`.

Reference: https://forum.cursor.com/t/agent-create-local-apikey-model-fails-for-free-users-because-local-model-validation-calls-cloud-v1-models/160839/10

## Behavior

- Creates one local Cursor SDK agent per AHP session.
- Uses the AHP session working directory as Cursor local `cwd`.
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

## Usage

```ts
import { AhpServer } from '@wyrd-company/ahp-server';
import { createCursorSdkProvider } from '@wyrd-company/ahp-cursor-sdk';

const server = new AhpServer({
  providers: [
    createCursorSdkProvider({
      apiKey: process.env.CURSOR_API_KEY,
      defaultModel: process.env.CURSOR_MODEL ?? 'composer-2',
    }),
  ],
});
```

## Development

```bash
npm install
npm run verify
```

Live validation requires a real Cursor API key:

```bash
CURSOR_API_KEY=crsr_... npm run test:live
```
