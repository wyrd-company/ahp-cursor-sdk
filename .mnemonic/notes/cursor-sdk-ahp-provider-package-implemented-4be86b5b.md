---
title: Cursor SDK AHP provider package implemented
tags:
  - ahp
  - cursor-sdk
  - provider
  - active-client-tools
  - validation
lifecycle: permanent
createdAt: '2026-06-11T01:54:45.503Z'
updatedAt: '2026-06-11T02:20:48.971Z'
role: summary
alwaysLoad: false
project: github-com-wyrd-company-ahp-cursor-sdk
projectName: ahp-cursor-sdk
memoryVersion: 1
---
# Cursor SDK AHP provider package implemented

On 2026-06-11, `/workspaces/agent-control-plane/ahp-cursor-sdk` commit `5ea3dd6` implemented the optional `@wyrd-company/ahp-cursor-sdk` TypeScript provider package.

Key implementation details:

- The package depends on `@cursor/sdk` and `@microsoft/agent-host-protocol`, and declares `@wyrd-company/ahp-server` as a peer dependency with a local dev dependency for tests.
- `createCursorSdkProvider(...)` creates one local Cursor SDK agent per AHP session using the AHP working directory as Cursor local `cwd`.
- Each AHP user turn calls `agent.send(...)`, maps streamed Cursor assistant text blocks to AHP `session/responsePart` and `session/delta`, and maps run completion to `session/turnComplete`.
- Active-client tools are mapped to Cursor local `customTools` at `Agent.create(...)` and again per `agent.send(...)`, so `session/activeClientToolsChanged` is reflected on the next Cursor run.
- Cursor custom tool execution routes through `ActiveClientToolSink.reportInvocation(...)`; the AHP server owns session URI, turn id, tool call id, tool name, and active-client identity.
- Cancellation uses `run.cancel()` when supported. Disposal uses `agent[Symbol.asyncDispose]()` when available.

Validation: `npm run verify` passed. Local tests cover streaming, active-client tool replacement before a turn, trusted AHP tool lifecycle events, rejection of completion from another client, owner completion, and Cursor custom tool result conversion. The live test is gated on `CURSOR_API_KEY` and was skipped without credentials.

## Upstream Hold

Cursor SDK execution is on hold as of 2026-06-11 due to an upstream SDK bug confirmed by Bob: `Agent.create({ apiKey, local: { cwd, customTools } })` requests a local agent, but local model validation calls Cursor's cloud `/v1/models` path and fails for free users with `plan_required`. Reference: <https://forum.cursor.com/t/agent-create-local-apikey-model-fails-for-free-users-because-local-model-validation-calls-cloud-v1-models/160839/10>

The implemented adapter and fake-runtime tests remain useful, but live Cursor SDK validation should not be treated as actionable until Cursor fixes the SDK behavior or a paid-capable account/API key is provided.
