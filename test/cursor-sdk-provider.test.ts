import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import type { Message, StateAction, ToolDefinition } from '@microsoft/agent-host-protocol';
import { AhpClient } from '@microsoft/agent-host-protocol/client';
import {
  AhpServer,
  createInMemoryTransportPair,
} from '@wyrd-company/ahp-server';

import {
  createCursorSdkProvider,
  type CursorSdkAgent,
  type CursorSdkCreateAgentOptions,
  type CursorSdkCustomToolResult,
  type CursorSdkMessage,
  type CursorSdkRun,
  type CursorSdkRuntime,
  type CursorSdkSendOptions,
} from '../src/index.js';

const runningServers: Array<Promise<void>> = [];

after(async () => {
  await Promise.allSettled(runningServers);
});

test('Cursor SDK provider streams a local run through AHP', async () => {
  const runtime = new FakeCursorRuntime();
  const provider = createCursorSdkProvider({ runtime, apiKey: 'cursor-test-key', defaultModel: 'composer-test' });
  const server = new AhpServer({ providers: [provider] });
  const client = createClient(server);

  client.connect();
  await client.initialize({ clientId: 'cursor-client', protocolVersions: ['0.3.0'] });

  const sessionUri = 'ahp-session:/cursor-text';
  await client.request('createSession', {
    channel: sessionUri,
    provider: 'cursor-sdk',
    workingDirectory: 'file:///workspaces/project-a',
  });
  const { subscription } = await client.subscribe(sessionUri);

  client.dispatch(sessionUri, {
    type: 'session/turnStarted',
    turnId: 'turn-1',
    message: userMessage('summarize'),
  } as StateAction);

  const events = [
    await nextAction(subscription),
    await nextAction(subscription),
    await nextAction(subscription),
    await nextAction(subscription),
  ].map(item => item.action);

  assert.equal(runtime.agents[0]?.createOptions.apiKey, 'cursor-test-key');
  assert.equal(runtime.agents[0]?.createOptions.local.cwd, '/workspaces/project-a');
  assert.equal(runtime.agents[0]?.messages[0], 'summarize');
  assert.equal(runtime.agents[0]?.sendOptions[0]?.model?.id, 'composer-test');
  assert.equal(events[0]?.type, 'session/turnStarted');
  assert.equal(events[1]?.type, 'session/responsePart');
  assert.equal(events[2]?.type, 'session/delta');
  assert.equal((events[2] as { content?: string }).content, 'Cursor says hello');
  assert.equal(events[3]?.type, 'session/turnComplete');

  await client.shutdown();
});

test('Cursor SDK provider routes active-client tools through local customTools', async () => {
  const runtime = new FakeCursorRuntime({
    toolCall: {
      name: 'searchWorkspace',
      args: {
        sessionUri: 'ahp-session:/forged',
        turnId: 'forged-turn',
        query: 'needle',
      },
      toolCallId: 'cursor-tool-call-1',
    },
  });
  const provider = createCursorSdkProvider({ runtime, defaultModel: 'composer-test' });
  const server = new AhpServer({ providers: [provider] });
  const owner = createClient(server);
  const other = createClient(server);

  owner.connect();
  other.connect();
  await owner.initialize({ clientId: 'tool-owner', protocolVersions: ['0.3.0'] });
  await other.initialize({ clientId: 'other-client', protocolVersions: ['0.3.0'] });

  const sessionUri = 'ahp-session:/cursor-active-tools';
  await owner.request('createSession', {
    channel: sessionUri,
    provider: 'cursor-sdk',
    activeClient: {
      clientId: 'tool-owner',
      displayName: 'Tool Owner',
      tools: [toolDefinition('openFile', 'Open File')],
    },
  });
  owner.dispatch(sessionUri, {
    type: 'session/activeClientToolsChanged',
    tools: [toolDefinition('searchWorkspace', 'Search Workspace')],
  } as StateAction);
  await owner.request('ping', { channel: 'ahp-root://' });
  const { subscription } = await owner.subscribe(sessionUri);

  owner.dispatch(sessionUri, {
    type: 'session/turnStarted',
    turnId: 'turn-1',
    message: userMessage('use the tool'),
  } as StateAction);

  assert.deepEqual(Object.keys(runtime.agents[0]?.createOptions.local.customTools ?? {}), ['openFile']);

  const turnStarted = await nextAction(subscription);
  assert.equal(turnStarted.action.type, 'session/turnStarted');

  const toolStart = await nextAction(subscription);
  assert.equal(toolStart.action.type, 'session/toolCallStart');
  assert.equal(toolStart.action.turnId, 'turn-1');
  assert.equal(toolStart.action.toolCallId, 'cursor-tool-call-1');
  assert.equal(toolStart.action.toolName, 'searchWorkspace');
  assert.deepEqual(toolStart.action.contributor, {
    kind: 'client',
    clientId: 'tool-owner',
  });

  const toolReady = await nextAction(subscription);
  assert.equal(toolReady.action.type, 'session/toolCallReady');
  assert.equal(toolReady.action.turnId, 'turn-1');
  assert.equal(toolReady.action.toolCallId, 'cursor-tool-call-1');
  assert.match(String(toolReady.action.toolInput), /forged-turn/);

  other.dispatch(sessionUri, {
    type: 'session/toolCallComplete',
    turnId: 'turn-1',
    toolCallId: 'cursor-tool-call-1',
    result: {
      success: true,
      pastTenseMessage: 'Wrong client result',
      content: [{ type: 'text', text: 'wrong' }],
    },
  } as StateAction);

  owner.dispatch(sessionUri, {
    type: 'session/toolCallComplete',
    turnId: 'turn-1',
    toolCallId: 'cursor-tool-call-1',
    result: {
      success: true,
      pastTenseMessage: 'Searched workspace',
      content: [{ type: 'text', text: 'found needle' }],
    },
  } as StateAction);

  const completion = await nextAction(subscription);
  assert.equal(completion.origin?.clientId, 'tool-owner');
  assert.equal(completion.action.type, 'session/toolCallComplete');

  const responsePart = await nextAction(subscription);
  assert.equal(responsePart.action.type, 'session/responsePart');
  const delta = await nextAction(subscription);
  assert.equal(delta.action.type, 'session/delta');
  assert.equal((delta.action as { content?: string }).content, 'Cursor tool result: found needle');
  const turnComplete = await nextAction(subscription);
  assert.equal(turnComplete.action.type, 'session/turnComplete');

  assert.deepEqual(Object.keys(runtime.agents[0]?.sendOptions[0]?.local?.customTools ?? {}), ['searchWorkspace']);
  assert.deepEqual(runtime.agents[0]?.runs[0]?.toolResult, {
    isError: false,
    content: [{ type: 'text', text: 'found needle' }],
  });

  await owner.shutdown();
  await other.shutdown();
});

