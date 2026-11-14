/**
 * Narrow the offered tools to the agent's allowlist (docs/features/20).
 *
 * The built-in lists are exactly what `definitions(mode, { ui })` returns, so
 * an untouched workspace is unchanged; an admin who unticks a tool actually
 * loses it. Intersection, never union: an allowlist that could *add* a tool
 * would let a settings row widen what the model can reach, which is the one
 * thing agent configuration must never do.
 *
 * MCP plugin tools obey it too (#1105): they receive model-chosen arguments
 * and reach a system outside this one, so an agent with a list gets one only
 * when the list names it (`mcp__<slug>__<tool>`, accepted by the agent form).
 * The plugin's own enabled-tools list still narrows on top.
 */
export function scopeToAgent<T extends { function: { name: string } }>(offered: T[], agentTools: readonly string[]): T[] {
  if (agentTools.length === 0) return offered;
  const allowed = new Set(agentTools);
  return offered.filter((tool) => allowed.has(tool.function.name));
}
