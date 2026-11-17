import type { Blueprint } from '@knowledge/contracts';
import { page } from './page.js';

const RESEARCH = { template: 'builtin:research-question' } as const;

const level = (key: string, name: [en: string, ru: string], templateRefs: string[], guidance: [en: string, ru: string]) => ({
  key,
  name: { en: name[0], ru: name[1] },
  templateRefs,
  agentKey: 'investigator',
  guidance: { en: guidance[0], ru: guidance[1] },
});

/**
 * Discovery-first (#716): numbered research chapters with a decision summary on
 * top. Its levels (#1129) are the steps one question goes through; only the
 * question has a template, so research-question pages sit at it and the other
 * three are where a chat about them works.
 */
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
  levels: [
    level('question', ['Question', 'Вопрос'], ['builtin:research-question'], [
      'This level frames one question: what must be decided, why now, and the criteria an answer is judged by. It is complete when the question fits one sentence and the criteria are ranked.',
      'Этот уровень формулирует один вопрос: что нужно решить, почему сейчас и по каким критериям судить ответ. Он готов, когда вопрос умещается в одно предложение, а критерии упорядочены.',
    ]),
    level('options', ['Options', 'Варианты'], [], [
      'This level lists the options: each one, what it would take, and how it scores against the criteria. It is complete when no serious option is missing and none has been chosen yet.',
      'Этот уровень перечисляет варианты: каждый, чего он потребует и как соотносится с критериями. Он готов, когда не упущен ни один серьёзный вариант и ни один ещё не выбран.',
    ]),
    level('findings', ['Findings', 'Результаты'], [], [
      'This level records what sources, audits and experiments showed, option by option, each with its source. Separate what was shown from what is believed.',
      'Этот уровень фиксирует, что показали источники, аудиты и эксперименты, — по каждому варианту и со ссылкой на источник. Отделяй показанное от предполагаемого.',
    ]),
    level('decision', ['Decision', 'Решение'], [], [
      'This level settles the question: the option chosen, the findings that decided it, and what would make us revisit it. A decision also gets its line on the decision summary page.',
      'Этот уровень закрывает вопрос: выбранный вариант, результаты, которые его определили, и что заставит пересмотреть решение. Решение также получает строку на странице сводных решений.',
    ]),
  ],
  agents: [
    {
      key: 'investigator',
      name: 'Discovery researcher',
      description: 'Frames questions, weighs options and keeps findings separate from beliefs.',
      instructions:
        'You help a team that is still searching for a solution, one research question at a time: question, then options, then findings, then decision. ' +
        'Keep each step separate. Never pick an option before the findings support it, cite a source for every finding, ' +
        'and say plainly what is still unknown. Answer in the language you are asked in.',
      tools: ['search_knowledge', 'read_document', 'explore_document_graph', 'list_relations', 'list_document_tree', 'list_templates', 'get_template', 'ask_user', 'request_agent_mode', 'edit_draft'],
      minTier: 'medium',
    },
  ],
};
