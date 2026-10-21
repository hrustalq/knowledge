import { VERIFICATION_NOTE_MAX_CHARS } from '@knowledge/contracts/core';
import type { AssistantPromptOption } from '@knowledge/contracts/ai';

// ---------------------------------------------------------------------------
// Question flows (#425). A flow is a code-defined scenario: an ordered list of
// questions asked one at a time before a wide-reaching task runs. The same
// model reaches the person three ways — a `prompt` frame in the web chat, an
// MCP `elicitation/create` on stdio, or a `needs_input` tool result over HTTP —
// so everything here is pure: a flow is rebuilt from its answers alone, and
// there is no flow state table. The same answers always yield the same next
// question, which is what makes a retried MCP call and a reloaded thread agree.
// ---------------------------------------------------------------------------

export const FLOW_KEYS = ['capture-decision', 'mark-outdated'] as const;
export type FlowKey = (typeof FLOW_KEYS)[number];

/** An option. `recommended` is pre-selected; its `description` says why. */
export type FlowOption = AssistantPromptOption;

/** A recorded answer. `null` is a skipped optional question. */
export type FlowAnswer = string | string[] | null;
export type FlowAnswers = Record<string, FlowAnswer>;

interface FlowQuestionBase {
  /** Stable within the flow: the key in the answers bag. */
  id: string;
  label: string;
  description?: string;
  required?: boolean;
  /**
   * Hides the question when it no longer applies. It is evaluated against the
   * answers so far, including while its dependency is still unanswered, so
   * write it to hold until an answer rules it out (`a.page !== NO_LINK`, not
   * `a.page === X`): that keeps "Question n of m" an upper bound that only
   * shrinks, never one that grows under the person.
   */
  when?: (answers: FlowAnswers) => boolean;
}

export type FlowQuestion =
  | (FlowQuestionBase & { type: 'choice'; options: FlowOption[]; allowOther?: boolean; otherLabel?: string })
  | (FlowQuestionBase & { type: 'checklist'; options: FlowOption[]; allowOther?: boolean; otherLabel?: string })
  | (FlowQuestionBase & { type: 'text'; placeholder?: string; multiline?: boolean; maxLength?: number });

export interface FlowScenario {
  flow: FlowKey;
  questions: FlowQuestion[];
}

/** The ceiling on any free-text answer, "other" included, unless a question sets its own. */
export const FLOW_TEXT_MAX_CHARS = 2000;

export type FlowInvalidReason = 'required' | 'wrong-type' | 'not-an-option' | 'too-long';

export type FlowValidation = { ok: true; value: FlowAnswer } | { ok: false; reason: FlowInvalidReason };

/**
 * Check one answer against its question and normalize it (trimmed text,
 * de-duplicated checklist). An empty answer to an optional question is `null`;
 * an empty checklist is `[]`, a real answer ("exclude nothing"), unless the
 * checklist is required.
 */
export function validate(question: FlowQuestion, value: unknown): FlowValidation {
  const max = question.type === 'text' ? (question.maxLength ?? FLOW_TEXT_MAX_CHARS) : FLOW_TEXT_MAX_CHARS;
  const empty = () =>
    question.required ? ({ ok: false, reason: 'required' } as const) : ({ ok: true, value: null } as const);
  if (value === undefined || value === null) return empty();

  if (question.type === 'checklist') {
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return { ok: false, reason: 'wrong-type' };
    const picked = [...new Set(value.map((v) => v.trim()).filter(Boolean))];
    if (!picked.length && question.required) return { ok: false, reason: 'required' };
    const values = new Set(question.options.map((o) => o.value));
    for (const v of picked) {
      if (values.has(v)) continue;
      if (!question.allowOther) return { ok: false, reason: 'not-an-option' };
      if (v.length > max) return { ok: false, reason: 'too-long' };
    }
    return { ok: true, value: picked };
  }

  if (typeof value !== 'string') return { ok: false, reason: 'wrong-type' };
  const text = value.trim();
  if (!text) return empty();
  if (question.type === 'choice' && !question.options.some((o) => o.value === text)) {
    if (!question.allowOther) return { ok: false, reason: 'not-an-option' };
  }
  if (text.length > max) return { ok: false, reason: 'too-long' };
  return { ok: true, value: text };
}

export interface FlowDrop {
  question: string;
  /**
   * `not-applicable` — an earlier answer changed and this question stopped
   * applying; `invalid` — the value failed `validate`; `not-yet-asked` — an
   * earlier question is still open, so this answer would skip ahead;
   * `unknown` — no such question in the flow.
   */
  reason: 'not-applicable' | 'invalid' | 'not-yet-asked' | 'unknown';
}

