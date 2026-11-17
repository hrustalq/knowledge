import type { Blueprint, BlueprintAgent, BlueprintLevel, TemplateRef } from '@knowledge/contracts';
import { page } from './page.js';

/**
 * Knowledge-Driven Construction (#1129): work from a settled plan, top-down
 * through eight levels, each refining the one above. A page's level is its
 * template's (`levelOf`), so the tree below is a starting shape, not the rule.
 */

/** What the methodology's agents may call: read, draft and ask. Writing stays with Agent mode's author. */
const TOOLS = [
  'search_knowledge',
  'read_document',
  'explore_document_graph',
  'list_relations',
  'list_document_tree',
  'list_templates',
  'get_template',
  'ask_user',
  'request_agent_mode',
  'edit_draft',
];

const RULES = (role: string, levels: string) =>
  `You are the ${role} of a team that builds from documentation, level by level: ` +
  'L0 Intent, L1 Ontology, L2 Rules, L3 Behavior, L4 Architecture, L5 Contracts, L6 Units, L7 Code. ' +
  `You work at ${levels}. Every page you help with refines a page at the level above it: find that page first and link it. ` +
  "Use the glossary's terms, never a synonym. When something belongs to another level, say which and stop there. " +
  'When the level above is missing or contradicts itself, ask rather than invent it. Answer in the language you are asked in.';

const AGENTS: BlueprintAgent[] = [
  {
    key: 'modeller',
    name: 'Modeller',
    description: 'Intent, ontology and rules: what must be true and in which words.',
    instructions:
      RULES('modeller', 'L0 to L2') +
      ' An intent page has measurable goals and no solution. An entity page names one concept once. ' +
      'A rule page states exactly one invariant with Given/When/Then examples; split anything that holds two.',
    tools: TOOLS,
    minTier: 'large',
  },
  {
    key: 'system-designer',
    name: 'System designer',
    description: 'Behavior and architecture: how the rules play out and what is built to keep them.',
    instructions:
      RULES('system designer', 'L3 and L4') +
      ' A use case is one goal of one actor and names the rules it exercises. A quality scenario has a measurable threshold. ' +
      'An architecture decision records the options it weighed and the scenario or rule that decided it.',
    tools: TOOLS,
    minTier: 'large',
  },
  {
    key: 'contract-writer',
    name: 'Contract writer',
    description: 'Contracts: the interfaces between components, exactly.',
    instructions:
      RULES('contract writer', 'L5') +
      ' A contract names every field, type and error, and the use case or component it serves. Never leave a type implied.',
    tools: TOOLS,
    minTier: 'medium',
  },
  {
    key: 'unit-writer',
    name: 'Unit writer',
    description: 'Units of work: one buildable piece each, with checks someone can run.',
    instructions:
      RULES('unit writer', 'L6') +
      ' A unit of work is small enough to finish in one go, links the rules it reads and writes and the contracts it touches, ' +
      'and ends in acceptance checks someone can run.',
    tools: TOOLS,
    minTier: 'small',
  },
];

const level = (
  key: string,
  name: [en: string, ru: string],
  templateRefs: TemplateRef[],
  agentKey: string | undefined,
  description: [en: string, ru: string],
  guidance: [en: string, ru: string],
): BlueprintLevel => ({
  key,
  name: { en: name[0], ru: name[1] },
  description: { en: description[0], ru: description[1] },
  templateRefs,
  ...(agentKey ? { agentKey } : {}),
  guidance: { en: guidance[0], ru: guidance[1] },
});

