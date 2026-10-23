import type { BuiltInTemplate } from './types.js';

// For flows no generated suite (#468) covers: a person runs these steps by hand.
export const TEST_CASE_TEMPLATE: BuiltInTemplate = {
  key: 'test-case',
  version: 1,
  icon: '✅',
  text: {
    en: {
      name: 'Test case',
      description: 'A manual test: preconditions, numbered steps and the expected result.',
      source: `---
tags: [qa, test-case]
relations:
  - type: DESCRIBES
    target: "{{operation}}"
template:
  category: guide
  titlePattern: "Test case: {{title}}"
  placeholders:
    - { name: operation, label: Operation exercised, kind: entity, required: true, hint: "op:billing-api:POST /invoices" }
    - { name: priority, label: Priority, kind: text, hint: "P1" }
  aiInstructions: >-
    Write numbered steps a tester can follow without asking, one action per step, and
    an expected result that can be checked as pass or fail. Mark anything you could
    not confirm from a source with TODO:. Never write credentials, tokens or secret
    values into the page — name the vault entry instead.
---
# {{title}}

**Operation:** {{operation}} · **Priority:** {{priority}} · **Author:** {{author}} · **Written:** {{date}}

## Purpose

The behaviour this case proves, and why no generated suite covers it.

## Preconditions

- Environment and role the tester needs.
- Test data that must exist first.

## Steps

1. …
2. …

## Expected result

What the tester sees when the case passes.

## Notes

Variations worth trying, and known flakiness.
`,
    },
    ru: {
      name: 'Тест-кейс',
      description: 'Ручная проверка: предусловия, пронумерованные шаги и ожидаемый результат.',
      source: `---
tags: [qa, test-case]
relations:
  - type: DESCRIBES
    target: "{{operation}}"
template:
  category: guide
  titlePattern: "Тест-кейс: {{title}}"
  placeholders:
    - { name: operation, label: Проверяемая операция, kind: entity, required: true, hint: "op:billing-api:POST /invoices" }
    - { name: priority, label: Приоритет, kind: text, hint: "P1" }
  aiInstructions: >-
    Пиши пронумерованные шаги, которые тестировщик выполнит без вопросов, по одному
    действию на шаг, и ожидаемый результат, который проверяется как «прошёл / не
    прошёл». Всё, что не подтверждено источником, помечай TODO:. Никогда не пиши в
    страницу учётные данные, токены или значения секретов — указывай запись в
    хранилище секретов.
---
# {{title}}

**Операция:** {{operation}} · **Приоритет:** {{priority}} · **Автор:** {{author}} · **Написано:** {{date}}

## Назначение

Какое поведение проверяет кейс и почему его не покрывает сгенерированный набор.

## Предусловия

- Окружение и роль, нужные тестировщику.
- Тестовые данные, которые должны существовать заранее.

## Шаги

1. …
2. …

## Ожидаемый результат

Что видит тестировщик, когда кейс пройден.

## Примечания

Варианты, которые стоит попробовать, и известная нестабильность.
`,
    },
  },
};
