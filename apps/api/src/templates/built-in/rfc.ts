import type { BuiltInTemplate } from './types.js';

export const RFC_TEMPLATE: BuiltInTemplate = {
  key: 'rfc',
  version: 1,
  icon: '💡',
  text: {
    en: {
      name: 'Request for comments',
      description: 'Propose a change before building it and collect feedback on the design.',
      source: `---
tags: [rfc]
relations:
  - type: DESCRIBES
    target: "{{component}}"
template:
  category: architecture
  titlePattern: "RFC: {{title}}"
  placeholders:
    - { name: component, label: Affected component, kind: entity, hint: "service:search" }
    - { name: reviewers, label: Reviewers, kind: text }
    - { name: deadline, label: Feedback by, kind: date }
  aiInstructions: >-
    Fill Summary, Motivation and Proposal from the description. List open questions
    the author has not answered rather than inventing answers.
---
# {{title}}

**Author:** {{author}} · **Date:** {{date}} · **Reviewers:** {{reviewers}} · **Feedback by:** {{deadline}}

## Summary

One paragraph: what you propose and what changes for whom.

## Motivation

Why now? The problem, who has it, and what happens if nothing changes.

## Proposal

The design in enough detail to review: components, data, interfaces and the order of the work.

## Drawbacks and risks

What this costs, and what could go wrong.

## Alternatives

Other designs considered and why this one is preferred.

## Open questions

- Questions the reviewers should help answer.
`,
    },
    ru: {
      name: 'Запрос комментариев (RFC)',
      description: 'Предложить изменение до реализации и собрать отзывы о дизайне.',
      source: `---
tags: [rfc]
relations:
  - type: DESCRIBES
    target: "{{component}}"
template:
  category: architecture
  titlePattern: "RFC: {{title}}"
  placeholders:
    - { name: component, label: Затронутый компонент, kind: entity, hint: "service:search" }
    - { name: reviewers, label: Рецензенты, kind: text }
    - { name: deadline, label: Отзывы до, kind: date }
  aiInstructions: >-
    Заполни «Кратко», «Мотивацию» и «Предложение» по описанию. Вопросы, на которые
    автор не ответил, перечисли в «Открытых вопросах», а не придумывай ответы.
---
# {{title}}

**Автор:** {{author}} · **Дата:** {{date}} · **Рецензенты:** {{reviewers}} · **Отзывы до:** {{deadline}}

## Кратко

Один абзац: что вы предлагаете и что меняется и для кого.

## Мотивация

Почему сейчас? Проблема, у кого она есть и что будет, если ничего не менять.

## Предложение

Дизайн в объёме, достаточном для ревью: компоненты, данные, интерфейсы и порядок работ.

## Недостатки и риски

Чего это стоит и что может пойти не так.

## Альтернативы

Другие варианты и почему предпочтителен этот.

## Открытые вопросы

- Вопросы, с которыми должны помочь рецензенты.
`,
    },
  },
};
