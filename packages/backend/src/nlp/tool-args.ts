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
