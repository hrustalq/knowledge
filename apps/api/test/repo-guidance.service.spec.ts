import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { AiSkill, Connector } from '@prisma/client';
import { AI_SKILL_INSTRUCTIONS_MAX, GUIDANCE_FILE_MAX_BYTES, GUIDANCE_MAX_FILES, guidancePaths } from '@knowledge/contracts';
import {
  clipInstructions,
  guidanceSkillName,
  planGuidanceImport,
  readGuidanceFiles,
  type ImportedSkill,
} from '../src/connectors/guidance/repo-guidance.js';

const archive = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), subdir: '' }));
vi.mock('../src/connectors/adapters/repo-archive.js', () => ({
  downloadRepoArchive: vi.fn(async () => ({ files: archive.files, skipped: { oversize: 0, binary: 0 }, branch: 'main', headSha: null })),
  repoSubdir: vi.fn(() => archive.subdir),
}));

const { RepoGuidanceService } = await import('../src/connectors/guidance/repo-guidance.service.js');
const { AiSkillsService } = await import('../src/ai/ai-skills.service.js');
const { RepoGuidanceListener } = await import('../src/connectors/guidance/repo-guidance.listener.js');

/**
 * Repo guidance import (#70, phase 6). The planner is pure and tested on its
 * own; the service runs over an in-memory prisma with the archive download
 * mocked, so the defaults it writes (disabled, `source: 'repo'`, provenance)
 * are the ones asserted rather than a copy of them.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const CONNECTOR = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';

const bytes = (text: string) => new TextEncoder().encode(text);
const files = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([k, v]) => [k, bytes(v)]));

describe('guidancePaths', () => {
  it('takes the allowlisted files at the root and at the subdir root only', () => {
    const paths = [
      'AGENTS.md',
      'CLAUDE.md',
      '.cursorrules',
      '.github/copilot-instructions.md',
      '.cursor/rules/style.mdc',
      '.cursor/rules/nested/deep.mdc',
      '.cursor/rules/readme.md',
      'docs/AGENTS.md',
      'src/CLAUDE.md',
      'README.md',
    ];
    expect(guidancePaths(paths, '')).toEqual([
      '.cursor/rules/style.mdc',
      '.cursorrules',
      '.github/copilot-instructions.md',
      'AGENTS.md',
      'CLAUDE.md',
    ]);
    expect(guidancePaths(paths, '/docs/')).toContain('docs/AGENTS.md');
    expect(guidancePaths(paths, 'docs')).not.toContain('src/CLAUDE.md');
  });
});

describe('readGuidanceFiles', () => {
  it('skips oversize and empty files but still counts them as present', () => {
    const read = readGuidanceFiles(
      new Map([
        ['AGENTS.md', bytes('﻿rules\r\n')],
        ['CLAUDE.md', new Uint8Array(GUIDANCE_FILE_MAX_BYTES + 1).fill(65)],
        ['.cursorrules', bytes('   \n')],
      ]),
      '',
    );
    expect(read.files.map((f) => [f.path, f.text])).toEqual([['AGENTS.md', 'rules']]);
    expect(read.skipped).toEqual([
      { path: '.cursorrules', reason: 'empty' },
      { path: 'CLAUDE.md', reason: 'oversize' },
    ]);
    expect([...read.present].sort()).toEqual(['.cursorrules', 'AGENTS.md', 'CLAUDE.md']);
  });

  it('reads at most GUIDANCE_MAX_FILES files', () => {
    const many = new Map(Array.from({ length: GUIDANCE_MAX_FILES + 3 }, (_, i) => [`.cursor/rules/r${String(i).padStart(2, '0')}.mdc`, bytes(`rule ${i}`)]));
    const read = readGuidanceFiles(many, '');
    expect(read.files).toHaveLength(GUIDANCE_MAX_FILES);
    expect(read.skipped.filter((s) => s.reason === 'limit')).toHaveLength(3);
    expect(read.present.size).toBe(GUIDANCE_MAX_FILES + 3);
  });
});

describe('clipInstructions', () => {
  it('keeps a file that fits and cuts a long one at a line break within the budget', () => {
    expect(clipInstructions('short')).toEqual({ instructions: 'short', truncated: false });
    const line = 'x'.repeat(99) + '\n';
    const clipped = clipInstructions(line.repeat(200));
    expect(clipped.truncated).toBe(true);
    expect(clipped.instructions.length).toBeLessThanOrEqual(AI_SKILL_INSTRUCTIONS_MAX);
    expect(clipped.instructions.endsWith('x')).toBe(true);
  });
});

describe('guidanceSkillName', () => {
  it('suffixes a name another skill already holds', () => {
    expect(guidanceSkillName('repo', 'AGENTS.md', new Set())).toBe('repo/AGENTS.md');
    expect(guidanceSkillName('repo', 'AGENTS.md', new Set(['repo/AGENTS.md', 'repo/AGENTS.md (2)']))).toBe('repo/AGENTS.md (3)');
  });
});

describe('planGuidanceImport', () => {
  const skill = (over: Partial<ImportedSkill>): ImportedSkill => ({
    id: 'skill-1',
    sourcePath: 'AGENTS.md',
    sourceSha: 'old',
    enabled: false,
    instructions: 'old text',
    pendingInstructions: null,
    sourceRemovedAt: null,
    ...over,
  });
  const read = (entries: Record<string, string>) => readGuidanceFiles(files(entries), '');

  it('creates a skill for a new file and leaves an unchanged one alone', () => {
    const first = read({ 'AGENTS.md': 'a' });
    expect(planGuidanceImport([], first).map((op) => op.kind)).toEqual(['create']);
    const sha = first.files[0].sha;
    expect(planGuidanceImport([skill({ sourceSha: sha })], first)).toEqual([]);
  });

  it('replaces a disabled skill and only proposes for an enabled one', () => {
    const next = read({ 'AGENTS.md': 'new text' });
    expect(planGuidanceImport([skill({ enabled: false })], next)).toMatchObject([{ kind: 'replace', instructions: 'new text' }]);
    expect(planGuidanceImport([skill({ enabled: true })], next)).toMatchObject([{ kind: 'pending', instructions: 'new text' }]);
  });

  it('settles an enabled skill whose live text already matches upstream', () => {
    const next = read({ 'AGENTS.md': 'old text' });
    expect(planGuidanceImport([skill({ enabled: true, pendingInstructions: 'x' })], next)).toMatchObject([{ kind: 'settle' }]);
  });

  it('removes a skill whose file is gone, once, and restores it when the same file returns', () => {
    const empty = read({ 'README.md': 'not guidance' });
    expect(planGuidanceImport([skill({})], empty)).toEqual([{ kind: 'remove', id: 'skill-1' }]);
    expect(planGuidanceImport([skill({ sourceRemovedAt: new Date() })], empty)).toEqual([]);

    const back = read({ 'AGENTS.md': 'old text' });
    const sha = back.files[0].sha;
    expect(planGuidanceImport([skill({ sourceSha: sha, sourceRemovedAt: new Date() })], back)).toEqual([{ kind: 'restore', id: 'skill-1' }]);
  });

  it('does not remove a skill whose file is still there but skipped', () => {
    const oversize = readGuidanceFiles(new Map([['AGENTS.md', new Uint8Array(GUIDANCE_FILE_MAX_BYTES + 1).fill(65)]]), '');
    expect(planGuidanceImport([skill({})], oversize)).toEqual([]);
  });
});

describe('RepoGuidanceService', () => {
  let skills: AiSkill[];
  let seq: number;
  let connector: Connector;
  let activity: { record: ReturnType<typeof vi.fn> };

  function harness() {
    const prisma = {
      aiSkill: {
        findMany: vi.fn(async ({ where }: { where: { workspaceId: string; source?: string; sourceConnectorId?: string } }) =>
          skills.filter(
            (s) =>
              s.workspaceId === where.workspaceId &&
              (where.source === undefined || s.source === where.source) &&
              (where.sourceConnectorId === undefined || s.sourceConnectorId === where.sourceConnectorId),
          ),
        ),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => skills.find((s) => s.id === where.id) ?? null),
        create: vi.fn(async ({ data }: { data: Partial<AiSkill> }) => {
          const row = {
            id: `skill-${++seq}`,
            description: '',
            createdAt: new Date(),
            updatedAt: new Date(),
            pendingInstructions: null,
            sourceRemovedAt: null,
            ...data,
          } as AiSkill;
          skills.push(row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<AiSkill> }) => {
          const row = skills.find((s) => s.id === where.id)!;
          Object.assign(row, data);
          return row;
        }),
        updateMany: vi.fn(async ({ where, data }: { where: { id: string; pendingInstructions: string }; data: Partial<AiSkill> }) => {
          const row = skills.find((s) => s.id === where.id && s.pendingInstructions === where.pendingInstructions);
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
      connector: { findMany: vi.fn(async () => [{ id: CONNECTOR, name: connector.name }]) },
      user: { findUnique: vi.fn(async () => ({ locale: 'en' })) },
    };
    const connectors = {
      require: vi.fn(async () => connector),
      contextFor: vi.fn(async () => ({ config: {} })),
    };
    const aiSkills = new AiSkillsService(prisma as never);
    const service = new RepoGuidanceService(prisma as never, connectors as never, aiSkills, activity as never);
    return { service, aiSkills, prisma };
  }

  beforeEach(() => {
    skills = [];
    seq = 0;
    archive.files = files({ 'AGENTS.md': 'agents v1', 'CLAUDE.md': 'claude v1', '.cursorrules': 'cursor v1', 'README.md': 'readme' });
    archive.subdir = '';
    connector = { id: CONNECTOR, workspaceId: WS, kind: 'codebase', name: 'acme', createdBy: OWNER } as Connector;
    activity = { record: vi.fn(async () => undefined) };
  });

  it('imports AGENTS.md, CLAUDE.md and .cursorrules as three disabled repo skills with provenance', async () => {
    const { service } = harness();
    const result = await service.importFrom(CONNECTOR);
    expect(result).toMatchObject({ found: 3, created: 3, updated: 0, pending: 0, removed: 0, unchanged: 0 });
    expect(skills.map((s) => s.sourcePath).sort()).toEqual(['.cursorrules', 'AGENTS.md', 'CLAUDE.md']);
    for (const s of skills) {
      expect(s).toMatchObject({ source: 'repo', enabled: false, sourceConnectorId: CONNECTOR, createdBy: OWNER, triggers: [] });
      expect(s.sourceSha).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(skills.find((s) => s.sourcePath === 'AGENTS.md')?.name).toBe('acme/AGENTS.md');
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'ai.skill.imported', actor: 'system' }));
  });

  it('is idempotent: a second import changes nothing and records nothing', async () => {
    const { service } = harness();
    await service.importFrom(CONNECTOR);
    activity.record.mockClear();
    const again = await service.importFrom(CONNECTOR);
    expect(again).toMatchObject({ created: 0, updated: 0, pending: 0, removed: 0, unchanged: 3 });
    expect(skills).toHaveLength(3);
    expect(activity.record).not.toHaveBeenCalled();
  });

  it('fills pending_instructions of an enabled skill and leaves its instructions until Accept', async () => {
    const { service, aiSkills } = harness();
    await service.importFrom(CONNECTOR);
    const agents = skills.find((s) => s.sourcePath === 'AGENTS.md')!;
    agents.enabled = true;

    archive.files = files({ 'AGENTS.md': 'agents v2', 'CLAUDE.md': 'claude v2', '.cursorrules': 'cursor v1' });
    const result = await service.importFrom(CONNECTOR);
    expect(result).toMatchObject({ pending: 1, updated: 1, unchanged: 1 });
    expect(agents).toMatchObject({ instructions: 'agents v1', pendingInstructions: 'agents v2', enabled: true });
    // The disabled one simply follows upstream.
    expect(skills.find((s) => s.sourcePath === 'CLAUDE.md')).toMatchObject({ instructions: 'claude v2', pendingInstructions: null });

    const accepted = await aiSkills.acceptUpstream(agents.id);
    expect(accepted).toMatchObject({ instructions: 'agents v2', pendingInstructions: null, source: 'repo', sourceConnectorName: 'acme' });
    await expect(aiSkills.acceptUpstream(agents.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('disables a skill whose file was deleted upstream', async () => {
    const { service } = harness();
    await service.importFrom(CONNECTOR);
    const cursor = skills.find((s) => s.sourcePath === '.cursorrules')!;
    cursor.enabled = true;

    archive.files = files({ 'AGENTS.md': 'agents v1', 'CLAUDE.md': 'claude v1' });
    const result = await service.importFrom(CONNECTOR);
    expect(result.removed).toBe(1);
    expect(cursor.enabled).toBe(false);
    expect(cursor.sourceRemovedAt).toBeInstanceOf(Date);
  });

  it('cuts a long file to the skill budget and reports it', async () => {
    const { service } = harness();
    archive.files = files({ 'CLAUDE.md': ('rule '.repeat(30) + '\n').repeat(100) });
    const result = await service.importFrom(CONNECTOR);
    expect(result.truncated).toEqual(['CLAUDE.md']);
    expect(skills[0].instructions.length).toBeLessThanOrEqual(AI_SKILL_INSTRUCTIONS_MAX);
  });

  it('refuses a connector that is not a repository, before any download', async () => {
    const { service } = harness();
    connector = { ...connector, kind: 'confluence' };
    await expect(service.importFrom(CONNECTOR)).rejects.toBeInstanceOf(BadRequestException);
    expect(skills).toHaveLength(0);
  });

  it('attributes a manual import to the caller and suffixes a name a manual skill holds', async () => {
    const { service } = harness();
    skills.push({ id: 'manual', workspaceId: WS, name: 'acme/AGENTS.md', source: 'manual', sourceConnectorId: null } as AiSkill);
    await service.importFrom(CONNECTOR, 'caller');
    const imported = skills.find((s) => s.sourcePath === 'AGENTS.md')!;
    expect(imported).toMatchObject({ name: 'acme/AGENTS.md (2)', createdBy: 'caller' });
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ actor: 'caller' }));
  });

  it('shares one import between concurrent callers', async () => {
    const { service, prisma } = harness();
    const [a, b] = await Promise.all([service.importFrom(CONNECTOR), service.importFrom(CONNECTOR)]);
    expect(a).toBe(b);
    expect(prisma.aiSkill.create).toHaveBeenCalledTimes(3);
  });
});

describe('RepoGuidanceListener', () => {
  function listener(kind: string) {
    const prisma = { connector: { findUnique: vi.fn(async () => ({ kind, enabled: true, workspaceId: WS })) } };
    const guidance = {
      isRepository: (row: { kind: string }) => row.kind === 'codebase' || row.kind === 'markdown-git',
      importFrom: vi.fn(async () => undefined),
    };
    const config = { get: () => true };
    return { l: new RepoGuidanceListener({ all: vi.fn() } as never, prisma as never, guidance as never, config as never), guidance, prisma };
  }

  it('imports after a repository sync succeeds', async () => {
    const { l, guidance } = listener('markdown-git');
    await l.handle({ workspaceId: WS, type: 'connector.run.succeeded', subjectId: CONNECTOR } as never);
    expect(guidance.importFrom).toHaveBeenCalledWith(CONNECTOR);
  });

  it('ignores a non-repository connector and every other event', async () => {
    const { l, guidance, prisma } = listener('confluence');
    await l.handle({ workspaceId: WS, type: 'connector.run.succeeded', subjectId: CONNECTOR } as never);
    await l.handle({ workspaceId: WS, type: 'connector.run.failed', subjectId: CONNECTOR } as never);
    expect(guidance.importFrom).not.toHaveBeenCalled();
    expect(prisma.connector.findUnique).toHaveBeenCalledTimes(1);
  });
});
