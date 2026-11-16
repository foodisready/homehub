import { CLAUDE_MODEL } from './ai-choice';

/**
 * Chat with Claude Haiku, for what the rules and the form didn't settle: questions, schedules,
 * energy. The same tools and instructions as the chat model on this HomeHub, so it can do
 * exactly what that one can and nothing more (executeTool keeps the same limits: a garage door
 * only closes, protected devices stay as they are).
 */

export interface ChatTurn { role: 'user' | 'assistant'; content: string }

/** A tool as the Ollama chat defines it (nlp.service.ts TOOLS). */
export interface FunctionTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ClaudeChatResult {
  response:     string;
  actions:      { tool: string; args: Record<string, unknown>; result: unknown }[];
  inputTokens:  number;
  outputTokens: number;
}

export class ClaudeChatError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

/** Each Anthropic request: a person is waiting, so one quick retry, then the local model. */
const TIMEOUT_MS = 15_000;
const MAX_ROUNDS = 6;

export async function chatWithClaude(
  text: string,
  history: ChatTurn[],
  opts: {
    apiKey:  string;
    system:  string;
    tools:   FunctionTool[];
    execute: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    /** Checked after each round of tool calls: true ends the chat there (HomeHub asks the person instead). */
    stop?:   () => boolean;
    /** For tests. */
    client?: { messages: { create: (body: any) => Promise<any> } };
  },
): Promise<ClaudeChatResult> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  const tools = opts.tools.map((t) => ({
    name: t.function.name, description: t.function.description, input_schema: t.function.parameters as { type: 'object' },
  }));

  // The conversation so far, starting with a person's message and alternating, as the API wants.
  const past = history.slice(-10).filter((m) => m.content.trim());
  while (past.length && past[0].role !== 'user') past.shift();
  const messages: any[] = [];
  for (const m of past) {
    const last = messages[messages.length - 1];
    if (last?.role === m.role) last.content += `\n${m.content}`;
    else messages.push({ role: m.role, content: m.content });
  }
  if (messages[messages.length - 1]?.role === 'user') messages.push({ role: 'assistant', content: '(no answer)' });
  messages.push({ role: 'user', content: text });

  const actions: ClaudeChatResult['actions'] = [];
  let inputTokens = 0, outputTokens = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let res: any;
    try {
      res = await client.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: opts.system,
        tools,
        messages,
        output_config: { effort: 'low' },
      });
    } catch (err) {
      if (err instanceof Anthropic.APIError) throw new ClaudeChatError(err.message, err.status);
      throw new ClaudeChatError((err as Error).message);
    }
    inputTokens += res.usage?.input_tokens ?? 0;
    outputTokens += res.usage?.output_tokens ?? 0;
    if (res.stop_reason === 'refusal') throw new ClaudeChatError('refused');

    const calls = (res.content as any[]).filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !calls.length) {
      const response = (res.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      return { response, actions, inputTokens, outputTokens };
    }

    // The whole answer goes back, thinking included, with a result for every call.
    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const call of calls) {
      const args = (call.input ?? {}) as Record<string, unknown>;
      let result: unknown;
      try { result = await opts.execute(call.name, args); }
      catch (err) { result = { error: (err as Error).message }; }
      actions.push({ tool: call.name, args, result });
      results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: results });
    if (opts.stop?.()) return { response: '', actions, inputTokens, outputTokens };
  }
  return { response: '', actions, inputTokens, outputTokens };
}
