import type { BuiltInTemplate } from './types.js';

export const USE_CASE_TEMPLATE: BuiltInTemplate = {
  key: 'use-case',
  version: 1,
  icon: '🎯',
  text: {
    en: {
      name: 'Use case',
      description: 'One goal of one actor: preconditions, main flow, alternatives and outcome.',
      source: `---
tags: [use-case]
relations:
  - type: DESCRIBES
    target: "{{entity}}"
template:
  category: use-case
  placeholders:
    - { name: actor, label: Primary actor, kind: text, required: true, hint: "Customer" }
    - { name: entity, label: Main entity, kind: entity, hint: "entity:order" }
  aiInstructions: >-
    Write the main flow as numbered actor/system steps. Put every branch in
    Alternative flows with the step number it leaves from.
---
# {{title}}

**Primary actor:** {{actor}} · **Entity:** {{entity}}

## Goal

What {{actor}} wants to achieve, in one sentence.

## Preconditions

- What must be true before the flow starts.

## Main flow

1. {{actor}} …
2. The system …

## Alternative flows

- **2a.** If …, then …

## Postconditions

What is true when the flow succeeds.

## Business rules

- Rules and limits the flow must respect.
`,
    },
    ru: {
      name: 'Сценарий использования',
      description: 'Одна цель одного актора: предусловия, основной поток, альтернативы и результат.',
      source: `---
tags: [use-case]
relations:
  - type: DESCRIBES
    target: "{{entity}}"
template:
  category: use-case
  placeholders:
    - { name: actor, label: Основной актор, kind: text, required: true, hint: "Покупатель" }
    - { name: entity, label: Основная сущность, kind: entity, hint: "entity:order" }
  aiInstructions: >-
    Основной поток — пронумерованные шаги актора и системы. Каждое ветвление вынеси
    в «Альтернативные потоки» с номером шага, от которого оно отходит.
---
# {{title}}

**Основной актор:** {{actor}} · **Сущность:** {{entity}}

## Цель

Чего хочет добиться {{actor}}, одним предложением.

## Предусловия

- Что должно быть верно до начала сценария.

## Основной поток

1. {{actor}} …
2. Система …

## Альтернативные потоки

- **2a.** Если …, то …

## Постусловия

Что верно после успешного завершения.

## Бизнес-правила

- Правила и ограничения, которые сценарий должен соблюдать.
`,
    },
  },
};
