import { describe, expect, it } from 'vitest';
import { DIRECTIVE_CHAR_BUDGET, MemoryDirectivesService, directiveMatches, withinDirectiveBudget } from '../src/memory/memory-directives.service.js';

describe('scoped reflect directives (#1159)', () => {
  it('always applies global directives and matches tagged ones like recall', () => {
    expect(directiveMatches([], undefined)).toBe(true);
    expect(directiveMatches([], [], 'exact')).toBe(true);
    expect(directiveMatches(['user:a'], undefined)).toBe(false);
    expect(directiveMatches(['user:a'], ['user:a', 'team:x'])).toBe(true);
    expect(directiveMatches(['user:a', 'team:x'], ['user:a'], 'all')).toBe(false);
    expect(
      directiveMatches(['team:x', 'user:a'], ['user:a', 'team:x'], 'all_strict'),
    ).toBe(true);
    expect(
      directiveMatches(['team:x', 'user:a'], ['user:a', 'team:x'], 'exact'),
    ).toBe(true);
    expect(directiveMatches(['user:a'], ['user:a', 'team:x'], 'exact')).toBe(
      false,
    );
    expect(directiveMatches([' user:a ', 'user:a'], ['user:a'])).toBe(true);
  });

  it("pins 'all' to the request holding every directive tag, and an untagged request to global directives only", () => {
    // The reference documents directives as "scoped like memories" but its directive loader was not
    // verified; this server keeps: a directive applies when the request carries all of its tags.
    expect(directiveMatches(['user:a'], ['user:a', 'team:x'], 'all')).toBe(true);
    expect(directiveMatches(['user:a', 'team:x'], ['user:a'], 'all_strict')).toBe(false);
    expect(directiveMatches(['user:a'], [], 'all')).toBe(false);
    expect(directiveMatches(['user:a'], [], 'any')).toBe(false);
  });

  it('applies the highest-priority directives that fit the character budget', async () => {
    const big = (name: string, priority: number) => ({ id: name, name, content: 'x'.repeat(10_000), priority, tags: [], isActive: true });
    const rows = [big('a', 3), big('b', 2), big('c', 1), { ...big('d', 0), content: 'short' }];
    expect(withinDirectiveBudget(rows).map((row) => row.name)).toEqual(['a', 'b']);
    const prisma = { memoryDirective: { findMany: async () => rows } };
    const applied = await new MemoryDirectivesService(prisma as never).forReflect({ id: 'b1', workspaceId: 'w1' } as never, { applyAllDirectives: true });
    expect(applied.map((row) => row.name)).toEqual(['a', 'b']);
    expect(applied.reduce((n, row) => n + row.name.length + row.content.length, 0)).toBeLessThanOrEqual(DIRECTIVE_CHAR_BUDGET);
    expect(withinDirectiveBudget([{ name: 'n', content: 'y'.repeat(20_000) }])).toHaveLength(1);
  });
});