interface FakeCursorRuntimeOptions {
  readonly toolCall?: {
    readonly name: string;
    readonly args: Record<string, unknown>;
    readonly toolCallId: string;
  };
}

class FakeCursorRuntime implements CursorSdkRuntime {
  readonly agents: FakeCursorAgent[] = [];

  constructor(private readonly options: FakeCursorRuntimeOptions = {}) {}

  createAgent(options: CursorSdkCreateAgentOptions): CursorSdkAgent {
    const agent = new FakeCursorAgent(options, this.options);
    this.agents.push(agent);
    return agent;
  }
}

class FakeCursorAgent implements CursorSdkAgent {
  readonly messages: string[] = [];
  readonly sendOptions: CursorSdkSendOptions[] = [];
  readonly runs: FakeCursorRun[] = [];
  disposed = false;

  constructor(
    readonly createOptions: CursorSdkCreateAgentOptions,
    private readonly runtimeOptions: FakeCursorRuntimeOptions,
  ) {}

  send(message: string, options?: CursorSdkSendOptions): CursorSdkRun {
    this.messages.push(message);
    this.sendOptions.push(options ?? {});
    const run = new FakeCursorRun(options ?? {}, this.runtimeOptions);
    this.runs.push(run);
    return run;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.disposed = true;
  }
}

class FakeCursorRun implements CursorSdkRun {
  readonly id = 'cursor-run-1';
  toolResult: CursorSdkCustomToolResult | undefined;

  constructor(
    private readonly sendOptions: CursorSdkSendOptions,
    private readonly runtimeOptions: FakeCursorRuntimeOptions,
  ) {}

  supports(operation: string): boolean {
    return operation === 'cancel';
  }

  async *stream(): AsyncIterable<CursorSdkMessage> {
    const toolCall = this.runtimeOptions.toolCall;
    if (toolCall) {
      const tool = this.sendOptions.local?.customTools?.[toolCall.name];
      assert.ok(tool, `expected custom tool ${toolCall.name}`);
      this.toolResult = await tool.execute(toolCall.args as never, { toolCallId: toolCall.toolCallId });
      yield assistantMessage(`Cursor tool result: ${toolResultText(this.toolResult)}`);
      return;
    }
    yield assistantMessage('Cursor says hello');
  }

  async wait(): Promise<{ status: string }> {
    return { status: 'finished' };
  }

  async cancel(): Promise<void> {}
}

function createClient(server: AhpServer): AhpClient {
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));
  return new AhpClient(clientTransport, { requestTimeoutMs: 1_000 });
}

function assistantMessage(text: string): CursorSdkMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
  };
}

function toolDefinition(name: string, title: string): ToolDefinition {
  return {
    name,
    title,
    description: `${title} test tool`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
    },
  };
}

function userMessage(text: string): Message {
  return {
    text,
    origin: { kind: 'user' as Message['origin']['kind'] },
  };
}

async function nextAction(subscription: AsyncIterator<unknown>): Promise<{ action: StateAction; origin?: { clientId?: string } }> {
  const next = await subscription.next();
  assert.equal(next.done, false);
  const value = next.value as { type?: string; params?: { action?: StateAction; origin?: { clientId?: string } } };
  assert.equal(value.type, 'action');
  assert.ok(value.params?.action);
  return {
    action: value.params.action,
    origin: value.params.origin,
  };
}

function toolResultText(result: CursorSdkCustomToolResult): string {
  if (typeof result === 'string') {
    return result;
  }
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return JSON.stringify(result);
  }
  if ('content' in result) {
    const content = result.content as readonly { readonly type: string; readonly text?: string }[];
    return content
      .map(item => item.type === 'text' ? item.text : JSON.stringify(item))
      .join('\n');
  }
  return JSON.stringify(result);
}
