import type { BuiltInTemplate } from './types.js';

export const QUALITY_SCENARIO_TEMPLATE: BuiltInTemplate = {
  key: 'quality-scenario',
  version: 1,
  icon: '⏱️',
  text: {
    en: {
      name: 'Quality scenario',
      description: 'One quality requirement: stimulus, response, measure and threshold.',
      source: `---
tags: [quality]
template:
  category: architecture
  placeholders:
    - { name: attribute, label: Quality attribute, kind: text, required: true, hint: "Performance" }
  aiInstructions: >-
    Every value is measurable: a number with a unit and the condition it holds
    under. "Fast" or "secure" is not a threshold.
---
# {{title}}

**Attribute:** {{attribute}}

## Stimulus

What happens, from which source, and how often.

## Environment

The conditions it happens under: normal load, peak, a failed dependency.

## Response

What the system does in return.

## Measure

| Measure | Threshold |
| --- | --- |
| | |

## How it is checked

The test, monitor or review that shows the threshold holds.
`,
    },
    ru: {
      name: 'Сценарий качества',
      description: 'Одно требование к качеству: стимул, реакция, метрика и порог.',
      source: `---
tags: [quality]
template:
  category: architecture
  placeholders:
    - { name: attribute, label: Атрибут качества, kind: text, required: true, hint: "Производительность" }
  aiInstructions: >-
    Каждое значение измеримо: число с единицей и условие, при котором оно выполняется.
    «Быстро» или «безопасно» — не порог.
---
# {{title}}

**Атрибут:** {{attribute}}

## Стимул

Что происходит, из какого источника и как часто.

## Окружение

При каких условиях: обычная нагрузка, пик, отказ зависимости.

## Реакция

Что система делает в ответ.

## Метрика

| Метрика | Порог |
| --- | --- |
| | |

## Как проверяется

Тест, мониторинг или ревью, которые показывают, что порог соблюдается.
`,
    },
  },
};
