import type { BuiltInTemplate } from './types.js';

export const WORK_UNIT_TEMPLATE: BuiltInTemplate = {
  key: 'work-unit',
  version: 1,
  icon: '🧱',
  text: {
    en: {
      name: 'Unit of work',
      description: 'One buildable piece: objective, invariants, contracts, acceptance checks and what is out.',
      source: `---
tags: [work-unit]
template:
  category: process
  placeholders:
    - { name: owner, label: Owner, kind: text }
  aiInstructions: >-
    Small enough for one person or agent to finish in one go. Link every rule
    and contract by page; never restate them. Each acceptance check is a
    command, a test or an observable result someone can run.
---
# {{title}}

**Owner:** {{owner}}

## Objective

What exists when this unit is done, in one or two sentences.

## Invariants

- **Reads:** rules this unit must respect (link each rule page).
- **Writes:** rules this unit makes true (link each rule page).

## Contracts

- Interfaces it implements or calls (link each contract page).

## Acceptance checks

- [ ] A check someone can run, and the result that passes.

## Obligations

- What it leaves for later units: migrations, flags to remove, docs to update.

## Out of scope

- What looks related but belongs to another unit.
`,
    },
    ru: {
      name: 'Единица работы',
      description: 'Одна собираемая часть: цель, инварианты, контракты, проверки приёмки и что в неё не входит.',
      source: `---
tags: [work-unit]
template:
  category: process
  placeholders:
    - { name: owner, label: Ответственный, kind: text }
  aiInstructions: >-
    Достаточно мала, чтобы один человек или агент закончил её за один заход.
    Правила и контракты — ссылками на страницы, не пересказом. Каждая проверка
    приёмки — команда, тест или наблюдаемый результат, который можно запустить.
---
# {{title}}

**Ответственный:** {{owner}}

## Цель

Что существует, когда единица готова, — одним-двумя предложениями.

## Инварианты

- **Читает:** правила, которые единица обязана соблюдать (ссылка на каждое).
- **Пишет:** правила, которые единица делает верными (ссылка на каждое).

## Контракты

- Интерфейсы, которые она реализует или вызывает (ссылка на каждый).

## Проверки приёмки

- [ ] Проверка, которую можно запустить, и результат, при котором она пройдена.

## Обязательства

- Что остаётся следующим единицам: миграции, флаги на удаление, документы на обновление.

## Вне рамок

- Что кажется связанным, но относится к другой единице.
`,
    },
  },
};