export interface FlowPruned {
  answers: FlowAnswers;
  dropped: FlowDrop[];
}

/**
 * Keep the answers that still count, in question order, and report the rest.
 * A flow is strictly sequential: the walk stops at the first open (or
 * invalid) question, and an answer to anything after it is dropped as
 * not-yet-asked rather than applied out of order.
 */
export function prune(scenario: FlowScenario, answers: Record<string, unknown>): FlowPruned {
  const kept: FlowAnswers = {};
  const dropped: FlowDrop[] = [];
  let open = false;
  for (const q of scenario.questions) {
    const given = Object.prototype.hasOwnProperty.call(answers, q.id) ? answers[q.id] : undefined;
    if (open) {
      if (given !== undefined) dropped.push({ question: q.id, reason: 'not-yet-asked' });
      continue;
    }
    if (q.when && !q.when(kept)) {
      if (given !== undefined) dropped.push({ question: q.id, reason: 'not-applicable' });
      continue;
    }
    if (given === undefined) {
      open = true;
      continue;
    }
    const checked = validate(q, given);
    if (!checked.ok) {
      dropped.push({ question: q.id, reason: 'invalid' });
      open = true;
      continue;
    }
    kept[q.id] = checked.value;
  }
  const ids = new Set(scenario.questions.map((q) => q.id));
  for (const key of Object.keys(answers)) {
    if (!ids.has(key)) dropped.push({ question: key, reason: 'unknown' });
  }
  return { answers: kept, dropped };
}

export interface FlowStep {
  question: FlowQuestion;
  /** 1-based position among the questions that apply. */
  step: number;
  /** How many apply given the answers so far — an upper bound that only shrinks. */
  of: number;
}

/** The open question, or `null` when every question that applies is answered and the task may run. */
export function nextQuestion(scenario: FlowScenario, answers: Record<string, unknown>): FlowStep | null {
  const kept = prune(scenario, answers).answers;
  const applies = (q: FlowQuestion) => !q.when || q.when(kept);
  const answered = scenario.questions.filter((q) => q.id in kept).length;
  const index = scenario.questions.findIndex((q) => !(q.id in kept) && applies(q));
  if (index < 0) return null;
  const after = scenario.questions.slice(index + 1).filter(applies).length;
  return { question: scenario.questions[index], step: answered + 1, of: answered + 1 + after };
}

// ---------------------------------------------------------------------------
// MCP elicitation. An elicitation schema is flat and primitive-only: a
// checklist cannot be an array, so it is one boolean per option, and a
// required enum cannot sit beside an "other" box, so a question that allows
// "other" is sent optional and `validate` checks that one of the two came back.
// ---------------------------------------------------------------------------

/** The free-text property beside an enum or a checklist. Underscored so no option value or question id collides with it. */
export const FLOW_OTHER_KEY = '_other';

export type FlowElicitationProperty =
  | { type: 'string'; title: string; description?: string; maxLength?: number; default?: string }
  | { type: 'string'; title: string; description?: string; oneOf: { const: string; title: string }[]; default?: string }
  | { type: 'boolean'; title: string; description?: string; default?: boolean };

export interface FlowElicitationSchema {
  type: 'object';
  properties: Record<string, FlowElicitationProperty>;
  required?: string[];
}

/** The `requestedSchema` that asks one question. Inverse: {@link fromElicitation}. */
export function toElicitationSchema(question: FlowQuestion): FlowElicitationSchema {
  const help = question.description ? { description: question.description } : {};
  if (question.type === 'text') {
    return {
      type: 'object',
      properties: {
        [question.id]: {
          type: 'string',
          title: question.label,
          ...help,
          maxLength: question.maxLength ?? FLOW_TEXT_MAX_CHARS,
        },
      },
      ...(question.required ? { required: [question.id] } : {}),
    };
  }

  const other: Record<string, FlowElicitationProperty> = question.allowOther
    ? { [FLOW_OTHER_KEY]: { type: 'string', title: question.otherLabel ?? 'Other', maxLength: FLOW_TEXT_MAX_CHARS } }
    : {};

  if (question.type === 'checklist') {
    const boxes: Record<string, FlowElicitationProperty> = {};
    for (const o of question.options) {
      boxes[o.value] = {
        type: 'boolean',
        title: o.label,
        ...(o.description ? { description: o.description } : {}),
        default: o.recommended === true,
      };
    }
    return { type: 'object', properties: { ...boxes, ...other } };
  }

  const recommended = question.options.find((o) => o.recommended);
  return {
    type: 'object',
    properties: {
      [question.id]: {
        type: 'string',
        title: question.label,
        ...help,
        oneOf: question.options.map((o) => ({ const: o.value, title: o.label })),
        ...(recommended ? { default: recommended.value } : {}),
      },
      ...other,
    },
    ...(question.required && !question.allowOther ? { required: [question.id] } : {}),
  };
}

