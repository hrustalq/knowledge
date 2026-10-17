import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import {
  STYLE_RULE_ID_PATTERN,
  STYLE_RULE_SEVERITIES,
  STYLE_RULE_TEXT_MAX,
  type LintViolation,
  type StyleRule,
  type StyleRuleSeverity,
} from '@knowledge/contracts';
import { wrapUntrusted } from '../common/untrusted.js';

/**
 * Styleguide lint (#74), Nest-free so the editor's check, the MCP tool and a
 * merge request's lint run share one prompt and one gate on what comes back.
 *
 * The rules are trusted (only admins write them) and go in the system prompt;
 * the text is untrusted and wrapped. What the model may claim is enforced here,
 * after the call, never in the prompt: a violation of a rule that is not on the
 * list, or of a disabled one, is dropped; so is one whose quote is not in the
 * text verbatim; and the severity is the rule's, whatever the model wrote.
 */

/** As much text as one lint reads — the review endpoint's cap. */
export const LINT_TEXT_MAX = 60_000;

/** A quote shorter than this is grounded by accident ("a", "the"), not by reading. */
const MIN_QUOTE = 3;
const MESSAGE_MAX = 500;

/** `rules` is Json: read it defensively, keeping only well-formed rules. */
export function readStyleRules(raw: unknown): StyleRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: StyleRule[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.id !== 'string' || !STYLE_RULE_ID_PATTERN.test(r.id)) continue;
    if (typeof r.text !== 'string' || !r.text.trim()) continue;
    const severity = (STYLE_RULE_SEVERITIES as readonly unknown[]).includes(r.severity)
      ? (r.severity as StyleRuleSeverity)
      : 'warning';
    const ex = r.example as Record<string, unknown> | undefined;
    const example =
      ex && typeof ex.bad === 'string' && typeof ex.good === 'string' && (ex.bad.trim() || ex.good.trim())
        ? { bad: ex.bad, good: ex.good }
        : undefined;
    rules.push({ id: r.id, text: r.text, severity, enabled: r.enabled !== false, ...(example ? { example } : {}) });
  }
  return rules;
}

export function enabledRules(rules: StyleRule[]): StyleRule[] {
  return rules.filter((r) => r.enabled);
}

/**
 * The styleguide block appended to the linter's instructions: enabled rules
 * only, numbered, each with the id the model must cite. Empty string when no
 * rule is enabled, so callers can concatenate unconditionally.
 */
export function renderStyleguide(rules: StyleRule[]): string {
  const live = enabledRules(rules);
  if (live.length === 0) return '';
  const lines = live.map((r, i) => {
    const head = `${i + 1}. [${r.id}] (${r.severity}) ${clip(r.text, STYLE_RULE_TEXT_MAX)}`;
    if (!r.example) return head;
    return (
      `${head}\n   Breaks it: ${JSON.stringify(clip(r.example.bad, STYLE_RULE_TEXT_MAX))}\n` +
      `   Follows it: ${JSON.stringify(clip(r.example.good, STYLE_RULE_TEXT_MAX))}`
    );
  });
  return (
    '\n\nThe styleguide. Unlike the text you check, these rules are written by the workspace administrators ' +
    'and are the only standard you apply:\n\n' +
    lines.join('\n')
  );
}

/** The linter's two messages: instructions + rules (trusted), then the text (untrusted). */
export function lintMessages(instructions: string, rules: StyleRule[], title: string, text: string): ChatCompletionMessageParam[] {
  const body = `Title: ${title || '(untitled)'}\n\n${text.slice(0, LINT_TEXT_MAX)}`;
  return [
    { role: 'system', content: instructions + renderStyleguide(rules) },
    { role: 'user', content: wrapUntrusted(body, 'lint', 'draft') },
  ];
}

/**
 * What the harness accepts of the model's answer. `text` is what was linted —
 * a quote must be in it exactly. Each `(rule, quote)` pair is reported once,
 * and at most `max` violations survive, errors first.
 */
export function readLintViolations(
  parsed: Record<string, unknown> | null,
  rules: StyleRule[],
  text: string,
  max: number,
): { violations: LintViolation[]; dropped: number } {
  const raw = Array.isArray(parsed?.violations) ? (parsed.violations as unknown[]) : [];
  const byId = new Map(enabledRules(rules).map((r) => [r.id, r]));
  const seen = new Set<string>();
  const kept: LintViolation[] = [];
  let dropped = 0;

  for (const item of raw) {
    const v = item as Record<string, unknown> | null;
    const rule = typeof v?.ruleId === 'string' ? byId.get(v.ruleId.trim()) : undefined;
    const quote = typeof v?.quote === 'string' ? v.quote.trim() : '';
    if (!rule || quote.length < MIN_QUOTE || !text.includes(quote)) {
      dropped += 1;
      continue;
    }
    const key = `${rule.id}\u0000${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const message = typeof v?.message === 'string' && v.message.trim() ? clip(v.message.trim(), MESSAGE_MAX) : clip(rule.text, MESSAGE_MAX);
    const suggestion = typeof v?.suggestion === 'string' && v.suggestion.trim() ? clip(v.suggestion.trim(), MESSAGE_MAX) : undefined;
    kept.push({ ruleId: rule.id, severity: rule.severity, quote, message, ...(suggestion ? { suggestion } : {}) });
  }

  const rank = (s: StyleRuleSeverity) => STYLE_RULE_SEVERITIES.indexOf(s);
  kept.sort((a, b) => rank(a.severity) - rank(b.severity));
  return { violations: kept.slice(0, max), dropped };
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
