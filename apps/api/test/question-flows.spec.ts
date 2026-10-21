import { describe, expect, it } from 'vitest';
import {
  captureDecisionFlow,
  FLOW_NO_LINK,
  FLOW_OTHER_KEY,
  FLOW_SCOPE_PAGE,
  FLOW_SCOPE_SUBTREE,
  fromElicitation,
  markOutdatedFlow,
  nextQuestion,
  prune,
  toElicitationSchema,
  validate,
  type FlowQuestion,
  type FlowText,
} from '@knowledge/contracts';

const text: FlowText = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key);

const decision = captureDecisionFlow(
  {
    projects: [
      { value: 'p1', label: 'Platform', recommended: true },
      { value: 'p2', label: 'Billing' },
    ],
    pages: [{ value: 'd1', label: 'Search ranking', recommended: true }],
    reviewers: [{ value: 'u1', label: 'Ann', recommended: true }],
  },
  text,
);

describe('question flows (#425)', () => {
  it('asks one question at a time, counting only what still applies', () => {
    expect(nextQuestion(decision, {})).toMatchObject({ question: { id: 'project' }, step: 1, of: 3 });
    expect(nextQuestion(decision, { project: 'p1' })).toMatchObject({ question: { id: 'relatedPage' }, step: 2, of: 3 });
    expect(nextQuestion(decision, { project: 'p1', relatedPage: 'd1' })).toMatchObject({
      question: { id: 'reviewer' },
      step: 3,
      of: 3,
    });
    expect(nextQuestion(decision, { project: 'p1', relatedPage: 'd1', reviewer: 'u1' })).toBeNull();
  });

  it('is rebuilt from the answers alone: the same bag gives the same question', () => {
    const bag = { project: 'p2' };
    expect(nextQuestion(decision, bag)).toEqual(nextQuestion(decision, { ...bag }));
  });

  it('"No link" removes the reviewer question and drops its earlier answer', () => {
    const changed = { project: 'p1', relatedPage: FLOW_NO_LINK, reviewer: 'u1' };
    expect(prune(decision, changed)).toEqual({
      answers: { project: 'p1', relatedPage: FLOW_NO_LINK },
      dropped: [{ question: 'reviewer', reason: 'not-applicable' }],
    });
    expect(nextQuestion(decision, changed)).toBeNull();
    expect(nextQuestion(decision, { project: 'p1' })?.of).toBe(3);
  });

  it('ignores and reports answers that skip ahead, are invalid or are not in the flow', () => {
    expect(prune(decision, { reviewer: 'u1', nope: 'x' })).toEqual({
      answers: {},
      dropped: [
        { question: 'reviewer', reason: 'not-yet-asked' },
        { question: 'nope', reason: 'unknown' },
      ],
    });
    expect(prune(decision, { project: 'not-a-project', relatedPage: 'd1' }).dropped).toEqual([
      { question: 'project', reason: 'invalid' },
      { question: 'relatedPage', reason: 'not-yet-asked' },
    ]);
  });

  it('records a skipped optional question as null, and a required one stays open', () => {
    expect(prune(decision, { project: 'p1', relatedPage: 'd1', reviewer: null }).answers.reviewer).toBeNull();
    expect(nextQuestion(decision, { project: 'p1', relatedPage: 'd1', reviewer: null })).toBeNull();
    expect(nextQuestion(decision, { project: null })?.question.id).toBe('project');
  });

  it('recommends "No link" when no candidate page is', () => {
    const flow = captureDecisionFlow({ projects: [], pages: [{ value: 'd1', label: 'A' }], reviewers: [] }, text);
    const page = flow.questions[1] as Extract<FlowQuestion, { type: 'choice' }>;
    expect(page.options.find((o) => o.recommended)?.value).toBe(FLOW_NO_LINK);
  });

  it('validates by type, option set and length', () => {
    const choice: FlowQuestion = { id: 'c', type: 'choice', label: 'C', options: [{ value: 'a', label: 'A' }], required: true };
    expect(validate(choice, ' a ')).toEqual({ ok: true, value: 'a' });
    expect(validate(choice, 'b')).toEqual({ ok: false, reason: 'not-an-option' });
    expect(validate({ ...choice, allowOther: true }, 'b')).toEqual({ ok: true, value: 'b' });
    expect(validate(choice, '')).toEqual({ ok: false, reason: 'required' });
    expect(validate(choice, 1)).toEqual({ ok: false, reason: 'wrong-type' });
    const box: FlowQuestion = { id: 'x', type: 'checklist', label: 'X', options: [{ value: 'a', label: 'A' }] };
    expect(validate(box, ['a', 'a'])).toEqual({ ok: true, value: ['a'] });
    expect(validate(box, [])).toEqual({ ok: true, value: [] });
    expect(validate({ ...box, required: true }, [])).toEqual({ ok: false, reason: 'required' });
    expect(validate({ id: 't', type: 'text', label: 'T', maxLength: 3 }, 'abcd')).toEqual({ ok: false, reason: 'too-long' });
  });

  it('marks a page alone without a scope question, and asks exclusions only for a subtree', () => {
    const lone = markOutdatedFlow({ descendants: [] }, text);
    expect(nextQuestion(lone, {})).toMatchObject({ question: { id: 'reason' }, step: 1, of: 1 });

    const tree = markOutdatedFlow({ descendants: [{ value: 'c1', label: 'Child' }] }, text);
    expect(nextQuestion(tree, {})).toMatchObject({ question: { id: 'scope' }, of: 3 });
    expect(nextQuestion(tree, { scope: FLOW_SCOPE_PAGE })).toMatchObject({ question: { id: 'reason' }, step: 2, of: 2 });
    expect(nextQuestion(tree, { scope: FLOW_SCOPE_SUBTREE })?.question.id).toBe('exclusions');
  });

  it('elicits a checklist as one boolean per option and folds back to the array the web sends', () => {
    const tree = markOutdatedFlow(
      { descendants: [{ value: 'c1', label: 'One' }, { value: 'c2', label: 'Two', recommended: true }] },
      text,
    );
    const exclusions = tree.questions[1];
    const schema = toElicitationSchema(exclusions);
    expect(schema.properties).toEqual({
      c1: { type: 'boolean', title: 'One', default: false },
      c2: { type: 'boolean', title: 'Two', default: true },
    });
    expect(schema.required).toBeUndefined();
    const folded = fromElicitation(exclusions, { c1: true, c2: false });
    expect(validate(exclusions, folded)).toEqual(validate(exclusions, ['c1']));
  });

  it('sends a choice that allows "other" optional, with the free text beside it', () => {
    const q: FlowQuestion = {
      id: 'c',
      type: 'choice',
      label: 'C',
      required: true,
      allowOther: true,
      options: [{ value: 'a', label: 'A', recommended: true }],
    };
    const schema = toElicitationSchema(q);
    expect(schema.required).toBeUndefined();
    expect(schema.properties.c).toMatchObject({ oneOf: [{ const: 'a', title: 'A' }], default: 'a' });
    expect(schema.properties[FLOW_OTHER_KEY]).toMatchObject({ type: 'string' });
    expect(validate(q, fromElicitation(q, { [FLOW_OTHER_KEY]: ' mine ' }))).toEqual({ ok: true, value: 'mine' });
    expect(validate(q, fromElicitation(q, {}))).toEqual({ ok: false, reason: 'required' });
    expect(toElicitationSchema({ ...q, allowOther: false }).required).toEqual(['c']);
  });
});
