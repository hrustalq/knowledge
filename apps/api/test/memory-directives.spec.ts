import { describe, expect, it } from 'vitest';
import { DIRECTIVE_CHAR_BUDGET, MemoryDirectivesService, directiveMatches, withinDirectiveBudget } from '../src/memory/memory-directives.service.js';

describe('scoped reflect directives (#1159)', () => {
  it('always applies global directives and matches tagged ones like recall', () => {
    expect(directiveMatches([], undefined)).toBe(true);
    expect(directiveMatches([], [], 'exact')).toBe(true);
    expect(directiveMatches(['user:a'], undefined)).toBe(false);
    expect(directiveMatches(['user:a'], ['user:a', 'team:x'])).toBe(true);
    expect(directiveMatches(['team:x', 'user:a'], ['user:a', 'team:x'], 'all_strict')).toBe(true);
    expect(directiveMatches(['team:x', 'user:a'], ['user:a', 'team:x'], 'exact')).toBe(true);
    expect(directiveMatches(['user:a'], ['user:a', 'team:x'], 'exact')).toBe(false);
    expect(directiveMatches([' user:a ', 'user:a'], ['user:a'])).toBe(true);
  });

  it("pins 'all' as the reference server filters directives: the directive carries every requested tag (#1166)", () => {
    // Hindsight's `list_directives` applies the request's tag filter to the directive's tags as recall
    // does to a memory's (`directive.tags @> request` for `all`), and isolation mode leaves a tagged
    // directive out of an untagged reflect.
    expect(directiveMatches(['user:a', 'team:x'], ['user:a'], 'all')).toBe(true);
    expect(directiveMatches(['user:a'], ['user:a', 'team:x'], 'all')).toBe(false);
    expect(directiveMatches(['user:a'], ['user:a', 'team:x'], 'all_strict')).toBe(false);
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
