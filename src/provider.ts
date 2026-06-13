import { randomUUID } from 'node:crypto';

import type {
  AgentInfo,
  Message,
  ToolCallResult,
  ToolDefinition,
} from '@microsoft/agent-host-protocol';
import {
  ActiveClientToolRouter,
  MarkdownTurnEmitter,
  resolveModelId,
  singleModelAgentInfo,
  uriToPath,
  type ActiveClientTools,
  type ActiveClientToolSink,
  type AgentProvider,
  type AgentSession,
  type AgentSessionContext,
  type AgentTurnSink,
  type ProviderResumeState,
  type ResumableAgentProvider,
  type ResumableAgentSessionContext,
} from '@wyrd-company/ahp-provider-kit';

import { createCursorSdkRuntime } from './runtime.js';
import {
  toolDefinitionInputSchema,
  toolResultText,
  type CursorSdkAgent,
  type CursorSdkCustomToolResult,
  type CursorSdkCustomTools,
  type CursorSdkMessage,
  type CursorSdkRun,
  type CursorSdkRuntime,
} from './types.js';

export interface CursorSdkProviderOptions {
  readonly apiKey?: string;
  readonly runtime?: CursorSdkRuntime;
  readonly providerId?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly defaultModel?: string;
  readonly agentName?: string;
  readonly localForce?: boolean;
}

export function createCursorSdkProvider(options: CursorSdkProviderOptions = {}): ResumableAgentProvider {
  const providerId = options.providerId ?? 'cursor-sdk';
  const defaultModel = options.defaultModel ?? 'composer-2';
  const agent: AgentInfo = singleModelAgentInfo({
    providerId,
    displayName: options.displayName ?? 'Cursor SDK',
    description: options.description ?? 'Cursor SDK local agent adapter',
    defaultModel,
  });

  async function createRuntimeSession(context: AgentSessionContext | ResumableAgentSessionContext): Promise<AgentSession> {
    const runtime = options.runtime ?? createCursorSdkRuntime();
    const cwd = context.workingDirectory ? uriToPath(context.workingDirectory) : process.cwd();
    const model = resolveModelId(context.model, defaultModel);
    const resumeState = resumeStateFromContext(context);
    const session = new CursorSdkAHPAgentSession({
      runtime,
      apiKey: options.apiKey ?? process.env.CURSOR_API_KEY,
      agentName: options.agentName ?? 'AHP Cursor SDK',
      cwd,
      model: resumeState.model ?? model,
      localForce: options.localForce,
      activeClientTools: context.activeClientTools,
      activeClientToolSink: context.activeClientToolSink,
      agentId: resumeState.agentId,
    });
    await session.start();
    return session;
  }

  return {
    agent,
    createSession(context: AgentSessionContext): Promise<AgentSession> {
      return createRuntimeSession(context);
    },
    resumeSession(context: ResumableAgentSessionContext): Promise<AgentSession> {
      return createRuntimeSession(context);
    },
  };
}

interface CursorSdkResumeState extends ProviderResumeState {
  readonly agentId?: string;
  readonly model?: string;
}

interface CursorSdkAHPAgentSessionOptions {
  readonly runtime: CursorSdkRuntime;
  readonly apiKey?: string;
  readonly agentName: string;
  readonly cwd: string;
  readonly model: string;
  readonly localForce?: boolean;
  readonly activeClientTools?: ActiveClientTools;
  readonly activeClientToolSink: ActiveClientToolSink;
  readonly agentId?: string;
}

class CursorSdkAHPAgentSession implements AgentSession {
  private readonly activeClientTools: ActiveClientToolRouter;
  private currentTurnId: string | undefined;
  private agent: CursorSdkAgent | undefined;
  private run: CursorSdkRun | undefined;

  constructor(private readonly options: CursorSdkAHPAgentSessionOptions) {
    this.activeClientTools = new ActiveClientToolRouter({
      activeClientTools: options.activeClientTools,
      sink: options.activeClientToolSink,
    });
  }

  async start(): Promise<void> {
    const createOptions = {
      apiKey: this.options.apiKey,
      name: this.options.agentName,
      model: { id: this.options.model },
      local: {
        cwd: this.options.cwd,
        customTools: this.customTools(),
      },
    };
    if (this.options.agentId) {
      if (!this.options.runtime.resumeAgent) {
        throw new Error('Cursor SDK runtime does not support Agent.resume');
      }
      this.agent = await this.options.runtime.resumeAgent(this.options.agentId, createOptions);
      return;
    }
    this.agent = await this.options.runtime.createAgent(createOptions);
  }

