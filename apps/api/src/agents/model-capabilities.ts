import type { AgentCapability } from '@knowledge/contracts';

/**
 * What a model can do (docs/features/20).
 *
 * This is a code table with a per-profile override column, exactly the shape
 * `MODEL_PRICES` + `ai_providers.price_*_per_mtok` already has in
 * ai-config.service.ts — and for the same reason: any hardcoded list of models
 * goes stale, so the table is a good default and never the last word.
 *
 * Matching is by substring on a lowercased model id, because the same model
 * arrives under many names through aggregators ('gpt-4o', 'openai/gpt-4o',
 * 'gpt-4o-2024-11-20'). Order matters: the first pattern that matches wins.
 */
interface CapabilityRule {
  match: string[];
  capabilities: AgentCapability[];
}

const RULES: CapabilityRule[] = [
  // --- Vision-capable chat models -------------------------------------------
  { match: ['gpt-4o', 'gpt-4-1', 'gpt-4.1', 'gpt-4-turbo', 'gpt-5', 'o4-mini'], capabilities: ['tools', 'json', 'vision'] },
  { match: ['claude-3', 'claude-4', 'claude-sonnet', 'claude-opus', 'claude-haiku'], capabilities: ['tools', 'json', 'vision'] },
  { match: ['gemini-1-5', 'gemini-1.5', 'gemini-2', 'gemini-pro-vision'], capabilities: ['tools', 'json', 'vision'] },
  { match: ['llava', '-vl', 'vision', 'pixtral', 'qwen2-vl', 'qwen2.5-vl'], capabilities: ['json', 'vision'] },

  // --- Text-only, tool-capable ----------------------------------------------
  { match: ['deepseek-chat', 'deepseek-v3'], capabilities: ['tools', 'json'] },
  // DeepSeek's reasoner rejects function calling and json mode; routing a tool
  // agent at it fails at call time, which is exactly what the gate prevents.
  { match: ['deepseek-reasoner', 'deepseek-r1'], capabilities: [] },
  { match: ['gpt-4', 'gpt-3-5', 'gpt-3.5', 'mistral', 'mixtral', 'qwen', 'llama-3', 'gemma'], capabilities: ['tools', 'json'] },

  // --- Embedding models are not chat models at all --------------------------
  { match: ['embed', 'bge-', 'e5-'], capabilities: [] },
];

/**
 * Unknown models get tools + json but NOT vision.
 *
 * The asymmetry is deliberate. A wrong "supports tools" guess fails loudly at
 * call time with a provider error; a wrong "supports vision" guess produces a
 * confident transcription of an image the model never saw. Only one of those is
 * recoverable by reading the output, so vision has to be opt-in.
 */
const UNKNOWN_MODEL_CAPABILITIES: AgentCapability[] = ['tools', 'json'];

/** Capabilities declared by an admin on the provider profile, if the column is valid. */
export function readCapabilityOverride(value: unknown): AgentCapability[] | null {
  if (!Array.isArray(value)) return null;
  const known: AgentCapability[] = ['tools', 'vision', 'json'];
  const picked = value.filter((v): v is AgentCapability => known.includes(v as AgentCapability));
  return picked.length === value.length ? picked : null;
}

/** What this model can do: the admin's declaration if there is one, else the table. */
export function capabilitiesFor(model: string, override?: unknown): Set<AgentCapability> {
  const declared = readCapabilityOverride(override);
  if (declared) return new Set(declared);
  const id = (model || '').toLowerCase();
  for (const rule of RULES) {
    if (rule.match.some((needle) => id.includes(needle))) return new Set(rule.capabilities);
  }
  return new Set(UNKNOWN_MODEL_CAPABILITIES);
}

/** Which of `required` this model does not provide. Empty means it is usable. */
export function missingCapabilities(
  required: readonly AgentCapability[],
  model: string,
  override?: unknown,
): AgentCapability[] {
  const has = capabilitiesFor(model, override);
  return required.filter((capability) => !has.has(capability));
}
