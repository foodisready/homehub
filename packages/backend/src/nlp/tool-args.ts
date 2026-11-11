/**
 * The arguments of a tool call from the chat model. A small model sometimes
 * wraps them in the call's own shape:
 *   {"function": "set_power_state", "type": "function", "parameters": {"alias": "office lights", "state": "off"}}
 * instead of {"alias": "office lights", "state": "off"}. That's unwrapped here,
 * so the tool gets what was meant rather than nothing.
 */
export function toolArguments(raw: unknown): Record<string, unknown> {
  let args: unknown = raw;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return {}; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const obj = args as Record<string, unknown>;
  for (const key of ['parameters', 'arguments']) {
    const inner = obj[key];
    if (inner && typeof inner === 'object' && !Array.isArray(inner) && !('alias' in obj) && !('state' in obj)) {
      return inner as Record<string, unknown>;
    }
  }
  return obj;
}

/**
 * A small model sometimes writes its tool call as the reply's text instead of
 * making it: {"name": "set_power_state", "parameters": {...}}. If that text is
 * a whole, readable call to a tool HomeHub has, it's made after all. Text that
 * only looks like one (cut short, broken quotes) gives null, and
 * looksLikeToolCall says not to show it.
 */
export function toolCallInText(
  content: string,
  tools: readonly string[],
): { name: string; arguments: Record<string, unknown> } | null {
  const text = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  if (!text.startsWith('{')) return null;
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const inner = parsed.function && typeof parsed.function === 'object' ? parsed.function : parsed;
  const name = typeof inner.name === 'string' ? inner.name
    : typeof inner.function === 'string' ? inner.function : null;
  if (!name || !tools.includes(name)) return null;
  return { name, arguments: toolArguments(inner.parameters ?? inner.arguments ?? {}) };
}

/** Reply text that is a tool call, readable or not: never shown to anyone. */
export function looksLikeToolCall(content: string, tools: readonly string[]): boolean {
  const text = content.trim().replace(/^```(?:json)?\s*/, '');
  if (!text.startsWith('{') && !text.startsWith('[')) return false;
  return tools.some((t) => text.includes(t)) || /"(?:parameters|arguments)"\s*:/.test(text);
}
