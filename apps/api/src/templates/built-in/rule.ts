import type { BuiltInTemplate } from './types.js';

export const RULE_TEMPLATE: BuiltInTemplate = {
  key: 'rule',
  version: 1,
  icon: '📏',
  text: {
    en: {
      name: 'Business rule',
      description: 'One invariant, with a stable id and Given/When/Then examples.',
      source: `---
tags: [rule]
relations:
  - type: DESCRIBES
    target: "{{entity}}"
template:
  category: reference
  placeholders:
    - { name: id, label: Rule id, kind: text, required: true, hint: "BR-ORDER-001" }
    - { name: entity, label: Entity it constrains, kind: entity, hint: "entity:order" }
  aiInstructions: >-
    One invariant per page. State it as a sentence that is always true, using
    the glossary's terms. Every example is Given/When/Then with concrete values.
    If you find a second rule, say so instead of adding it here.
---
# {{title}}

**Rule:** {{id}} · **Constrains:** {{entity}}

## Statement

The invariant, in one sentence that is always true.

## Rationale

Why the rule exists: the intent or regulation it serves.

## Examples

- **Given** …, **when** …, **then** …
- **Given** …, **when** …, **then** … (the case that breaks it)

## Exceptions

- None, or each exception with who may grant it.
`,
    },
    ru: {
      name: 'Бизнес-правило',
      description: 'Один инвариант со стабильным идентификатором и примерами «Дано/Когда/Тогда».',
      source: `---
tags: [rule]
relations:
  - type: DESCRIBES
    target: "{{entity}}"
template:
  category: reference
  placeholders:
    - { name: id, label: Идентификатор правила, kind: text, required: true, hint: "BR-ORDER-001" }
    - { name: entity, label: Сущность, которую оно ограничивает, kind: entity, hint: "entity:order" }
  aiInstructions: >-
    Один инвариант на страницу. Сформулируй его предложением, которое верно всегда,
    в терминах глоссария. Каждый пример — «Дано/Когда/Тогда» с конкретными значениями.
    Если нашлось второе правило, скажи об этом, а не добавляй его сюда.
---
# {{title}}

**Правило:** {{id}} · **Ограничивает:** {{entity}}

## Формулировка

Инвариант — одним предложением, которое верно всегда.

## Обоснование

Зачем нужно правило: какой замысел или норму оно обслуживает.

## Примеры

- **Дано** …, **когда** …, **тогда** …
- **Дано** …, **когда** …, **тогда** … (случай, который его нарушает)

## Исключения

- Нет, или каждое исключение и кто вправе его разрешить.
`,
    },
  },
};
