import type { BuiltInTemplate } from './types.js';

export const RUNBOOK_TEMPLATE: BuiltInTemplate = {
  key: 'runbook',
  version: 1,
  icon: '🛠️',
  text: {
    en: {
      name: 'Runbook',
      description: 'Step-by-step operating procedure for one service or alert.',
      source: `---
tags: [runbook]
relations:
  - type: DESCRIBES
    target: "{{service}}"
template:
  category: guide
  titlePattern: "Runbook: {{title}}"
  placeholders:
    - { name: service, label: Service, kind: entity, required: true, hint: "service:payments" }
    - { name: owner, label: Owning team, kind: text }
    - { name: alert, label: Alert or trigger, kind: text }
  aiInstructions: >-
    Write numbered, copy-pasteable steps. Every command goes in a code block. Mark
    any step you could not confirm from a source with TODO: rather than guessing.
---
# {{title}}

**Service:** {{service}} · **Owner:** {{owner}} · **Last reviewed:** {{date}}

## When to use this

The alert, symptom or request that brings someone here: {{alert}}.

## Before you start

- Access you need (dashboards, consoles, credentials vault entry).
- Who to tell before acting.

## Diagnosis

1. Check …
2. Confirm …

## Resolution

1. Do …
2. Verify …

## Rollback

How to undo the steps above if they make things worse.

## Escalation

Who to call, and when.
`,
    },
    ru: {
      name: 'Ранбук',
      description: 'Пошаговая инструкция по эксплуатации одного сервиса или алерта.',
      source: `---
tags: [runbook]
relations:
  - type: DESCRIBES
    target: "{{service}}"
template:
  category: guide
  titlePattern: "Ранбук: {{title}}"
  placeholders:
    - { name: service, label: Сервис, kind: entity, required: true, hint: "service:payments" }
    - { name: owner, label: Команда-владелец, kind: text }
    - { name: alert, label: Алерт или триггер, kind: text }
  aiInstructions: >-
    Пиши пронумерованные шаги, которые можно скопировать и выполнить. Каждая команда —
    в блоке кода. Шаг, который не подтверждён источником, помечай TODO:, а не угадывай.
---
# {{title}}

**Сервис:** {{service}} · **Владелец:** {{owner}} · **Проверено:** {{date}}

## Когда использовать

Алерт, симптом или запрос, с которым сюда приходят: {{alert}}.

## Перед началом

- Какие нужны доступы (дашборды, консоли, запись в хранилище секретов).
- Кого предупредить перед действиями.

## Диагностика

1. Проверьте …
2. Убедитесь …

## Устранение

1. Выполните …
2. Проверьте …

## Откат

Как отменить шаги выше, если стало хуже.

## Эскалация

Кому звонить и когда.
`,
    },
  },
};
