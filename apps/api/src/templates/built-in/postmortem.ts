import type { BuiltInTemplate } from './types.js';

export const POSTMORTEM_TEMPLATE: BuiltInTemplate = {
  key: 'postmortem',
  version: 1,
  icon: '🔥',
  text: {
    en: {
      name: 'Postmortem',
      description: 'A blameless review of an incident: impact, timeline, causes and actions.',
      source: `---
tags: [postmortem, incident]
relations:
  - type: DESCRIBES
    target: "{{service}}"
template:
  category: process
  titlePattern: "Postmortem: {{title}}"
  placeholders:
    - { name: incidentDate, label: Incident date, kind: date, required: true }
    - { name: service, label: Affected service, kind: entity, hint: "service:checkout" }
    - { name: severity, label: Severity, kind: text, hint: "SEV-2" }
  aiInstructions: >-
    Keep it blameless: describe systems and decisions, not people. Build the timeline
    only from timestamps in the sources; leave TODO: where a time is unknown.
---
# {{title}}

**Incident date:** {{incidentDate}} · **Severity:** {{severity}} · **Author:** {{author}} · **Written:** {{date}}

## Summary

Two or three sentences: what broke, for how long, and for whom.

## Impact

Users, requests, revenue or data affected, with numbers where you have them.

## Timeline

| Time (UTC) | Event |
| --- | --- |
| | Detected |
| | Mitigated |
| | Resolved |

## Root cause

What failed and why the safeguards did not catch it.

## What went well

## What went poorly

## Action items

| Action | Owner | Due |
| --- | --- | --- |
| | | |
`,
    },
    ru: {
      name: 'Разбор инцидента',
      description: 'Разбор инцидента без поиска виноватых: влияние, хронология, причины и действия.',
      source: `---
tags: [postmortem, incident]
relations:
  - type: DESCRIBES
    target: "{{service}}"
template:
  category: process
  titlePattern: "Разбор инцидента: {{title}}"
  placeholders:
    - { name: incidentDate, label: Дата инцидента, kind: date, required: true }
    - { name: service, label: Затронутый сервис, kind: entity, hint: "service:checkout" }
    - { name: severity, label: Критичность, kind: text, hint: "SEV-2" }
  aiInstructions: >-
    Без поиска виноватых: описывай системы и решения, а не людей. Хронологию строй
    только по отметкам времени из источников; где время неизвестно, пиши TODO:.
---
# {{title}}

**Дата инцидента:** {{incidentDate}} · **Критичность:** {{severity}} · **Автор:** {{author}} · **Написано:** {{date}}

## Кратко

Два-три предложения: что сломалось, на сколько и для кого.

## Влияние

Затронутые пользователи, запросы, выручка или данные — с цифрами, если они есть.

## Хронология

| Время (UTC) | Событие |
| --- | --- |
| | Обнаружено |
| | Смягчено |
| | Устранено |

## Корневая причина

Что отказало и почему защитные механизмы этого не поймали.

## Что прошло хорошо

## Что прошло плохо

## Действия

| Действие | Ответственный | Срок |
| --- | --- | --- |
| | | |
`,
    },
  },
};
