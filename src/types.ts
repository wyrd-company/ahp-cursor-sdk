import type {
  ModelSelection,
  ToolCallResult,
  ToolDefinition,
  ToolResultContent,
} from '@microsoft/agent-host-protocol';

export interface CursorSdkRuntime {
  createAgent(options: CursorSdkCreateAgentOptions): Promise<CursorSdkAgent> | CursorSdkAgent;
  resumeAgent?(agentId: string, options: CursorSdkCreateAgentOptions): Promise<CursorSdkAgent> | CursorSdkAgent;
}

export interface CursorSdkCreateAgentOptions {
  readonly apiKey?: string;
  readonly name?: string;
  readonly model?: ModelSelection;
  readonly local: {
    readonly cwd: string;
    readonly customTools?: CursorSdkCustomTools;
  };
}

export interface CursorSdkAgent {
  readonly agentId?: string;
  send(message: string | CursorSdkUserMessage, options?: CursorSdkSendOptions): Promise<CursorSdkRun> | CursorSdkRun;
  close?(): void;
  [Symbol.asyncDispose]?(): Promise<void>;
}

export interface CursorSdkSendOptions {
  readonly model?: ModelSelection;
  readonly local?: {
    readonly force?: boolean;
    readonly customTools?: CursorSdkCustomTools;
  };
}

export interface CursorSdkUserMessage {
  readonly text: string;
  readonly images?: readonly unknown[];
}

export interface CursorSdkRun {
  readonly id?: string;
  readonly status?: string;
  supports?(operation: string): boolean;
  unsupportedReason?(operation: string): string | undefined;
  stream(): AsyncIterable<CursorSdkMessage>;
  wait(): Promise<CursorSdkRunResult>;
  cancel?(): Promise<void>;
}

export interface CursorSdkRunResult {
  readonly status: string;
  readonly result?: string;
  readonly durationMs?: number;
}

export type CursorSdkMessage =
  | CursorSdkAssistantMessage
  | CursorSdkToolCallMessage
  | CursorSdkStatusMessage
  | CursorSdkThinkingMessage
  | CursorSdkTaskMessage
  | Record<string, unknown>;

export interface CursorSdkAssistantMessage {
  readonly type: 'assistant';
  readonly message: {
    readonly content: readonly CursorSdkContentBlock[];
  };
}

export type CursorSdkContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown };

export interface CursorSdkToolCallMessage {
  readonly type: 'tool_call';
  readonly call_id: string;
  readonly name: string;
  readonly status: 'running' | 'completed' | 'error' | string;
  readonly args?: unknown;
  readonly result?: unknown;
}

export interface CursorSdkStatusMessage {
  readonly type: 'status';
  readonly status: string;
  readonly message?: string;
}

export interface CursorSdkThinkingMessage {
  readonly type: 'thinking';
  readonly text: string;
}

export interface CursorSdkTaskMessage {
  readonly type: 'task';
  readonly status?: string;
  readonly text?: string;
}

export type CursorSdkJsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: CursorSdkJsonValue }
  | CursorSdkJsonValue[];

export interface CursorSdkCustomToolContext {
  readonly toolCallId?: string;
}

export interface CursorSdkCustomTool {
  readonly description?: string;
  readonly inputSchema?: Record<string, CursorSdkJsonValue>;
  execute(
    args: Record<string, CursorSdkJsonValue>,
    context: CursorSdkCustomToolContext,
  ): CursorSdkCustomToolResult | Promise<CursorSdkCustomToolResult>;
}

export type CursorSdkCustomTools = Record<string, CursorSdkCustomTool>;

export type CursorSdkCustomToolResult =
  | string
  | CursorSdkJsonValue
  | {
    readonly content: readonly CursorSdkCustomToolContent[];
    readonly isError?: boolean;
    readonly structuredContent?: Record<string, CursorSdkJsonValue>;
  };

export type CursorSdkCustomToolContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType?: string };

export function toolDefinitionInputSchema(tool: ToolDefinition): Record<string, CursorSdkJsonValue> | undefined {
  if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) {
    return undefined;
  }
  return tool.inputSchema as Record<string, CursorSdkJsonValue>;
}

export function toolResultText(result: ToolCallResult): string {
  if (result.content?.length) {
    return result.content.map(toolResultContentText).join('\n');
  }
  if (result.structuredContent) {
    return JSON.stringify(result.structuredContent);
  }
  if (result.error?.message) {
    return result.error.message;
  }
  return typeof result.pastTenseMessage === 'string'
    ? result.pastTenseMessage
    : result.pastTenseMessage.markdown;
}

function toolResultContentText(content: ToolResultContent): string {
  if (content.type === 'text') {
    return content.text;
  }
  return JSON.stringify(content);
}