const LEVELS: BlueprintLevel[] = [
  level(
    'intent',
    ['L0 Intent', 'L0 Замысел'],
    ['builtin:intent'],
    'modeller',
    ['Why the work exists and how success is measured.', 'Зачем нужна работа и как измерить успех.'],
    [
      'This level answers why: the problem, who has it, and the measurable goals. It is complete when every goal has a measure and a target and the scope says what is out. Keep solutions out of it.',
      'Этот уровень отвечает «зачем»: проблема, у кого она и измеримые цели. Он готов, когда у каждой цели есть метрика и целевое значение, а границы говорят, что не входит. Решений здесь нет.',
    ],
  ),
  level(
    'ontology',
    ['L1 Ontology', 'L1 Онтология'],
    ['builtin:entity'],
    'modeller',
    ['The concepts of the domain, each named once.', 'Понятия предметной области, каждое названо один раз.'],
    [
      'This level answers what exists: the entities, their attributes, states and relations, and the glossary. It is complete when every noun the intent uses is an entity or a glossary term, and no concept has two names.',
      'Этот уровень отвечает «что существует»: сущности, их атрибуты, состояния и связи, а также глоссарий. Он готов, когда каждое существительное из замысла — сущность или термин глоссария и ни у одного понятия нет двух имён.',
    ],
  ),
  level(
    'rules',
    ['L2 Rules', 'L2 Правила'],
    ['builtin:rule'],
    'modeller',
    ['The invariants that always hold, one per page.', 'Инварианты, которые верны всегда, — по одному на страницу.'],
    [
      'This level answers what must always be true. One invariant per page, in glossary terms, with a stable id and Given/When/Then examples. It is complete when every entity state change is governed by a rule and no rule contradicts another.',
      'Этот уровень отвечает «что должно быть верно всегда». Один инвариант на страницу, в терминах глоссария, со стабильным идентификатором и примерами «Дано/Когда/Тогда». Он готов, когда каждое изменение состояния сущности подчинено правилу и правила не противоречат друг другу.',
    ],
  ),
  level(
    'behavior',
    ['L3 Behavior', 'L3 Поведение'],
    ['builtin:use-case', 'builtin:quality-scenario'],
    'system-designer',
    ['Use cases and the quality the system must show.', 'Сценарии использования и требуемое качество системы.'],
    [
      'This level answers what happens: use cases, each one goal of one actor naming the rules it exercises, and quality scenarios with measurable thresholds. It is complete when every rule is exercised by a use case and every intent goal has a scenario that measures it.',
      'Этот уровень отвечает «что происходит»: сценарии использования (одна цель одного актора, с правилами, которые он задействует) и сценарии качества с измеримыми порогами. Он готов, когда каждое правило задействовано сценарием, а каждая цель замысла измеряется сценарием качества.',
    ],
  ),
  level(
    'architecture',
    ['L4 Architecture', 'L4 Архитектура'],
    ['builtin:adr', 'builtin:component'],
    'system-designer',
    ['The components and the decisions behind them.', 'Компоненты и решения, на которых они держатся.'],
    [
      'This level answers how it is built: components and the decisions that shaped them. Each decision records the options weighed and the scenario or rule that decided it. It is complete when every use case is served by named components and every quality scenario by a decision.',
      'Этот уровень отвечает «как устроено»: компоненты и решения, которые их определили. Каждое решение фиксирует рассмотренные варианты и сценарий или правило, которое его определило. Он готов, когда каждый сценарий обслуживают названные компоненты, а каждый сценарий качества — решение.',
    ],
  ),
  level(
    'contracts',
    ['L5 Contracts', 'L5 Контракты'],
    ['builtin:api-spec'],
    'contract-writer',
    ['The exact interfaces between components.', 'Точные интерфейсы между компонентами.'],
    [
      'This level answers how components talk: every operation, field, type and error, exactly. It is complete when every interaction between components in a use case has a contract and no type is left implied.',
      'Этот уровень отвечает «как компоненты общаются»: каждая операция, поле, тип и ошибка — точно. Он готов, когда у каждого взаимодействия компонентов в сценарии есть контракт и ни один тип не подразумевается.',
    ],
  ),
  level(
    'units',
    ['L6 Units', 'L6 Единицы работы'],
    ['builtin:work-unit'],
    'unit-writer',
    ['Buildable pieces of work, each with its checks.', 'Собираемые части работы, у каждой свои проверки.'],
    [
      'This level answers what to build next: units small enough to finish in one go, each linking the rules it reads and writes and the contracts it touches, each ending in acceptance checks someone can run. It is complete when every contract and component is covered by units.',
      'Этот уровень отвечает «что строить дальше»: единицы, которые можно закончить за один заход, каждая со ссылками на правила, которые она читает и пишет, и на контракты, которые затрагивает, и с проверками приёмки, которые можно запустить. Он готов, когда все контракты и компоненты покрыты единицами.',
    ],
  ),
  level(
    'code',
    ['L7 Code', 'L7 Код'],
    [],
    undefined,
    ['The code itself, in the repository.', 'Сам код, в репозитории.'],
    [
      'This level is the code in the repository. Answer from the units of work and contracts above it, and point at the code rather than restating it.',
      'Этот уровень — код в репозитории. Отвечай по единицам работы и контрактам выше и указывай на код, а не пересказывай его.',
    ],
  ),
];

