import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type {
  AgentInfo,
  Message,
  SessionModelInfo,
  StateAction,
  ToolCallResult,
  ToolDefinition,
  UsageInfo,
} from '@microsoft/agent-host-protocol';
import {
  ActiveClientToolRouter,
  MarkdownTurnEmitter,
  resolveModelId,
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
import { parse as parseYaml } from 'yaml';

import { createCursorSdkRuntime } from './runtime.js';
import {
  toolDefinitionInputSchema,
  toolResultText,
  type CursorSdkAgent,
  type CursorSdkCustomToolResult,
  type CursorSdkCustomTools,
  type CursorSdkConversationTurn,
  type CursorSdkCreateAgentOptions,
  type CursorSdkLocalAgentStore,
  type CursorSdkMessage,
  type CursorSdkRun,
  type CursorSdkRuntime,
  type CursorSdkUsage,
} from './types.js';

const CURSOR_COMPOSER_2_5_MODEL = 'composer-2.5';
const CURSOR_COMPOSER_2_5_CONTEXT_WINDOW = 200_000;

export interface CursorSdkProviderOptions {
  readonly apiKey?: string;
  readonly runtime?: CursorSdkRuntime;
  readonly providerId?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly defaultModel?: string;
  readonly models?: readonly CursorSdkModelListItem[];
  readonly modelListFile?: string;
  readonly agentName?: string;
  readonly store?: CursorSdkLocalAgentStore;
  readonly localForce?: boolean;
}

export type CursorSdkModelListItem =
  | string
  | CursorSdkModelListObject;

export interface CursorSdkModelListObject {
  readonly id: string;
  readonly name?: string;
  readonly maxContextWindow?: number;
  readonly supportsVision?: boolean;
  readonly policyState?: SessionModelInfo['policyState'];
  readonly configSchema?: SessionModelInfo['configSchema'];
  readonly _meta?: Record<string, unknown>;
}

export function createCursorSdkProvider(options: CursorSdkProviderOptions = {}): ResumableAgentProvider {
  const providerId = options.providerId ?? 'cursor-sdk';
  const modelList = cursorSdkModelList({
    ...options,
    modelListFile: options.modelListFile ?? process.env.CURSOR_MODEL_LIST_FILE,
  }, providerId);
  const defaultModel = modelList.defaultModel;
  const agent: AgentInfo = {
    provider: providerId,
    displayName: options.displayName ?? 'Cursor SDK',
    description: options.description ?? 'Cursor SDK local agent adapter',
    models: modelList.models,
  };

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
      store: options.store,
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

interface CursorSdkModelList {
  readonly defaultModel: string;
  readonly models: SessionModelInfo[];
}

function cursorSdkModelList(options: CursorSdkProviderOptions, providerId: string): CursorSdkModelList {
  const fileConfig = !options.models && options.modelListFile
    ? loadCursorSdkModelListFile(options.modelListFile)
    : {};
  const configuredModels = options.models ?? fileConfig.models;
  const firstModelId = configuredModels?.[0] ? modelListItemId(configuredModels[0]) : undefined;
  const defaultModel = options.defaultModel ?? fileConfig.defaultModel ?? firstModelId ?? CURSOR_COMPOSER_2_5_MODEL;
  const models = configuredModels?.length
    ? configuredModels.map(model => sessionModelInfo(model, providerId))
    : [sessionModelInfo(defaultModel, providerId)];

  if (models.some(model => model.id === defaultModel)) {
    return { defaultModel, models };
  }
  return {
    defaultModel,
    models: [sessionModelInfo(defaultModel, providerId), ...models],
  };
}

interface CursorSdkModelListFile {
  readonly defaultModel?: string;
  readonly models?: readonly CursorSdkModelListItem[];
}

function loadCursorSdkModelListFile(path: string): CursorSdkModelListFile {
  const parsed = parseYaml(readFileSync(path, 'utf8')) as unknown;
  const models = modelItemsFromParsedYaml(parsed);
  const defaultModel = defaultModelFromParsedYaml(parsed);
  return {
    ...(defaultModel ? { defaultModel } : {}),
    ...(models ? { models } : {}),
  };
}

function modelItemsFromParsedYaml(parsed: unknown): readonly CursorSdkModelListItem[] | undefined {
  if (Array.isArray(parsed)) {
    return parsed.map(modelListItemFromParsedYaml);
  }
  if (isRecord(parsed)) {
    const models = parsed.models;
    if (models === undefined) {
      return undefined;
    }
    if (!Array.isArray(models)) {
      throw new Error('Cursor SDK model list file must define models as a YAML sequence');
    }
    return models.map(modelListItemFromParsedYaml);
  }
  if (parsed === null) {
    return undefined;
  }
  throw new Error('Cursor SDK model list file must be a YAML sequence or mapping with a models sequence');
}

function defaultModelFromParsedYaml(parsed: unknown): string | undefined {
  if (!isRecord(parsed) || parsed.defaultModel === undefined) {
    return undefined;
  }
  if (typeof parsed.defaultModel !== 'string' || !parsed.defaultModel) {
    throw new Error('Cursor SDK model list file defaultModel must be a non-empty string');
  }
  return parsed.defaultModel;
}

function modelListItemFromParsedYaml(value: unknown): CursorSdkModelListItem {
  if (typeof value === 'string' && value) {
    return value;
  }
  if (!isRecord(value)) {
    throw new Error('Cursor SDK model list entries must be non-empty strings or mappings with an id');
  }
  if (typeof value.id !== 'string' || !value.id) {
    throw new Error('Cursor SDK model list object entries must include a non-empty id');
  }
  return {
    id: value.id,
    ...(typeof value.name === 'string' && value.name ? { name: value.name } : {}),
    ...(finiteNumber(value.maxContextWindow) ? { maxContextWindow: finiteNumber(value.maxContextWindow) } : {}),
    ...(typeof value.supportsVision === 'boolean' ? { supportsVision: value.supportsVision } : {}),
    ...(typeof value.policyState === 'string' ? { policyState: value.policyState as never } : {}),
    ...(isRecord(value.configSchema) ? { configSchema: value.configSchema as never } : {}),
    ...(isRecord(value._meta) ? { _meta: value._meta } : {}),
  };
}

function modelListItemId(item: CursorSdkModelListItem): string {
  return typeof item === 'string' ? item : item.id;
}

function sessionModelInfo(item: CursorSdkModelListItem, providerId: string): SessionModelInfo {
  if (typeof item === 'string') {
    return {
      id: item,
      provider: providerId,
      name: item,
    };
  }
  return {
    ...item,
    provider: providerId,
    name: item.name ?? item.id,
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
  readonly store?: CursorSdkLocalAgentStore;
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
    const createOptions: CursorSdkCreateAgentOptions = {
      apiKey: this.options.apiKey,
      name: this.options.agentName,
      model: { id: this.options.model },
      local: {
        cwd: this.options.cwd,
        ...(this.options.store ? { store: this.options.store } : {}),
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
        let assistantText = '';
        for await (const event of run.stream()) {
          if (signal.aborted) {
            return;
          }
          assistantText += cursorEventText(event);
          emitCursorEvent(event, markdown);
        }

        const result = await run.wait();
        if (!markdown.partEmitted && result.result) {
          markdown.emitDelta(result.result);
        }
        const usage = await usageInfo({
          run,
          result,
          model: this.options.model,
          userText: message.text,
          assistantText: result.result ?? assistantText,
        });
        sink.emit(usageAction(ahpTurnId, usage));
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

function usageAction(turnId: string, usage: UsageInfo): StateAction {
  return {
    type: 'session/usage',
    turnId,
    usage,
  } as StateAction;
}

interface CursorUsageEstimateInput {
  readonly run: CursorSdkRun;
  readonly result?: { readonly usage?: CursorSdkUsage };
  readonly model: string;
  readonly userText: string;
  readonly assistantText: string;
}

interface CursorUsageEstimate {
  readonly text: string;
  readonly source: 'conversation' | 'turn-transcript';
  readonly conversationAvailable: boolean;
  readonly failureReason?: string;
}

async function usageInfo(input: CursorUsageEstimateInput): Promise<UsageInfo> {
  if (isCursorUsage(input.result?.usage)) {
    return measuredUsageInfo(input.result.usage, input.model);
  }

  const estimate = await estimateText(input);
  const inputTokens = estimateTokens(input.userText);
  const outputTokens = estimateTokens(input.assistantText);
  const totalTokens = estimateTokens(estimate.text);
  const usageRatio = totalTokens / CURSOR_COMPOSER_2_5_CONTEXT_WINDOW;

  return {
    inputTokens,
    outputTokens,
    model: input.model,
    _meta: {
      wyrdContextUsage: {
        totalTokens,
        maxContextWindow: CURSOR_COMPOSER_2_5_CONTEXT_WINDOW,
        usageRatio,
        confidence: 'estimated',
        source: 'estimated-transcript',
      },
      cursorContextUsageEstimate: {
        model: CURSOR_COMPOSER_2_5_MODEL,
        method: 'characters-divided-by-four-rounded-up',
        transcriptSource: estimate.source,
        conversationAvailable: estimate.conversationAvailable,
        characterCount: estimate.text.length,
        ...(estimate.failureReason ? { failureReason: estimate.failureReason } : {}),
      },
    },
  };
}

function measuredUsageInfo(usage: CursorSdkUsage, model: string): UsageInfo {
  const totalTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const usageRatio = totalTokens / CURSOR_COMPOSER_2_5_CONTEXT_WINDOW;

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    model,
    cacheReadTokens: usage.cacheReadTokens,
    _meta: {
      wyrdContextUsage: {
        totalTokens,
        maxContextWindow: CURSOR_COMPOSER_2_5_CONTEXT_WINDOW,
        usageRatio,
        confidence: 'measured',
        source: 'provider-api',
        metric: 'lower-bound-context-tokens',
      },
      cursorUsage: usage,
    },
  };
}

async function estimateText(input: CursorUsageEstimateInput): Promise<CursorUsageEstimate> {
  if (!input.run.conversation || (input.run.supports && !input.run.supports('conversation'))) {
    return {
      text: turnTranscriptText(input.userText, input.assistantText),
      source: 'turn-transcript',
      conversationAvailable: false,
      failureReason: input.run.unsupportedReason?.('conversation') ?? 'Cursor SDK run does not expose conversation()',
    };
  }

  try {
    const conversation = await input.run.conversation();
    const text = conversationText(conversation);
    if (text) {
      return {
        text,
        source: 'conversation',
        conversationAvailable: true,
      };
    }
    return {
      text: turnTranscriptText(input.userText, input.assistantText),
      source: 'turn-transcript',
      conversationAvailable: true,
      failureReason: 'Cursor SDK conversation() returned no text content',
    };
  } catch (error) {
    return {
      text: turnTranscriptText(input.userText, input.assistantText),
      source: 'turn-transcript',
      conversationAvailable: true,
      failureReason: error instanceof Error ? error.message : String(error),
    };
  }
}

function turnTranscriptText(userText: string, assistantText: string): string {
  return [
    `user: ${userText}`,
    `assistant: ${assistantText}`,
  ].join('\n');
}

function conversationText(conversation: readonly CursorSdkConversationTurn[]): string {
  return conversation
    .map(turn => textFragments(turn).join('\n'))
    .filter(Boolean)
    .join('\n');
}

function textFragments(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') {
    return value ? [value] : [];
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap(item => textFragments(item, seen));
  }

  const record = value as Record<string, unknown>;
  return Object.entries(record).flatMap(([key, item]) => {
    if (key === 'type' || key.endsWith('DurationMs')) {
      return [];
    }
    return textFragments(item, seen);
  });
}

function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

function isCursorUsage(value: unknown): value is CursorSdkUsage {
  return isRecord(value) &&
    finiteNumber(value.inputTokens) !== undefined &&
    finiteNumber(value.outputTokens) !== undefined &&
    finiteNumber(value.cacheReadTokens) !== undefined &&
    finiteNumber(value.cacheWriteTokens) !== undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function cursorEventText(event: CursorSdkMessage): string {
  if (!isAssistantMessage(event)) {
    return '';
  }

  return event.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
