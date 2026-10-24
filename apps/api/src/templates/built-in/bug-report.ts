import type { BuiltInTemplate } from './types.js';

export const BUG_REPORT_TEMPLATE: BuiltInTemplate = {
  key: 'bug-report',
  version: 1,
  icon: '🐞',
  text: {
    en: {
      name: 'Bug report',
      description: 'A defect: environment, steps to reproduce, expected vs actual, severity.',
      source: `---
tags: [qa, bug]
relations:
  - type: RELATED_TO
    target: "{{operation}}"
template:
  category: other
  titlePattern: "Bug: {{title}}"
  placeholders:
    - { name: operation, label: Affected operation, kind: entity, required: true, hint: "op:billing-api:POST /invoices" }
    - { name: severity, label: Severity, kind: text, hint: "major" }
    - { name: environment, label: Environment, kind: text, hint: "staging, build 1.42" }
    - { name: foundBy, label: Found by suite case, kind: text, hint: "op:billing-api:post /invoices#missing-amount" }
  aiInstructions: >-
    Write steps to reproduce as numbered actions from a clean state, and keep expected
    and actual results separate and checkable. Mark anything you could not confirm
    with TODO:. Never write credentials, tokens or secret values into the page, and
    redact them from pasted requests and logs.
---
# {{title}}

**Operation:** {{operation}} · **Severity:** {{severity}} · **Environment:** {{environment}} · **Found by:** {{foundBy}} · **Reported:** {{date}}

## Summary

One sentence: what goes wrong, and for whom.

## Steps to reproduce

1. …
2. …

## Expected result

…

## Actual result

…

## Evidence

Request and response, logs or screenshots, with secrets redacted.

## Notes

Frequency, workaround, and the first build it appeared in.
`,
    },
    ru: {
      name: 'Баг-репорт',
      description: 'Дефект: окружение, шаги воспроизведения, ожидаемое и фактическое, серьёзность.',
      source: `---
tags: [qa, bug]
relations:
  - type: RELATED_TO
    target: "{{operation}}"
template:
  category: other
  titlePattern: "Баг: {{title}}"
  placeholders:
    - { name: operation, label: Затронутая операция, kind: entity, required: true, hint: "op:billing-api:POST /invoices" }
    - { name: severity, label: Серьёзность, kind: text, hint: "major" }
    - { name: environment, label: Окружение, kind: text, hint: "staging, сборка 1.42" }
    - { name: foundBy, label: Найден кейсом набора, kind: text, hint: "op:billing-api:post /invoices#missing-amount" }
  aiInstructions: >-
    Шаги воспроизведения пиши пронумерованными действиями с чистого состояния;
    ожидаемый и фактический результаты — раздельно и проверяемо. Всё неподтверждённое
    помечай TODO:. Никогда не пиши в страницу учётные данные, токены или значения
    секретов и вычищай их из вставленных запросов и логов.
---
# {{title}}

**Операция:** {{operation}} · **Серьёзность:** {{severity}} · **Окружение:** {{environment}} · **Найден:** {{foundBy}} · **Создан:** {{date}}

## Кратко

Одно предложение: что идёт не так и для кого.

## Шаги воспроизведения

1. …
2. …

## Ожидаемый результат

…

## Фактический результат

…

## Доказательства

Запрос и ответ, логи или скриншоты — без секретов.

## Примечания

Частота, обходной путь и первая сборка, где проявилось.
`,
    },
  },
};
