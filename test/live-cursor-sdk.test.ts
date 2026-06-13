import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Message, StateAction } from '@microsoft/agent-host-protocol';
import { AhpClient } from '@microsoft/agent-host-protocol/client';
import {
  AhpServer,
  createInMemoryTransportPair,
} from '@wyrd-company/ahp-server';

import { createCursorSdkProvider } from '../src/index.js';

const apiKey = process.env.CURSOR_API_KEY;

test('streams a live Cursor SDK local turn through AHP', {
  skip: apiKey ? false : 'set CURSOR_API_KEY to run live Cursor SDK validation',
  timeout: 120_000,
}, async () => {
  const provider = createCursorSdkProvider({
    apiKey,
    defaultModel: process.env.CURSOR_MODEL ?? 'composer-2',
  });
  const server = new AhpServer({ providers: [provider] });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const serving = server.accept(serverTransport);

  const client = new AhpClient(clientTransport, { requestTimeoutMs: 5_000 });
  client.connect();
  await client.initialize({ clientId: 'cursor-live-client', protocolVersions: ['0.3.0'] });

  const sessionUri = 'ahp-session:/cursor-live';
  await client.request('createSession', {
    channel: sessionUri,
    provider: 'cursor-sdk',
    workingDirectory: `file://${process.cwd()}`,
  });
  const { subscription } = await client.subscribe(sessionUri);

  client.dispatch(sessionUri, {
    type: 'session/turnStarted',
    turnId: 'turn-live-1',
    message: userMessage('Reply with exactly: AHP_CURSOR_LIVE_OK'),
  } as StateAction);

  let text = '';
  for (let i = 0; i < 100; i++) {
    const event = await nextAction(subscription);
    if (event.action.type === 'session/delta') {
      text += (event.action as { content?: string }).content ?? '';
    }
    if (event.action.type === 'session/turnComplete') {
      break;
    }
  }

  assert.match(text, /AHP_CURSOR_LIVE_OK/);
  await client.shutdown();
  await serving;
});

function userMessage(text: string): Message {
  return {
    text,
    origin: { kind: 'user' as Message['origin']['kind'] },
  };
}

async function nextAction(subscription: AsyncIterator<unknown>): Promise<{ action: StateAction }> {
  const next = await subscription.next();
  assert.equal(next.done, false);
  const value = next.value as { type?: string; params?: { action?: StateAction } };
  assert.equal(value.type, 'action');
  assert.ok(value.params?.action);
  return { action: value.params.action };
}
