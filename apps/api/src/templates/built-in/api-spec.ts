import type { BuiltInTemplate } from './types.js';

// The request example keeps an undeclared `{{baseUrl}}` on purpose: only
// declared placeholders are substituted, so a page about an API can show the
// mustache-style variables its clients use without escaping each one.
export const API_SPEC_TEMPLATE: BuiltInTemplate = {
  key: 'api-spec',
  version: 1,
  icon: '🔌',
  text: {
    en: {
      name: 'API specification',
      description: 'One endpoint: request, response, errors and an example call.',
      source: `---
tags: [api]
relations:
  - type: DESCRIBES
    target: "{{service}}"
template:
  category: contract
  titlePattern: "{{method}} {{path}}"
  placeholders:
    - { name: method, label: HTTP method, kind: text, required: true, hint: "POST" }
    - { name: path, label: Path, kind: text, required: true, hint: "/v1/orders" }
    - { name: service, label: Service, kind: entity, hint: "service:orders" }
  aiInstructions: >-
    Describe fields as tables with type, required and meaning. Take field names
    only from sources; never invent a field. Keep the example request runnable.
---
# {{title}}

\`{{method}} {{path}}\` · **Service:** {{service}}

## Purpose

What this endpoint does and who calls it.

## Authentication

Required role or scope.

## Request

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| | | | |

## Response

| Field | Type | Description |
| --- | --- | --- |
| | | |

## Errors

| Status | When |
| --- | --- |
| 400 | |
| 404 | |

## Example

\`\`\`http
{{method}} {{baseUrl}}{{path}}
Content-Type: application/json
\`\`\`
`,
    },
    ru: {
      name: 'Спецификация API',
      description: 'Один эндпоинт: запрос, ответ, ошибки и пример вызова.',
      source: `---
tags: [api]
relations:
  - type: DESCRIBES
    target: "{{service}}"
template:
  category: contract
  titlePattern: "{{method}} {{path}}"
  placeholders:
    - { name: method, label: HTTP-метод, kind: text, required: true, hint: "POST" }
    - { name: path, label: Путь, kind: text, required: true, hint: "/v1/orders" }
    - { name: service, label: Сервис, kind: entity, hint: "service:orders" }
  aiInstructions: >-
    Описывай поля таблицами: тип, обязательность, смысл. Имена полей бери только из
    источников, ничего не придумывай. Пример запроса должен быть рабочим.
---
# {{title}}

\`{{method}} {{path}}\` · **Сервис:** {{service}}

## Назначение

Что делает этот эндпоинт и кто его вызывает.

## Аутентификация

Нужная роль или scope.

## Запрос

| Поле | Тип | Обязательное | Описание |
| --- | --- | --- | --- |
| | | | |

## Ответ

| Поле | Тип | Описание |
| --- | --- | --- |
| | | |

## Ошибки

| Статус | Когда |
| --- | --- |
| 400 | |
| 404 | |

## Пример

\`\`\`http
{{method}} {{baseUrl}}{{path}}
Content-Type: application/json
\`\`\`
`,
    },
  },
};