/**
 * Fold an accepted elicitation's `content` back into the value the web sends
 * for the same question — feed the result to `validate`. A checklist comes
 * back as the array of ticked option values (plus the "other" text).
 */
export function fromElicitation(question: FlowQuestion, content: Record<string, unknown>): unknown {
  const other = typeof content[FLOW_OTHER_KEY] === 'string' ? (content[FLOW_OTHER_KEY] as string).trim() : '';
  if (question.type === 'checklist') {
    const picked = question.options.filter((o) => content[o.value] === true).map((o) => o.value);
    return question.allowOther && other ? [...picked, other] : picked;
  }
  const value = content[question.id];
  if (question.type === 'choice' && question.allowOther && other) return other;
  return value;
}

// ---------------------------------------------------------------------------
// Scenarios. The questions are code; the options are the caller's workspace
// data (projects, search hits, members), never model output. Labels come
// through `text`, the caller's translator, so this package carries no copy.
// ---------------------------------------------------------------------------

export type FlowTextKey =
  | 'captureDecision.project'
  | 'captureDecision.relatedPage'
  | 'captureDecision.noLink'
  | 'captureDecision.reviewer'
  | 'markOutdated.scope'
  | 'markOutdated.scopePage'
  | 'markOutdated.scopeSubtree'
  | 'markOutdated.exclusions'
  | 'markOutdated.reason';

export type FlowText = (key: FlowTextKey, params?: Record<string, string | number>) => string;

/** The related-page option that links nothing — and so asks for no reviewer. */
export const FLOW_NO_LINK = 'none';

export interface CaptureDecisionFlowInput {
  projects: FlowOption[];
  /** Candidate pages, best first. "No link" is appended. */
  pages: FlowOption[];
  /** Candidate reviewers, the linked page's owner marked recommended. */
  reviewers: FlowOption[];
}

/** Capture a decision: project → related page → reviewer (only when a page is linked). */
export function captureDecisionFlow(input: CaptureDecisionFlowInput, text: FlowText): FlowScenario {
  const pages = [...input.pages, { value: FLOW_NO_LINK, label: text('captureDecision.noLink') }];
  if (!pages.some((o) => o.recommended)) pages[pages.length - 1] = { ...pages[pages.length - 1], recommended: true };
  return {
    flow: 'capture-decision',
    questions: [
      { id: 'project', type: 'choice', label: text('captureDecision.project'), options: input.projects, required: true },
      { id: 'relatedPage', type: 'choice', label: text('captureDecision.relatedPage'), options: pages, required: true },
      {
        id: 'reviewer',
        type: 'choice',
        label: text('captureDecision.reviewer'),
        options: input.reviewers,
        when: (a) => a.relatedPage !== FLOW_NO_LINK,
      },
    ],
  };
}

export const FLOW_SCOPE_PAGE = 'page';
export const FLOW_SCOPE_SUBTREE = 'subtree';

export interface MarkOutdatedFlowInput {
  /** The pages under the one being marked. None → no scope question; the page alone is marked. */
  descendants: FlowOption[];
}

/** Mark pages outdated: scope → exclusions (only when wider than one page) → reason. */
export function markOutdatedFlow(input: MarkOutdatedFlowInput, text: FlowText): FlowScenario {
  const wide = input.descendants.length > 0;
  return {
    flow: 'mark-outdated',
    questions: [
      {
        id: 'scope',
        type: 'choice',
        label: text('markOutdated.scope'),
        required: true,
        options: [
          { value: FLOW_SCOPE_PAGE, label: text('markOutdated.scopePage'), recommended: true },
          {
            value: FLOW_SCOPE_SUBTREE,
            label: text('markOutdated.scopeSubtree', { count: input.descendants.length }),
          },
        ],
        when: () => wide,
      },
      {
        id: 'exclusions',
        type: 'checklist',
        label: text('markOutdated.exclusions'),
        options: input.descendants,
        when: (a) => wide && a.scope !== FLOW_SCOPE_PAGE,
      },
      {
        id: 'reason',
        type: 'text',
        label: text('markOutdated.reason'),
        multiline: true,
        maxLength: VERIFICATION_NOTE_MAX_CHARS,
      },
    ],
  };
}