export const CONSTRUCTION_BLUEPRINT: Blueprint = {
  name: { en: 'Knowledge-Driven Construction', ru: 'Разработка от знаний' },
  description: {
    en: 'For building from a settled plan: eight levels from intent to code, each page refining one above it, with an agent per level group.',
    ru: 'Для разработки по устоявшемуся плану: восемь уровней от замысла до кода, каждая страница уточняет страницу уровнем выше, у каждой группы уровней свой агент.',
  },
  icon: '🏗️',
  tree: [
    page('L0 Intent', 'L0 Замысел', {
      collection: { template: 'builtin:intent' },
      guidance: ['Why the work exists: one intent page per initiative.', 'Зачем нужна работа: по странице замысла на инициативу.'],
    }),
    page('L1 Ontology', 'L1 Онтология', {
      category: 'erd',
      collection: { template: 'builtin:entity' },
      guidance: ['One page per domain entity; the words live in the glossary.', 'По странице на доменную сущность; слова — в глоссарии.'],
    }),
    page('L2 Rules', 'L2 Правила', {
      collection: { template: 'builtin:rule', pattern: 'BR-{{n:3}}: ' },
      guidance: ['One invariant per page, numbered.', 'Один инвариант на страницу, с номером.'],
    }),
    page('L3 Behavior', 'L3 Поведение', {
      category: 'use-case',
      guidance: ['Use cases and quality scenarios.', 'Сценарии использования и сценарии качества.'],
      children: [
        page('Use cases', 'Сценарии использования', { category: 'use-case', collection: { template: 'builtin:use-case' } }),
        page('Quality scenarios', 'Сценарии качества', { category: 'architecture', collection: { template: 'builtin:quality-scenario' } }),
      ],
    }),
    page('L4 Architecture', 'L4 Архитектура', {
      category: 'architecture',
      guidance: ['Components, and the decisions that shaped them.', 'Компоненты и решения, которые их определили.'],
      children: [
        page('Components', 'Компоненты', { category: 'architecture', collection: { template: 'builtin:component' } }),
        page('Decisions', 'Решения', { category: 'architecture', collection: { template: 'builtin:adr', pattern: 'ADR {{n:4}}: ' } }),
      ],
    }),
    page('L5 Contracts', 'L5 Контракты', {
      category: 'contract',
      collection: { template: 'builtin:api-spec' },
      guidance: ['One page per interface between components.', 'По странице на интерфейс между компонентами.'],
    }),
    page('L6 Units', 'L6 Единицы работы', {
      category: 'process',
      collection: { template: 'builtin:work-unit', pattern: 'WU-{{n:3}}: ' },
      guidance: ['One page per buildable unit of work, numbered.', 'По странице на единицу работы, с номером.'],
    }),
    page('L7 Code', 'L7 Код', {
      guidance: ['Where the code lives: link the repository and its entry points.', 'Где живёт код: ссылка на репозиторий и его точки входа.'],
    }),
    page('Glossary', 'Глоссарий', {
      category: 'reference',
      guidance: ['The terms every level uses, one meaning each.', 'Термины, которыми пользуются все уровни, — у каждого одно значение.'],
    }),
  ],
  conventions: {
    styleguide: {
      description: 'How pages are written at each level of Knowledge-Driven Construction.',
      rules: [
        { id: 'one-invariant-per-rule', text: 'A rule page states exactly one invariant.', severity: 'warning', enabled: true },
        {
          id: 'glossary-terms',
          text: "Name a concept by its glossary term, never by a synonym.",
          severity: 'warning',
          enabled: true,
          example: { bad: 'The client places a purchase.', good: 'The customer places an order.' },
        },
        { id: 'measurable-goals', text: 'Every goal on an intent page has a measure and a target value.', severity: 'warning', enabled: true },
        { id: 'no-solution-in-intent', text: 'An intent page says what must be true, never how it is built.', severity: 'suggestion', enabled: true },
        { id: 'link-the-level-above', text: 'A page below L0 links the page at the level above that it refines.', severity: 'suggestion', enabled: true },
      ],
    },
    glossary: [
      { term: 'Level', definition: 'One stage of refinement, from L0 Intent to L7 Code. A page sits at the level of the template it was made from.', aliases: ['уровень'] },
      { term: 'Invariant', definition: 'A statement about the domain that is always true. A rule page holds exactly one.', aliases: ['инвариант'] },
      { term: 'Quality scenario', definition: 'A measurable quality requirement: stimulus, response, measure and threshold.', aliases: ['сценарий качества'] },
      { term: 'Contract', definition: 'The exact interface between two components: operations, fields, types and errors.', aliases: ['контракт'] },
      { term: 'Unit of work', definition: 'A buildable piece small enough to finish in one go, ending in acceptance checks.', aliases: ['единица работы'] },
    ],
  },
  levels: LEVELS,
  agents: AGENTS,
  workflows: [
    {
      name: 'Draft rules from an entity',
      description: 'Lists the business rules an entity page implies, drafts one rule page per approved item, then waits for a final review.',
      graph: {
        steps: [
          {
            id: 'find-rules',
            kind: 'ai.generate',
            title: 'Find the rules',
            next: ['write-rule'],
            fanOut: true,
            autoApprove: false,
            maxItems: 10,
            prompt: {
              user:
                'List the business rules this entity page states or implies: one invariant each, as a short title and a one-sentence summary. ' +
                'Leave out rules that already have a page.',
            },
            tools: ['search_knowledge', 'read_document'],
          },
          {
            id: 'write-rule',
            kind: 'ai.draft',
            title: 'Write the rule page',
            next: ['review'],
            fanOut: false,
            autoApprove: false,
            prompt: { user: 'Write the rule page for this invariant, with Given/When/Then examples and the glossary terms.' },
            tools: ['search_knowledge', 'read_document'],
            produces: { category: 'reference', relationToParent: 'DESCRIBES', templateRef: 'builtin:rule' },
          },
          { id: 'review', kind: 'review', title: 'Review the rules', next: [], fanOut: false, autoApprove: false },
        ],
      },
      trigger: { manual: true, autoStart: false, events: [], categories: ['erd'] },
    },
  ],
};
