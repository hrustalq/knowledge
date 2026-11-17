import { describe, expect, it, vi } from 'vitest';
import { BUILT_IN_TEMPLATE_KEYS, isMethodology, levelOf, ownedAgentKey, parseTemplateRef } from '@knowledge/contracts';
import { BUILT_IN_BLUEPRINTS } from '../src/blueprints/built-in/index.js';
import { BUILT_IN_TEMPLATES } from '../src/templates/built-in/index.js';
import { parseBlueprint } from '../src/blueprints/blueprint.schema.js';
import { MethodologyMaterializerService } from '../src/blueprints/methodology-materializer.service.js';
import { projectLevels } from '../src/projects/methodology-scope.js';

/**
 * The two built-in methodologies (#1129). What is pinned:
 * 1. Both parse, every level names templates that exist, every level's agent is declared.
 * 2. A project linked to a built-in (an override row with no version of its own) reads the code's levels.
 * 3. Linking writes the methodology's agents, keyed apart from the workspace's.
 * 4. The four new templates have every listed section in both languages.
 */

const BP = 'c0c1c2c3-0000-4000-8000-000000000000';

describe('built-in methodologies', () => {
  const kdc = BUILT_IN_BLUEPRINTS.construction;
  const discovery = BUILT_IN_BLUEPRINTS.discovery;

  it('parse, and name only templates and agents that exist', () => {
    for (const b of [kdc, discovery]) {
      expect(isMethodology(b)).toBe(true);
      expect(parseBlueprint(b)).toEqual(b);
      const agents = new Set(b.agents?.map((a) => a.key));
      for (const level of b.levels ?? []) {
        for (const ref of level.templateRefs) {
          const parsed = parseTemplateRef(ref);
          expect(parsed?.kind === 'builtin' && (BUILT_IN_TEMPLATE_KEYS as readonly string[]).includes(parsed.key), ref).toBe(true);
        }
        if (level.agentKey) expect(agents.has(level.agentKey), level.agentKey).toBe(true);
      }
    }
  });

  it('runs L0 Intent to L7 Code, each template at one level only', () => {
    expect(kdc.levels!.map((l) => l.name.en)).toEqual([
      'L0 Intent',
      'L1 Ontology',
      'L2 Rules',
      'L3 Behavior',
      'L4 Architecture',
      'L5 Contracts',
      'L6 Units',
      'L7 Code',
    ]);
    const refs = kdc.levels!.flatMap((l) => l.templateRefs);
    expect(new Set(refs).size).toBe(refs.length);
    expect(levelOf('builtin:quality-scenario', kdc.levels)?.key).toBe('behavior');
    expect(levelOf('builtin:work-unit', kdc.levels)?.key).toBe('units');
    expect(kdc.agents!.map((a) => [a.key, a.minTier])).toEqual([
      ['modeller', 'large'],
      ['system-designer', 'large'],
      ['contract-writer', 'medium'],
      ['unit-writer', 'small'],
    ]);
  });

  it('puts research questions at the question level and leaves the Discovery tree as it was', () => {
    expect(discovery.levels!.map((l) => l.key)).toEqual(['question', 'options', 'findings', 'decision']);
    expect(levelOf('builtin:research-question', discovery.levels)?.key).toBe('question');
    expect(discovery.tree.map((n) => n.title.en)).toEqual([
      '00 — Decision summary',
      '01 — Goals and MVP scope',
      '02 — Architecture',
      '03 — Risks and threat model',
      '04 — Economics',
      '05 — Pilot',
    ]);
  });

  it('gives a project linked to a built-in the code’s levels', async () => {
    const prisma = {
      project: { findMany: async () => [{ id: 'p-1', blueprintId: BP }] },
      projectBlueprint: { findMany: async () => [{ id: BP, builtInKey: 'construction', versions: [] }] },
    };
    const levels = (await projectLevels(prisma as never, ['p-1'])).get('p-1');
    expect(levels?.map((l) => l.key)).toEqual(['intent', 'ontology', 'rules', 'behavior', 'architecture', 'contracts', 'units', 'code']);
  });

  it('writes the methodology’s agents on link, keyed apart from the workspace’s', async () => {
    const created: Array<{ key: string; blueprintId: string; minTier: string | null }> = [];
    const prisma = {
      withTransaction: async <T>(fn: () => Promise<T>) => fn(),
      onCommit: (fn: () => Promise<unknown>) => void fn(),
      pageTemplate: { findMany: async () => [] },
      workflowDefinition: { findMany: async () => [] },
      aiSkill: { findFirst: async () => null },
      glossaryTerm: { findMany: async () => [] },
      aiAgent: { findMany: async () => [], create: vi.fn(async ({ data }: { data: (typeof created)[number] }) => created.push(data)) },
    };
    const service = new MethodologyMaterializerService(prisma as never, {} as never, {} as never, {} as never, { invalidate: vi.fn() } as never);
    // Agents only: the conventions and workflow writers have their own specs.
    await service.materialize('ws', BP, { name: discovery.name, tree: [], agents: discovery.agents });
    expect(created).toEqual([expect.objectContaining({ key: ownedAgentKey('investigator', BP), blueprintId: BP, minTier: 'medium' })]);
  });
});

describe('the construction templates', () => {
  const sections: Record<string, { en: string[]; ru: string[] }> = {
    intent: { en: ['Problem', 'Goals', 'Scope', 'Constraints'], ru: ['Проблема', 'Цели', 'Границы', 'Ограничения'] },
    rule: { en: ['Statement', 'Examples'], ru: ['Формулировка', 'Примеры'] },
    'quality-scenario': { en: ['Stimulus', 'Response', 'Measure'], ru: ['Стимул', 'Реакция', 'Метрика'] },
    'work-unit': {
      en: ['Objective', 'Invariants', 'Contracts', 'Acceptance checks', 'Obligations', 'Out of scope'],
      ru: ['Цель', 'Инварианты', 'Контракты', 'Проверки приёмки', 'Обязательства', 'Вне рамок'],
    },
  };

  it('render every listed section in both languages', () => {
    for (const [key, want] of Object.entries(sections)) {
      const template = BUILT_IN_TEMPLATES[key as keyof typeof BUILT_IN_TEMPLATES];
      for (const locale of ['en', 'ru'] as const) {
        const body = template.text[locale].source.split(/^---$/m).at(-1)!;
        for (const heading of want[locale]) expect(body, `${key}/${locale}`).toContain(`## ${heading}\n`);
      }
    }
  });
});
