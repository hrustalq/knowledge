import type { Blueprint } from '@knowledge/contracts';
import { page } from './page.js';

const RESEARCH = { template: 'builtin:research-question' } as const;

/** Discovery-first (#716): numbered research chapters with a decision summary on top. */
export const DISCOVERY_BLUEPRINT: Blueprint = {
  name: { en: 'Discovery-first', ru: 'Сначала исследование' },
  description: {
    en: 'For a product still being shaped: numbered chapters of research questions, each answered by options and findings, summed up in one decision page.',
    ru: 'Для продукта, который ещё формируется: пронумерованные главы исследовательских вопросов с вариантами и результатами и одна страница сводных решений.',
  },
  icon: '🔭',
  tree: [
    page('00 — Decision summary', '00 — Сводные решения', {
      category: 'reference',
      guidance: [
        'One line per decision taken in the chapters below, with a link to the question that settled it.',
        'По строке на каждое решение из глав ниже — со ссылкой на вопрос, который его определил.',
      ],
    }),
    page('01 — Goals and MVP scope', '01 — Цели и границы MVP', {
      collection: RESEARCH,
      guidance: ['What the product must achieve first, and what is deliberately left out.', 'Чего продукт должен достичь в первую очередь и что сознательно остаётся за рамками.'],
    }),
    page('02 — Architecture', '02 — Архитектура', {
      category: 'architecture',
      collection: RESEARCH,
      guidance: ['Open technical questions: one page each, options weighed against criteria.', 'Открытые технические вопросы: по странице на вопрос, варианты против критериев.'],
    }),
    page('03 — Risks and threat model', '03 — Риски и модель угроз', {
      collection: RESEARCH,
      guidance: ['What could go wrong, who could attack it, and what each risk costs to reduce.', 'Что может пойти не так, кто может атаковать и сколько стоит снизить каждый риск.'],
    }),
    page('04 — Economics', '04 — Экономика', {
      collection: RESEARCH,
      guidance: ['Costs, pricing and the numbers the product has to hit.', 'Затраты, ценообразование и цифры, которых продукт должен достичь.'],
    }),
    page('05 — Pilot', '05 — Пилот', {
      guidance: ['How the decisions above are tried with real users before committing.', 'Как решения выше проверяются на реальных пользователях до окончательного выбора.'],
      children: [
        page('Pilot design', 'Дизайн пилота', { guidance: ['Who takes part, for how long, and what they get.', 'Кто участвует, как долго и что получает.'] }),
        page('Test scenarios', 'Тестовые сценарии', { category: 'use-case', guidance: ['The scenarios each participant goes through.', 'Сценарии, которые проходит каждый участник.'] }),
        page('Metrics', 'Метрики', { guidance: ['What is measured, and the value that counts as success.', 'Что измеряем и какое значение считаем успехом.'] }),
      ],
    }),
  ],
};
