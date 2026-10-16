import type { BuiltInTemplate } from './types.js';

/**
 * A page about a piece of code (#236). The `component:` block is what ties the
 * page to the code: ingestion resolves it to a codebase connector, the import
 * index says who uses those files, and the pages documenting the users gain a
 * derived `DEPENDS_ON` edge to `component:{{name}}`.
 */
export const COMPONENT_TEMPLATE: BuiltInTemplate = {
  key: 'component',
  version: 1,
  icon: '🧱',
  text: {
    en: {
      name: 'Component',
      description: 'A piece of code — a UI component, a module or a logical component — and where it is used.',
      source: `---
tags: [component]
component:
  repository: "{{repository}}"
  paths: ["{{path}}"]
relations:
  - type: DESCRIBES
    target: "component:{{name}}"
template:
  category: reference
  placeholders:
    - { name: name, label: Component name, kind: text, required: true, hint: "ResponsivePopover" }
    - { name: path, label: Source path, kind: text, required: true, hint: "apps/web/src/components/ResponsivePopover.vue" }
    - { name: repository, label: Repository, kind: text, hint: "owner/repo — leave empty when the workspace has one code connector" }
  aiInstructions: >-
    Describe the component from its source only. Under Public surface, list what
    it exports or accepts (props, parameters, events) exactly as declared. State
    an invariant only if the code enforces it. To cover more files, add them to
    component.paths in the frontmatter; to narrow usages to some exports, add
    component.symbols.
---
# {{title}}

**Source:** \`{{path}}\`

## Purpose

What this component is for, and when to reach for it, in one or two sentences.

## Public surface

| Name | Kind | Description |
| --- | --- | --- |
| | prop / parameter / event / export | |

## Behaviour & invariants

- What always holds, whatever the caller passes.

## Usage notes

- Pitfalls, and what to use instead when this is the wrong tool.
`,
    },
    ru: {
      name: 'Компонент',
      description: 'Фрагмент кода — UI-компонент, модуль или логический компонент — и где он используется.',
      source: `---
tags: [component]
component:
  repository: "{{repository}}"
  paths: ["{{path}}"]
relations:
  - type: DESCRIBES
    target: "component:{{name}}"
template:
  category: reference
  placeholders:
    - { name: name, label: Имя компонента, kind: text, required: true, hint: "ResponsivePopover" }
    - { name: path, label: Путь к исходнику, kind: text, required: true, hint: "apps/web/src/components/ResponsivePopover.vue" }
    - { name: repository, label: Репозиторий, kind: text, hint: "owner/repo — оставьте пустым, если в пространстве один коннектор кода" }
  aiInstructions: >-
    Описывай компонент только по его исходному коду. В разделе «Публичный
    интерфейс» перечисли, что он экспортирует или принимает (props, параметры,
    события), ровно так, как это объявлено. Инвариант указывай, только если его
    обеспечивает код. Чтобы охватить больше файлов, добавь их в component.paths
    во frontmatter; чтобы сузить использования до части экспортов — добавь
    component.symbols.
---
# {{title}}

**Исходник:** \`{{path}}\`

## Назначение

Для чего нужен компонент и когда к нему обращаться, одним-двумя предложениями.

## Публичный интерфейс

| Имя | Вид | Описание |
| --- | --- | --- |
| | prop / параметр / событие / экспорт | |

## Поведение и инварианты

- Что верно всегда, что бы ни передал вызывающий код.

## Заметки об использовании

- Подводные камни и что использовать вместо, если этот компонент не подходит.
`,
    },
  },
};
