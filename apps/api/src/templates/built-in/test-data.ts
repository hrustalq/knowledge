import type { BuiltInTemplate } from './types.js';

// The prose companion to a `test-fixture` document (#483). Not called "fixture"
// on purpose, so the template and the document kind cannot be confused.
export const TEST_DATA_TEMPLATE: BuiltInTemplate = {
  key: 'test-data',
  version: 1,
  icon: '🧪',
  text: {
    en: {
      name: 'Test data',
      description: 'The data a test needs, how to create it and how to clean it up.',
      source: `---
tags: [qa, test-data]
relations:
  - type: DESCRIBES
    target: "{{operation}}"
template:
  category: reference
  titlePattern: "Test data: {{title}}"
  placeholders:
    - { name: operation, label: Operation that needs it, kind: entity, hint: "op:billing-api:POST /invoices" }
    - { name: environment, label: Environment, kind: text, hint: "staging" }
  aiInstructions: >-
    Write creation and cleanup as numbered steps; every command or request goes in a
    code block. Mark anything you could not confirm from a source with TODO:. Never
    write credentials, tokens or secret values into the page — name the vault entry
    instead.
---
# {{title}}

**Operation:** {{operation}} · **Environment:** {{environment}} · **Written:** {{date}}

## What it is for

The tests that rely on this data, and the state they expect.

## Records

| Record | Key fields | Notes |
| --- | --- | --- |
| … | … | … |

## How to create it

1. …

## How to clean it up

1. …

## Access

The role a tester needs, and the vault entry that holds any credential.
`,
    },
    ru: {
      name: 'Тестовые данные',
      description: 'Какие данные нужны тесту, как их создать и как убрать.',
      source: `---
tags: [qa, test-data]
relations:
  - type: DESCRIBES
    target: "{{operation}}"
template:
  category: reference
  titlePattern: "Тестовые данные: {{title}}"
  placeholders:
    - { name: operation, label: "Операция, которой они нужны", kind: entity, hint: "op:billing-api:POST /invoices" }
    - { name: environment, label: Окружение, kind: text, hint: "staging" }
  aiInstructions: >-
    Создание и очистку пиши пронумерованными шагами; каждая команда или запрос — в
    блоке кода. Всё, что не подтверждено источником, помечай TODO:. Никогда не пиши в
    страницу учётные данные, токены или значения секретов — указывай запись в
    хранилище секретов.
---
# {{title}}

**Операция:** {{operation}} · **Окружение:** {{environment}} · **Написано:** {{date}}

## Для чего

Какие тесты опираются на эти данные и какое состояние они ожидают.

## Записи

| Запись | Ключевые поля | Примечания |
| --- | --- | --- |
| … | … | … |

## Как создать

1. …

## Как убрать

1. …

## Доступ

Какая роль нужна тестировщику и в какой записи хранилища секретов лежат учётные данные.
`,
    },
  },
};
