import type { BuiltInTemplate } from './types.js';

export const TEST_PLAN_TEMPLATE: BuiltInTemplate = {
  key: 'test-plan',
  version: 1,
  icon: '🧭',
  text: {
    en: {
      name: 'Test plan',
      description: 'What is tested, how, where, and when it counts as done.',
      source: `---
tags: [qa, test-plan]
relations:
  - type: DESCRIBES
    target: "{{operation}}"
template:
  category: process
  titlePattern: "Test plan: {{title}}"
  placeholders:
    - { name: operation, label: Main operation under test, kind: entity, hint: "op:billing-api:POST /invoices" }
    - { name: release, label: Release or milestone, kind: text, hint: "v2.4" }
    - { name: owner, label: QA owner, kind: text }
  aiInstructions: >-
    Write entry and exit criteria as numbered, checkable statements. Name suites and
    operations only from sources; mark anything you could not confirm with TODO:.
    Never write credentials, tokens or secret values into the page — name the vault
    entry instead.
---
# {{title}}

**Operation:** {{operation}} · **Release:** {{release}} · **QA owner:** {{owner}} · **Written:** {{date}}

## Scope

What this plan covers, and what it explicitly does not.

## Approach

Generated suites, manual test cases, exploratory sessions — and why each.

## Coverage

| Operation or flow | Suite or test case | Kind |
| --- | --- | --- |
| {{operation}} | … | generated / manual |

## Environments

Where the tests run, and the test data each one needs.

## Entry criteria

1. …

## Exit criteria

1. …

## Risks

What could make this plan miss a defect, and how it is mitigated.
`,
    },
    ru: {
      name: 'План тестирования',
      description: 'Что тестируется, как, где и когда тестирование считается завершённым.',
      source: `---
tags: [qa, test-plan]
relations:
  - type: DESCRIBES
    target: "{{operation}}"
template:
  category: process
  titlePattern: "План тестирования: {{title}}"
  placeholders:
    - { name: operation, label: Основная проверяемая операция, kind: entity, hint: "op:billing-api:POST /invoices" }
    - { name: release, label: Релиз или веха, kind: text, hint: "v2.4" }
    - { name: owner, label: Ответственный QA, kind: text }
  aiInstructions: >-
    Критерии начала и завершения пиши пронумерованными проверяемыми утверждениями.
    Наборы тестов и операции называй только по источникам; всё неподтверждённое
    помечай TODO:. Никогда не пиши в страницу учётные данные, токены или значения
    секретов — указывай запись в хранилище секретов.
---
# {{title}}

**Операция:** {{operation}} · **Релиз:** {{release}} · **QA:** {{owner}} · **Написано:** {{date}}

## Охват

Что входит в план и что явно не входит.

## Подход

Сгенерированные наборы, ручные тест-кейсы, исследовательское тестирование — и зачем каждый.

## Покрытие

| Операция или сценарий | Набор или тест-кейс | Вид |
| --- | --- | --- |
| {{operation}} | … | сгенерированный / ручной |

## Окружения

Где запускаются тесты и какие тестовые данные нужны в каждом.

## Критерии начала

1. …

## Критерии завершения

1. …

## Риски

Из-за чего план может пропустить дефект и как это снижается.
`,
    },
  },
};
