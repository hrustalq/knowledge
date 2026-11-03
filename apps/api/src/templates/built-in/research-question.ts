import type { BuiltInTemplate } from './types.js';

export const RESEARCH_QUESTION_TEMPLATE: BuiltInTemplate = {
  key: 'research-question',
  version: 1,
  icon: '🔎',
  text: {
    en: {
      name: 'Research question',
      description: 'One open question: the options, how to judge them, what was found and what was decided.',
      source: `---
tags: [research]
template:
  category: reference
  placeholders:
    - { name: owner, label: Owner, kind: text }
  aiInstructions: >-
    State the question in one sentence. List each option with what it would take.
    Keep Findings to what a source or an experiment showed, and cite it. Leave
    Decision empty until the findings settle it.
---
# {{title}}

**Owner:** {{owner}} · **Opened:** {{date}}

## Question

The one question this page answers, and why it has to be answered now.

## Options

- **Option A**: what it is and what it would take.
- **Option B**: what it is and what it would take.

## Criteria

How the options are judged, most important first: cost, risk, time, fit.

## Findings

What audits, experiments and sources showed, option by option. Link each source.

## Decision

The option chosen and the reason, once the findings settle it.

## Open questions

- What is still unknown, and who will find out.
`,
    },
    ru: {
      name: 'Исследовательский вопрос',
      description: 'Один открытый вопрос: варианты, критерии, что выяснили и что решили.',
      source: `---
tags: [research]
template:
  category: reference
  placeholders:
    - { name: owner, label: Ответственный, kind: text }
  aiInstructions: >-
    Сформулируй вопрос одним предложением. Для каждого варианта укажи, чего он потребует.
    В «Результатах» — только то, что показал источник или эксперимент, со ссылкой.
    «Решение» оставь пустым, пока результаты его не определят.
---
# {{title}}

**Ответственный:** {{owner}} · **Открыт:** {{date}}

## Вопрос

Один вопрос, на который отвечает эта страница, и почему ответить нужно сейчас.

## Варианты

- **Вариант А**: что это и чего он потребует.
- **Вариант Б**: что это и чего он потребует.

## Критерии

По каким критериям сравниваем варианты, начиная с главного: стоимость, риск, сроки, соответствие.

## Результаты

Что показали аудиты, эксперименты и источники — по каждому варианту. Ссылайтесь на источник.

## Решение

Выбранный вариант и причина — когда результаты это определят.

## Открытые вопросы

- Что ещё неизвестно и кто это выяснит.
`,
    },
  },
};