  async sendUserMessage(message: Message, sink: AgentTurnSink, signal: AbortSignal, turnId?: string): Promise<void> {
    const agent = this.agent;
    if (!agent) {
      throw new Error('Cursor SDK agent session is not started');
    }

    const ahpTurnId = turnId ?? `turn-${Date.now()}`;
    const markdown = new MarkdownTurnEmitter(sink, ahpTurnId);
    this.currentTurnId = ahpTurnId;

    try {
      const run = await agent.send(message.text, {
        model: { id: this.options.model },
        local: {
          ...(this.options.localForce ? { force: true } : {}),
          customTools: this.customTools(),
        },
      });
      this.run = run;

      const abort = (): void => {
        void this.cancel().catch(() => undefined);
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });

      try {
        for await (const event of run.stream()) {
          if (signal.aborted) {
            return;
          }
          emitCursorEvent(event, markdown);
        }

        const result = await run.wait();
        if (!markdown.partEmitted && result.result) {
          markdown.emitDelta(result.result);
        }
        markdown.complete();
      } finally {
        signal.removeEventListener('abort', abort);
      }
    } finally {
      this.run = undefined;
      this.currentTurnId = undefined;
    }
  }

  setActiveClientTools(activeClientTools: ActiveClientTools | undefined): void {
    this.activeClientTools.setActiveClientTools(activeClientTools);
  }

  getResumeState(): CursorSdkResumeState | undefined {
    const agentId = this.agent?.agentId ?? this.options.agentId;
    return agentId
      ? { agentId, model: this.options.model }
      : undefined;
  }

  async cancel(): Promise<void> {
    const run = this.run;
    if (!run) {
      return;
    }
    if (run.supports && !run.supports('cancel')) {
      return;
    }
    await run.cancel?.();
  }

  async dispose(): Promise<void> {
    const dispose = this.agent?.[Symbol.asyncDispose];
    if (dispose) {
      await dispose.call(this.agent);
      return;
    }
    this.agent?.close?.();
  }

  private customTools(): CursorSdkCustomTools | undefined {
    const tools = this.activeClientTools.tools;
    if (!tools?.length) {
      return undefined;
    }
    return Object.fromEntries(tools.map(tool => [tool.name, this.customTool(tool)]));
  }

  private customTool(tool: ToolDefinition): CursorSdkCustomTools[string] {
    return {
      ...(tool.description ? { description: tool.description } : {}),
      ...(toolDefinitionInputSchema(tool) ? { inputSchema: toolDefinitionInputSchema(tool) } : {}),
      execute: async (args, context): Promise<CursorSdkCustomToolResult> => {
        const turnId = this.currentTurnId;
        if (!turnId) {
          return cursorToolResult({
            success: false,
            pastTenseMessage: `No active AHP turn is available for tool ${tool.name}`,
          });
        }
        const result = await this.activeClientTools.reportInvocation({
          turnId,
          toolCallId: context.toolCallId ?? `cursor-tool-${randomUUID()}`,
          toolName: tool.name,
          toolInput: JSON.stringify(args ?? {}),
        });
        return cursorToolResult(result);
      },
    };
  }
}

function resumeStateFromContext(context: AgentSessionContext | ResumableAgentSessionContext): CursorSdkResumeState {
  if (!('resumeState' in context) || !context.resumeState) {
    return {};
  }
  return {
    ...(typeof context.resumeState.agentId === 'string' ? { agentId: context.resumeState.agentId } : {}),
    ...(typeof context.resumeState.model === 'string' ? { model: context.resumeState.model } : {}),
  };
}

function emitCursorEvent(
  event: CursorSdkMessage,
  markdown: MarkdownTurnEmitter,
): void {
  if (!isAssistantMessage(event)) {
    return;
  }

  for (const block of event.message.content) {
    if (block.type !== 'text') {
      continue;
    }
    markdown.emitDelta(block.text);
  }
}

function isAssistantMessage(event: CursorSdkMessage): event is Extract<CursorSdkMessage, { readonly type: 'assistant' }> {
  return event.type === 'assistant' &&
    typeof event.message === 'object' &&
    event.message !== null &&
    'content' in event.message &&
    Array.isArray((event.message as { readonly content?: unknown }).content);
}

function cursorToolResult(result: ToolCallResult): CursorSdkCustomToolResult {
  return {
    isError: !result.success,
    content: [{ type: 'text', text: toolResultText(result) }],
    ...(result.structuredContent ? { structuredContent: result.structuredContent as Record<string, never> } : {}),
  };
}
