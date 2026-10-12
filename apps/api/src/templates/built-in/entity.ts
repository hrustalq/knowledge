import type { BuiltInTemplate } from './types.js';

export const ENTITY_TEMPLATE: BuiltInTemplate = {
  key: 'entity',
  version: 1,
  icon: '🧩',
  text: {
    en: {
      name: 'Domain entity',
      description: 'One domain entity: its attributes, states, relations and invariants.',
      source: `---
tags: [entity]
relations:
  - type: DESCRIBES
    target: "{{key}}"
template:
  category: erd
  placeholders:
    - { name: key, label: Entity key, kind: entity, required: true, hint: "entity:order" }
    - { name: owner, label: Owning service, kind: text }
  aiInstructions: >-
    List attributes in the table with their types as stored. Describe the state
    machine only if the sources show one; otherwise remove the States section.
---
# {{title}}

**Key:** {{key}} · **Owned by:** {{owner}}

## Definition

What this entity is in the business, in one or two sentences.

## Attributes

| Attribute | Type | Required | Description |
| --- | --- | --- | --- |
| id | uuid | yes | |

## States

\`\`\`mermaid
stateDiagram-v2
  [*] --> Created
\`\`\`

## Relations

- Belongs to …
- Has many …

## Invariants

- Rules that are always true for every instance.
`,
    },
    ru: {
      name: 'Доменная сущность',
      description: 'Одна доменная сущность: атрибуты, состояния, связи и инварианты.',
      source: `---
tags: [entity]
relations:
  - type: DESCRIBES
    target: "{{key}}"
template:
  category: erd
  placeholders:
    - { name: key, label: Ключ сущности, kind: entity, required: true, hint: "entity:order" }
    - { name: owner, label: Сервис-владелец, kind: text }
  aiInstructions: >-
    Перечисли атрибуты в таблице с типами так, как они хранятся. Машину состояний
    описывай, только если она есть в источниках; иначе удали раздел «Состояния».
---
# {{title}}

**Ключ:** {{key}} · **Владелец:** {{owner}}

## Определение

Что это за сущность в бизнесе, одним-двумя предложениями.

## Атрибуты

| Атрибут | Тип | Обязательный | Описание |
| --- | --- | --- | --- |
| id | uuid | да | |

## Состояния

\`\`\`mermaid
stateDiagram-v2
  [*] --> Created
\`\`\`

## Связи

- Принадлежит …
- Содержит много …

## Инварианты

- Правила, верные для каждого экземпляра.
`,
    },
  },
};
