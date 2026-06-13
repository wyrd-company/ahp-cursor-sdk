import { Agent } from '@cursor/sdk';

import type { CursorSdkCreateAgentOptions, CursorSdkRuntime } from './types.js';

export function createCursorSdkRuntime(): CursorSdkRuntime {
  return {
    createAgent(options: CursorSdkCreateAgentOptions) {
      return Agent.create(options as never);
    },
    resumeAgent(agentId: string, options: CursorSdkCreateAgentOptions) {
      return Agent.resume(agentId, options as never);
    },
  };
}
