import type { BuiltInTemplate } from './types.js';

export const INTENT_TEMPLATE: BuiltInTemplate = {
  key: 'intent',
  version: 1,
  icon: '🧭',
  text: {
    en: {
      name: 'Intent',
      description: 'Why the work exists: the problem, goals with measures, scope and constraints.',
      source: `---
tags: [intent]
template:
  category: reference
  placeholders:
    - { name: owner, label: Owner, kind: text }
  aiInstructions: >-
    Give every goal a measure and a target value; a goal nobody can measure is
    a wish. Keep solutions out: this page says what must be true, not how.
---
# {{title}}

**Owner:** {{owner}} · **Written:** {{date}}

## Problem

Who has the problem, what it costs them today, and how we know.

## Goals

| Goal | Measure | Target |
| --- | --- | --- |
| | | |

## Scope

- **In:** what this work covers.
- **Out:** what it deliberately leaves alone.

## Constraints

- Limits the solution must respect: budget, deadline, regulation, platforms.

## Open questions

- What is still unknown, and who will find out.
`,
    },
    ru: {
      name: 'Замысел',
      description: 'Зачем нужна работа: проблема, измеримые цели, границы и ограничения.',
      source: `---
tags: [intent]
template:
  category: reference
  placeholders:
    - { name: owner, label: Ответственный, kind: text }
  aiInstructions: >-
    У каждой цели должна быть метрика и целевое значение: цель, которую нельзя
    измерить, — пожелание. Без решений: страница говорит, что должно быть верно, а не как.
---
# {{title}}

**Ответственный:** {{owner}} · **Написано:** {{date}}

## Проблема

У кого проблема, чего она стоит им сегодня и откуда мы это знаем.

## Цели

| Цель | Метрика | Целевое значение |
| --- | --- | --- |
| | | |

## Границы

- **Входит:** что охватывает эта работа.
- **Не входит:** что она сознательно не трогает.

## Ограничения

- Рамки, которые решение обязано соблюдать: бюджет, сроки, регулирование, платформы.

## Открытые вопросы

- Что ещё неизвестно и кто это выяснит.
`,
    },
  },
};
