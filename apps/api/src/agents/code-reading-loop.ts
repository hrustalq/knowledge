import type { ChatCompletionFunctionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { AiCallContext, AssistantClient, ToolExecutor } from '../assistant/assistant.client.js';

/**
 * One bounded read of a repository by a model with the code tools
 * (docs/features/31, lifted for docs/features/46).
 *
 * The archaeologist reads each candidate file this way, and the repo wiki
 * reads each section this way at effort `high`. What they share is not the
 * prompt — each brings its own — but the three rules around the loop:
 *
 * - **the tool budget is the agent's, and a caller may only lower it** —
 *   `maxToolCalls` narrows, never widens, what the agent's config allows;
 * - **an agent that cannot call tools still answers**, with one plain call
 *   over what it was shown, rather than failing the read;
 * - **every path the model actually opened is recorded**: a path seen in a
 *   tree listing is not a path that was read, and a finding may cite only the
 *   paths in `readPaths`.
 *
 * A leaf: it imports types only, and the tools and their executor arrive as
 * arguments. That is what lets `ConnectorAdaptersModule` use it without
 * importing the code-research module, which imports the adapters.
 */
export interface CodeReadingLoopInput {
  client: Pick<AssistantClient, 'chat' | 'runWithTools'>;
  call: AiCallContext;
  messages: ChatCompletionMessageParam[];
  tools: ChatCompletionFunctionTool[];
  execute: ToolExecutor;
  /** The agent has no tool capability: answer in one call. */
  toolless?: boolean;
  /** The answer is a JSON object (asked for on the final, toolless round only). */
  json?: boolean;
  /** A ceiling under the agent's own `maxToolCalls`. */
  maxToolCalls?: number;
  /** Paths the model was shown before the loop began — they count as read. */
  seen?: Iterable<string>;
}

export interface CodeReadingLoopResult {
  content: string;
  readPaths: Set<string>;
}

const READING_TOOLS = new Set(['code_read', 'code_outline']);

export async function runCodeReadingLoop(input: CodeReadingLoopInput): Promise<CodeReadingLoopResult> {
  const readPaths = new Set<string>(input.seen ?? []);
  const execute: ToolExecutor = (name, args, callId) => {
    if (READING_TOOLS.has(name) && typeof args.path === 'string') {
      readPaths.add(args.path.trim().replace(/^\.?\//, ''));
    }
    return input.execute(name, args, callId);
  };

  const ceiling = input.maxToolCalls;
  const call: AiCallContext =
    ceiling !== undefined && ceiling < input.call.config.maxToolCalls
      ? { ...input.call, config: { ...input.call.config, maxToolCalls: ceiling } }
      : input.call;

  const content = input.toolless
    ? await input.client.chat(call, input.messages, input.json ? { json: true } : undefined)
    : (await input.client.runWithTools(call, input.messages, input.tools, execute, { jsonFinalRound: input.json })).content;
  return { content, readPaths };
}

/**
 * The code tools as offered over one repository the caller already chose:
 * the `connectorId` parameter dropped, since whatever the model wrote there,
 * the caller decides which repository is read.
 */
export function withoutConnectorParam(tools: ChatCompletionFunctionTool[]): ChatCompletionFunctionTool[] {
  return tools.map((tool) => {
    const params = tool.function.parameters as
      | { properties?: Record<string, unknown>; required?: string[] }
      | undefined;
    if (!params?.properties || !('connectorId' in params.properties)) return tool;
    const { connectorId: _dropped, ...properties } = params.properties;
    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: { ...params, properties, required: (params.required ?? []).filter((r) => r !== 'connectorId') },
      },
    };
  });
}
