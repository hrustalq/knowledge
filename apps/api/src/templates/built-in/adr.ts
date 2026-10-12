import type { BuiltInTemplate } from './types.js';

export const ADR_TEMPLATE: BuiltInTemplate = {
  key: 'adr',
  version: 1,
  icon: '🧭',
  text: {
    en: {
      name: 'Architecture decision record',
      description: 'Record one architecture decision, the options weighed and its consequences.',
      source: `---
tags: [adr]
relations:
  - type: DESCRIBES
    target: "{{component}}"
template:
  category: architecture
  titlePattern: "ADR-{{number}}: {{title}}"
  placeholders:
    - { name: number, label: Number, kind: text, required: true, hint: "0042" }
    - { name: component, label: Affected component, kind: entity, hint: "service:billing" }
    - { name: deciders, label: Deciders, kind: text }
  aiInstructions: >-
    Fill Context, Decision, Alternatives and Consequences from the description.
    Give each rejected alternative one line on why it lost. Keep the status Proposed.
---
# {{title}}

**Status:** Proposed · **Date:** {{date}} · **Author:** {{author}} · **Deciders:** {{deciders}}

## Context

What problem forces a decision now? Describe the constraints you cannot change and the forces pulling in different directions.

## Decision

State the change in full sentences, in the active voice: "We will …".

## Alternatives considered

- **Option A**: why it was not chosen.
- **Option B**: why it was not chosen.

## Consequences

What becomes easier and what becomes harder because of this decision. Name the follow-up work and the risks you accept.

## References

- Related pages, tickets and discussions.
`,
    },
    ru: {
      name: 'Архитектурное решение (ADR)',
      description: 'Зафиксировать одно архитектурное решение, рассмотренные варианты и последствия.',
      source: `---
tags: [adr]
relations:
  - type: DESCRIBES
    target: "{{component}}"
template:
  category: architecture
  titlePattern: "ADR-{{number}}: {{title}}"
  placeholders:
    - { name: number, label: Номер, kind: text, required: true, hint: "0042" }
    - { name: component, label: Затронутый компонент, kind: entity, hint: "service:billing" }
    - { name: deciders, label: Кто принимает решение, kind: text }
  aiInstructions: >-
    Заполни разделы «Контекст», «Решение», «Альтернативы» и «Последствия» по описанию.
    Для каждой отклонённой альтернативы — одна строка о том, почему она проиграла. Статус оставь «Предложено».
---
# {{title}}

**Статус:** Предложено · **Дата:** {{date}} · **Автор:** {{author}} · **Принимают решение:** {{deciders}}

## Контекст

Какая проблема требует решения сейчас? Опишите ограничения, которые нельзя изменить, и силы, тянущие в разные стороны.

## Решение

Сформулируйте изменение полными предложениями: «Мы будем …».

## Рассмотренные альтернативы

- **Вариант А**: почему не выбран.
- **Вариант Б**: почему не выбран.

## Последствия

Что станет проще и что сложнее после этого решения. Назовите последующие задачи и риски, которые вы принимаете.

## Ссылки

- Связанные страницы, задачи и обсуждения.
`,
    },
  },
};
